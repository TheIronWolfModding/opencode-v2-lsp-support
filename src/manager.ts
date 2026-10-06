import { access, open, readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { BUILTIN_ROOTS, languageIdForExtension } from "./catalog.ts"
import { LspClient, LspError, errorMessage, type Diagnostic } from "./client.ts"
import type { ServerConfig, Settings } from "./config.ts"

// After the first fresh push, a server that stays quiet this long is done publishing for now.
const SETTLE_MS = 300
// Servers answer pull requests quickly or not at all.
const PULL_TIMEOUT_MS = 3_000
const PULL_ATTEMPTS = 3
// Cold servers often answer navigation requests with nothing until their first analysis finishes.
const WARMUP_TIMEOUT_MS = 6_000
// Codes for "still loading" and "cancelled because the document changed".
const TRANSIENT_CODES = new Set([-32800, -32801, -32802])

interface Target {
  /** One client per server and root, as OpenCode 1 ran them. */
  readonly key: string
  readonly server: ServerConfig
  readonly root: string
}

interface Entry {
  client?: LspClient
  starting?: Promise<LspClient>
  broken?: string
  warmed?: boolean
  readonly opened: Set<string>
}

interface Synced {
  readonly client: LspClient
  readonly version: number
  /** When this version reached the client; earlier reports describe older contents. */
  readonly sentAt: number
}

interface Published {
  readonly diagnostics: Diagnostic[]
  readonly at: number
  readonly version?: number
}

export interface FileDiagnostics {
  /** Diagnostics for the requested file, merged across its servers. Undefined when no server reported. */
  readonly file?: Diagnostic[]
  /** Other files whose diagnostics a server published while this file was checked. */
  readonly others: Map<string, Diagnostic[]>
}

/** A file's extension, or `.name` for an extensionless file such as `Dockerfile`. */
export function extensionKey(file: string): string {
  return extname(file).toLowerCase() || `.${basename(file).toLowerCase()}`
}

/** Whether the file, after resolving symlinks, is inside the project. */
export async function insideProject(root: string, file: string): Promise<boolean> {
  if (!within(root, file)) return false
  const real = await realpath(file).catch(() => undefined)
  return real !== undefined && within(await realpath(root).catch(() => root), real)
}

/**
 * Reads a project file, checking the file that was opened rather than the path,
 * so a symlink swapped between the check and the read cannot send outside contents.
 */
async function readInside(root: string, file: string): Promise<string> {
  const outside = new Error(`${file} is outside the project directory ${root}.`)
  if (!within(root, file)) throw outside
  const handle = await open(file, "r")
  try {
    const opened = await handle.stat()
    const real = await realpath(file)
    const current = await stat(real)
    if (!within(await realpath(root).catch(() => root), real)) throw outside
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw outside
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

export function within(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** The directory a server runs in for this file, or undefined when the server does not apply to it. */
export async function serverRoot(id: string, file: string, project: string): Promise<string | undefined> {
  const rule = BUILTIN_ROOTS[id]
  if (!rule) return project
  if (rule.exclude && (await nearest(file, project, rule.exclude))) return undefined
  const found = await nearest(file, project, rule.markers)
  if (!found) return rule.required ? undefined : project
  return id === "rust" ? cargoWorkspace(found, project) : found
}

/** The nearest directory from the file's up to `stop` holding one of `markers`. */
async function nearest(file: string, stop: string, markers: string[]): Promise<string | undefined> {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    for (const marker of markers) {
      if (await access(join(dir, marker)).then(() => true, () => false)) return dir
    }
    if (dir === stop || dir === dirname(dir)) return undefined
  }
}

/** The nearest directory from the crate up to the project whose Cargo.toml declares a workspace, else the crate. */
async function cargoWorkspace(crate: string, project: string): Promise<string> {
  for (let dir = crate; ; dir = dirname(dir)) {
    const manifest = await readFile(join(dir, "Cargo.toml"), "utf8").catch(() => "")
    if (manifest.includes("[workspace]")) return dir
    if (dir === project || dir === dirname(dir)) return crate
  }
}

export class LspManager {
  readonly #settings: Settings
  readonly #root: string
  readonly #entries = new Map<string, Entry>()
  readonly #versions = new Map<string, number>()
  readonly #deleted = new Set<string>()
  readonly #published = new Map<string, Map<string, Published>>()
  readonly #listeners = new Map<string, Set<() => void>>()
  readonly #queues = new Map<string, Promise<void>>()
  #closed = false

  constructor(settings: Settings, root: string) {
    this.#settings = settings
    this.#root = root
  }

  serversFor(file: string): ServerConfig[] {
    const key = extensionKey(file)
    const name = basename(file).toLowerCase()
    return this.#settings.servers.filter((server) =>
      server.extensions.some((extension) => [key, name].includes(extension.toLowerCase())),
    )
  }

  async #targets(file: string): Promise<Target[]> {
    const targets: Target[] = []
    for (const server of this.serversFor(file)) {
      const root = await serverRoot(server.id, file, this.#root)
      if (!root) continue
      const key = root === this.#root ? server.id : `${server.id} (${relative(this.#root, root)})`
      targets.push({ key, server, root })
    }
    return targets
  }

  /** Run one document operation per file at a time, so versions reach servers in order. */
  #serialize<T>(uri: string, run: () => Promise<T>): Promise<T> {
    const result = (this.#queues.get(uri) ?? Promise.resolve()).then(run)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.#queues.set(uri, tail)
    void tail.then(() => {
      if (this.#queues.get(uri) === tail) this.#queues.delete(uri)
    })
    return result
  }

  /** Start any missing servers for the file and send them its current contents. */
  sync(file: string): Promise<Synced[]> {
    const uri = pathToFileURL(file).href
    return this.#serialize(uri, () => this.#sync(file, uri))
  }

  /**
   * Tell servers a deleted file is gone and forget what they reported. Reports that
   * arrive later describe deleted contents and are dropped until the file is synced
   * again. The version counter survives, so a recreated file never reuses a version
   * a late report names.
   */
  close(file: string): Promise<void> {
    const uri = pathToFileURL(file).href
    return this.#serialize(uri, async () => {
      this.#deleted.add(uri)
      for (const [key, entry] of this.#entries) {
        this.#published.get(key)?.delete(uri)
        if (!entry.opened.delete(uri)) continue
        if (entry.client?.running) entry.client.notify("textDocument/didClose", { textDocument: { uri } })
      }
    })
  }

  async #sync(file: string, uri: string): Promise<Synced[]> {
    // OpenCode 1 asked before touching files outside the project; plugins cannot ask, so they are never sent.
    const text = await readInside(this.#root, file)
    const version = (this.#versions.get(uri) ?? 0) + 1
    this.#versions.set(uri, version)
    this.#deleted.delete(uri)
    const synced: Synced[] = []
    for (const target of await this.#targets(file)) {
      const client = await this.#client(target).catch(() => undefined)
      if (!client) continue
      const entry = this.#entries.get(target.key)!
      const sentAt = Date.now()
      if (entry.opened.has(uri)) {
        client.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] })
      } else {
        client.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: languageIdForExtension(extensionKey(file)), version, text },
        })
        entry.opened.add(uri)
      }
      // Edit tools write to disk, and some servers (rust-analyzer, for one) only re-check on save.
      const save = client.capabilities.textDocumentSync?.save
      client.notify("textDocument/didSave", save?.includeText ? { textDocument: { uri }, text } : { textDocument: { uri } })
      synced.push({ client, version, sentAt })
    }
    return synced
  }

  /** Sync the file and wait for its diagnostics. */
  async diagnostics(file: string, timeoutMs = this.#settings.diagnosticsTimeoutMs): Promise<FileDiagnostics> {
    const uri = pathToFileURL(file).href
    const synced = await this.sync(file).catch((error) => {
      this.#log(`${file}: ${errorMessage(error)}`)
      return []
    })
    // Reports from before this file's contents reached the server describe older contents.
    const reports = await Promise.all(synced.map(({ client, version, sentAt }) => this.#collect(client, uri, version, sentAt, timeoutMs)))
    const reported = reports.filter((report): report is Diagnostic[] => report !== undefined)
    const others = new Map<string, Diagnostic[]>()
    for (const { client, sentAt } of synced) {
      for (const [other, published] of this.#published.get(client.id) ?? []) {
        if (other === uri || published.at < sentAt) continue
        others.set(other, [...(others.get(other) ?? []), ...published.diagnostics])
      }
    }
    return { file: reported.length ? reported.flat() : undefined, others }
  }

  async #collect(client: LspClient, uri: string, version: number, since: number, timeoutMs: number): Promise<Diagnostic[] | undefined> {
    if (client.capabilities.diagnosticProvider) {
      try {
        // A pull answers for the contents the server held when the request arrived. Sending it from
        // the file's queue pins that version; if a later sync replaced it meanwhile, ask again.
        for (let attempt = 0; attempt < PULL_ATTEMPTS; attempt++) {
          const { sent, response } = await this.#serialize(uri, async () => ({
            sent: this.#versions.get(uri),
            response: client.request("textDocument/diagnostic", { textDocument: { uri } }, Math.min(timeoutMs, PULL_TIMEOUT_MS)),
          }))
          const report = await response
          if (this.#deleted.has(uri)) return undefined
          if (sent === undefined || this.#versions.get(uri) !== sent) continue
          if (report?.kind === "full" && Array.isArray(report.items)) {
            this.#store(client.id, uri, report.items, sent)
            return report.items
          }
          if (report?.kind === "unchanged") return this.#published.get(client.id)?.get(uri)?.diagnostics
          break
        }
      } catch (error) {
        this.#log(`${client.id}: pull diagnostics failed, waiting for a push: ${errorMessage(error)}`)
      }
    }
    // An older report describes the file before this change, so no report beats a stale one.
    return this.#waitForPush(client.id, uri, version, since, timeoutMs)
  }

  /** Resolve once the server has published for this version and gone quiet, or undefined on timeout. */
  #waitForPush(serverID: string, uri: string, version: number, since: number, timeoutMs: number): Promise<Diagnostic[] | undefined> {
    return new Promise((resolve) => {
      let settle: ReturnType<typeof setTimeout> | undefined
      const current = () => {
        const published = this.#published.get(serverID)?.get(uri)
        if (!published || published.at < since) return undefined
        if (published.version !== undefined && published.version < version) return undefined
        return published
      }
      const finish = () => {
        clearTimeout(timeout)
        if (settle) clearTimeout(settle)
        this.#listeners.get(serverID)?.delete(listener)
        resolve(current()?.diagnostics)
      }
      // Any message from the server restarts the quiet period, so an early empty
      // result from a server that is still indexing is not taken as clean.
      const listener = () => {
        if (!current()) return
        if (settle) clearTimeout(settle)
        settle = setTimeout(finish, SETTLE_MS)
      }
      const timeout = setTimeout(finish, timeoutMs)
      const listeners = this.#listeners.get(serverID) ?? new Set()
      listeners.add(listener)
      this.#listeners.set(serverID, listeners)
      listener()
    })
  }

  /**
   * Run `send` against every server for the file that has the capability, and
   * concatenate their results. Throws when none can answer.
   */
  async request(file: string, capability: string, send: (client: LspClient) => Promise<unknown>): Promise<unknown[]> {
    if (this.serversFor(file).length === 0) throw new Error("No LSP server available for this file type.")
    const targets = await this.#targets(file)
    if (targets.length === 0) throw new Error("No configured LSP server applies to this file's project.")
    const cold = targets.some((target) => !this.#entries.get(target.key)?.warmed)
    if (cold) await this.diagnostics(file, WARMUP_TIMEOUT_MS)
    else await this.sync(file)
    const clients: LspClient[] = []
    for (const target of targets) {
      const entry = this.#entries.get(target.key)
      if (!entry?.client?.running) continue
      entry.warmed = true
      clients.push(entry.client)
    }
    if (clients.length === 0) {
      const reasons = targets.map((target) => `${target.key}: ${this.#entries.get(target.key)?.broken ?? "not running"}`)
      throw new Error(`No LSP server for this file could start. ${reasons.join("; ")}`)
    }
    const capable = clients.filter((client) => client.capabilities[capability])
    if (capable.length === 0) throw new Error(`No LSP server for this file supports ${capability}.`)
    const results = await Promise.all(capable.map(send))
    return results.flatMap((result) => (result === null || result === undefined ? [] : Array.isArray(result) ? result : [result]))
  }

  async #client({ key, server, root }: Target): Promise<LspClient> {
    if (this.#closed) throw new Error("LSP is shut down")
    let entry = this.#entries.get(key)
    if (!entry) {
      entry = { opened: new Set() }
      this.#entries.set(key, entry)
    }
    if (entry.broken) throw new Error(entry.broken)
    if (entry.client?.running) return entry.client
    if (entry.starting) return entry.starting
    const current = entry
    current.opened.clear()
    current.warmed = false
    this.#published.delete(key)
    const client = new LspClient({
      id: key,
      command: server.command,
      root,
      rootUri: pathToFileURL(root).href,
      env: server.env,
      initialization: server.initialization,
      initializeTimeoutMs: this.#settings.initializeTimeoutMs,
      requestTimeoutMs: this.#settings.requestTimeoutMs,
      onDiagnostics: (uri, diagnostics, version) => this.#store(key, uri, diagnostics, version),
      onActivity: () => this.#notify(key),
      onExit: () => {
        if (current.client === client) current.client = undefined
      },
      debug: this.#settings.debug,
    })
    current.starting = client
      .start()
      .then(() => {
        current.client = client
        this.#log(`${key} started`)
        return client
      })
      .catch(async (error) => {
        // A server that cannot start stays off for this instance instead of costing every edit a retry.
        current.broken = errorMessage(error)
        this.#log(current.broken)
        await client.stop()
        throw error
      })
      .finally(() => {
        current.starting = undefined
      })
    return current.starting
  }

  #store(serverID: string, uri: string, diagnostics: Diagnostic[], version: number | undefined): void {
    if (this.#deleted.has(uri)) return
    const published = this.#published.get(serverID) ?? new Map<string, Published>()
    // A late report for an older version describes contents that are gone.
    const latest = this.#versions.get(uri) ?? published.get(uri)?.version
    if (version !== undefined && latest !== undefined && version < latest) return
    published.set(uri, { diagnostics, at: Date.now(), version })
    this.#published.set(serverID, published)
    this.#notify(serverID)
  }

  #notify(serverID: string): void {
    for (const listener of [...(this.#listeners.get(serverID) ?? [])]) listener()
  }

  #log(message: string): void {
    if (this.#settings.debug) console.error(`[lsp] ${message}`)
  }

  async shutdown(): Promise<void> {
    this.#closed = true
    const entries = [...this.#entries.values()]
    this.#entries.clear()
    await Promise.all(
      entries.map(async (entry) => {
        const client = entry.client ?? (await entry.starting?.catch(() => undefined))
        await client?.stop()
      }),
    )
  }
}

/** Send a request, retrying while the server reports it is still loading. */
export async function requestWithRetry(client: LspClient, method: string, params: unknown): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.request(method, params)
    } catch (error) {
      if (attempt >= 5 || !(error instanceof LspError) || !TRANSIENT_CODES.has(error.code ?? 0)) throw error
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
    }
  }
}
