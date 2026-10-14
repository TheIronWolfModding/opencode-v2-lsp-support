import { access, open, readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { abortable } from "./cancellation.ts"
import { BUILTIN_ROOTS, languageIdForExtension } from "./catalog.ts"
import { endPosition, LspClient, LspError, errorMessage, syncKindOf, type Diagnostic } from "./client.ts"
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
  /** OpenCode 1's tsserver hand-off for the typescript and astro servers. */
  readonly initialization?: Record<string, unknown>
}

interface Entry {
  client?: LspClient
  starting?: Promise<LspClient>
  broken?: string
  warmed?: boolean
  /** Open documents with the text the server holds for them, so incremental servers get valid ranges. */
  readonly opened: Map<string, string>
  serverID: string
  root: string
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

/** OpenCode 1's dedupe: the same code/severity/message/source/range reported twice counts once. */
function dedupeDiagnostics(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = JSON.stringify({ code: item.code, severity: item.severity, message: item.message, source: item.source, range: item.range })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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

/**
 * The workspace's tsserver, as OpenCode 1's Module.resolve found it: node's
 * resolution of `typescript/lib/tsserver.js` from the file's directory, node
 * modules and all, up to the filesystem root.
 */
async function resolveTsserver(file: string): Promise<string | undefined> {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", "typescript", "lib", "tsserver.js")
    if (await access(candidate).then(() => true, () => false)) return candidate
    if (dir === dirname(dir)) return undefined
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
  readonly #onServer: ((kind: string, id: string, root: string) => void | Promise<void>) | undefined
  readonly #resolve: ((server: ServerConfig) => Promise<string[]>) | undefined
  #closed = false

  constructor(settings: Settings, root: string, onServer?: (kind: string, id: string, root: string) => void | Promise<void>, resolve?: (server: ServerConfig) => Promise<string[]>) {
    this.#settings = settings
    this.#root = root
    this.#onServer = onServer
    this.#resolve = resolve
  }

  serversFor(file: string): ServerConfig[] {
    const key = extensionKey(file)
    const name = basename(file).toLowerCase()
    return this.#settings.servers.filter(
      // OpenCode 1: a configured server with an empty extension list applies to every file.
      (server) =>
        server.extensions.length === 0 ||
        server.extensions.some((extension) => [key, name].includes(extension.toLowerCase())),
    )
  }

  async #targets(file: string): Promise<Target[]> {
    const targets: Target[] = []
    for (const server of this.serversFor(file)) {
      const root = await serverRoot(server.id, file, this.#root)
      if (!root) continue
      // typescript-language-server 6 carries no tsserver of its own and exits on
      // initialize without one. OpenCode 1 resolved the workspace's copy and
      // passed it as an initialization option, and never started the servers
      // without it; the port does the same.
      let initialization: Record<string, unknown> | undefined
      if (server.id === "typescript" || server.id === "astro") {
        const option = server.id === "typescript" ? "tsserver" : "typescript"
        const own = (server.initialization?.[option] ?? {}) as Record<string, unknown>
        const supplied = typeof own.path === "string" || typeof own.tsdk === "string"
        if (!supplied) {
          const tsserver = await resolveTsserver(file)
          if (!tsserver) continue
          initialization = {
            ...server.initialization,
            [option]: server.id === "typescript" ? { path: tsserver } : { tsdk: dirname(tsserver) },
          }
        }
      }
      const key = root === this.#root ? server.id : `${server.id} (${relative(this.#root, root)})`
      targets.push({ key, server, root, initialization })
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
  async sync(file: string, signal?: AbortSignal): Promise<Synced[]> {
    signal?.throwIfAborted()
    const uri = pathToFileURL(file).href
    return abortable(this.#serialize(uri, () => this.#sync(file, uri, signal)), signal)
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

  async #sync(file: string, uri: string, signal?: AbortSignal): Promise<Synced[]> {
    signal?.throwIfAborted()
    // OpenCode 1 asked before touching files outside the project; plugins cannot ask, so they are never sent.
    const text = await readInside(this.#root, file)
    signal?.throwIfAborted()
    const ready: { target: Target; client: LspClient }[] = []
    for (const target of await this.#targets(file)) {
      signal?.throwIfAborted()
      // Initialization is shared; cancelling one tool must not break another caller's server.
      const client = await abortable(this.#client(target).catch(() => undefined), signal)
      signal?.throwIfAborted()
      if (client) ready.push({ target, client })
    }
    signal?.throwIfAborted()
    if (this.#closed) throw new Error("LSP is shut down")
    if (ready.length === 0) return []
    // Commit the version only after startup finishes, then notify every client without
    // yielding. A cancelled startup must not make their last actual reports stale.
    const version = (this.#versions.get(uri) ?? 0) + 1
    this.#versions.set(uri, version)
    this.#deleted.delete(uri)
    const synced: Synced[] = []
    for (const { target, client } of ready) {
      const entry = this.#entries.get(target.key)!
      const sentAt = Date.now()
      // OpenCode 1 announced the file through the watched-files event first, so workspace
      // watchers (rust-analyzer, for one) also see files they have not opened.
      client.notify("workspace/didChangeWatchedFiles", { changes: [{ uri, type: entry.opened.has(uri) ? 2 : 1 }] })
      if (entry.opened.has(uri)) {
        // A server that only accepts incremental sync gets the same whole-document
        // replacement OpenCode 1 sent: its old text, replaced from the start to its end.
        const changes = syncKindOf(client.capabilities) === 2
          ? [{ range: { start: { line: 0, character: 0 }, end: endPosition(entry.opened.get(uri) ?? "") }, text }]
          : [{ text }]
        client.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: changes })
      } else {
        client.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: languageIdForExtension(extensionKey(file)), version, text },
        })
      }
      entry.opened.set(uri, text)
      // Edit tools write to disk, and some servers (rust-analyzer, for one) only re-check on save.
      const save = client.capabilities.textDocumentSync?.save
      if (save === true || (save && typeof save === "object")) {
        client.notify("textDocument/didSave", save?.includeText ? { textDocument: { uri }, text } : { textDocument: { uri } })
      }
      synced.push({ client, version, sentAt })
    }
    return synced
  }

  /** Sync the file and wait for its diagnostics. */
  async diagnostics(file: string, timeoutMs = this.#settings.diagnosticsTimeoutMs, signal?: AbortSignal): Promise<FileDiagnostics> {
    signal?.throwIfAborted()
    const uri = pathToFileURL(file).href
    const synced = await this.sync(file, signal).catch((error) => {
      signal?.throwIfAborted()
      this.#log(`${file}: ${errorMessage(error)}`)
      return []
    })
    // Reports from before this file's contents reached the server describe older contents.
    const reports = await Promise.all(synced.map(({ client, version, sentAt }) => this.#collect(client, uri, version, sentAt, timeoutMs, signal)))
    signal?.throwIfAborted()
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

  async #collect(client: LspClient, uri: string, version: number, since: number, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    signal?.throwIfAborted()
    // OpenCode 1 pulled from the static `diagnosticProvider` and from dynamically registered
    // providers alike; servers such as eclipse.jdt.ls only answer after a registration.
    const pull = client.documentPullState
    if (pull.supported) {
      try {
        // A pull answers for the contents the server held when the request arrived. Sending it from
        // the file's queue pins that version; if a later sync replaced it meanwhile, ask again.
        for (let attempt = 0; attempt < PULL_ATTEMPTS; attempt++) {
          const { sent, responses } = await abortable(this.#serialize(uri, async () => {
            signal?.throwIfAborted()
            // Base provider plus every registered identifier, in parallel, as OpenCode 1 pulled them.
            const responses = [
              client.request("textDocument/diagnostic", { textDocument: { uri } }, Math.min(timeoutMs, PULL_TIMEOUT_MS), signal),
              ...pull.identifiers.map((identifier) =>
                client.request("textDocument/diagnostic", { identifier, textDocument: { uri } }, Math.min(timeoutMs, PULL_TIMEOUT_MS), signal),
              ),
            ]
            // Cancellation can win before the queue returns these nested promises to their caller.
            for (const response of responses) void response.catch(() => undefined)
            return { sent: this.#versions.get(uri), responses }
          }), signal)
          const reports = await Promise.allSettled(responses)
          // Only reports for the version this attempt sent count; a slower answer after a
          // later sync describes contents that are already gone.
          if (this.#deleted.has(uri)) return undefined
          if (sent === undefined || this.#versions.get(uri) !== sent) continue
          let handled = false
          let unchanged = false
          const items: Diagnostic[] = []
          for (const settled of reports) {
            if (settled.status === "rejected") continue
            const report = settled.value
            if (report?.kind === "unchanged") {
              unchanged = true
              continue
            }
            const reportItems = Array.isArray(report?.items) ? report.items : undefined
            if (reportItems === undefined) continue
            handled = true
            items.push(...reportItems)
            // Related-document reports describe other files; store them per file so the
            // other-files report can show them, as OpenCode 1 merged them.
            for (const [relatedUri, related] of Object.entries((report?.relatedDocuments ?? {}) as Record<string, any>)) {
              if (relatedUri.startsWith("file:") && Array.isArray(related?.items)) this.#store(client.id, relatedUri, related.items, undefined)
            }
          }
          if (handled) {
            const merged = dedupeDiagnostics(items)
            this.#store(client.id, uri, merged, sent)
            return merged
          }
          if (unchanged) return this.#published.get(client.id)?.get(uri)?.diagnostics
          break
        }
      } catch (error) {
        signal?.throwIfAborted()
        this.#log(`${client.id}: pull diagnostics failed, waiting for a push: ${errorMessage(error)}`)
      }
    }
    // An older report describes the file before this change, so no report beats a stale one.
    return this.#waitForPush(client.id, uri, version, since, timeoutMs, signal)
  }

  /** Resolve once the server has published for this version and gone quiet, or undefined on timeout. */
  #waitForPush(serverID: string, uri: string, version: number, since: number, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      let settle: ReturnType<typeof setTimeout> | undefined
      const current = () => {
        const published = this.#published.get(serverID)?.get(uri)
        if (!published || published.at < since) return undefined
        if (published.version !== undefined && published.version < version) return undefined
        return published
      }
      const cleanup = () => {
        clearTimeout(timeout)
        if (settle) clearTimeout(settle)
        this.#listeners.get(serverID)?.delete(listener)
        signal?.removeEventListener("abort", abort)
      }
      const finish = () => {
        cleanup()
        resolve(current()?.diagnostics)
      }
      const abort = () => {
        cleanup()
        reject(signal!.reason)
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
      signal?.addEventListener("abort", abort, { once: true })
      listener()
    })
  }

  /**
   * Run `send` against every server for the file that has the capability, and
   * concatenate their results. Throws when none can answer.
   */
  async request(file: string, capability: string, send: (client: LspClient) => Promise<unknown>, signal?: AbortSignal): Promise<unknown[]> {
    signal?.throwIfAborted()
    if (this.serversFor(file).length === 0) throw new Error("No LSP server available for this file type.")
    const targets = await abortable(this.#targets(file), signal)
    if (targets.length === 0) {
      let typescript: ServerConfig | undefined
      for (const server of this.serversFor(file)) {
        if (server.id !== "typescript" && server.id !== "astro") continue
        if (await serverRoot(server.id, file, this.#root)) {
          typescript = server
          break
        }
      }
      if (typescript && !(await resolveTsserver(file)))
        throw new Error(`No LSP server for this file: ${typescript.id} needs a resolvable typescript/lib/tsserver.js; add the typescript package to the project.`)
      throw new Error("No configured LSP server applies to this file's project.")
    }
    const cold = targets.some((target) => !this.#entries.get(target.key)?.warmed)
    if (cold) await this.diagnostics(file, WARMUP_TIMEOUT_MS, signal)
    else await this.sync(file, signal)
    signal?.throwIfAborted()
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
    // OpenCode 1 caught every server's failure per-client and merged the answers that
    // succeeded, so one misbehaving server must not sink the request when others answer;
    // only when every server fails is the first reason reported.
    const settled = await Promise.allSettled(capable.map(send))
    if (signal?.aborted) throw signal.reason
    const results = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []))
    if (results.length === 0) throw (settled.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason
    return results.flatMap((result) => (result === null || result === undefined ? [] : Array.isArray(result) ? result : [result]))
  }

  async #client(target: Target): Promise<LspClient> {
    const { key, server, root } = target
    if (this.#closed) throw new Error("LSP is shut down")
    let entry = this.#entries.get(key)
    if (!entry) {
      entry = { opened: new Map(), serverID: server.id, root }
      this.#entries.set(key, entry)
    }
    if (entry.broken) throw new Error(entry.broken)
    if (entry.client?.running) return entry.client
    if (entry.starting) return entry.starting
    const current = entry
    current.opened.clear()
    current.warmed = false
    this.#published.delete(key)
    let client: LspClient | undefined
    // The download resolver runs inside the starting chain so a failed fetch
    // marks the row broken, like a failed spawn does.
    current.starting = (async () => {
      const command = this.#resolve ? await this.#resolve(server) : server.command
      client = new LspClient({
        id: key,
        command,
        root,
        rootUri: pathToFileURL(root).href,
        env: server.env,
        initialization: target.initialization ?? server.initialization,
        initializeTimeoutMs: this.#settings.initializeTimeoutMs,
        requestTimeoutMs: this.#settings.requestTimeoutMs,
        onDiagnostics: (uri, diagnostics, version) => this.#store(key, uri, diagnostics, version),
        onActivity: () => this.#notify(key),
        onExit: () => {
          // shutdown() stops live servers on purpose (e.g. a plugin reload); that
          // is a shutdown event, not a crashed server, so #closed keeps it green-free.
          if (this.#closed) return
          if (current.client === client) {
            current.client = undefined
            this.#notifyServer("failed", server.id, root)
          }
        },
        debug: this.#settings.debug,
      })
      await client.start()
      return client
    })()
      .then((started) => {
        current.client = started
        this.#log(`${key} started`)
        this.#notifyServer("connected", server.id, root)
        return started
      })
      .catch(async (error) => {
        // A server that cannot start stays off for this instance instead of costing every edit a retry.
        current.broken = errorMessage(error)
        this.#log(current.broken)
        this.#notifyServer("failed", server.id, root)
        if (client) await client.stop()
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

  /** Tell the plugin's lifecycle listener about a server row; used for the terminal sidebar. */
  async #notifyServer(kind: string, id: string, root: string): Promise<void> {
    try {
      await this.#onServer?.(kind, id, root)
    } catch {
      // Notification is best-effort; a failed listener must not break server management.
    }
  }

  /** Rows for the terminal sidebar: one per server and root that was started or attempted. */
  snapshot(): { id: string; root: string; status: "connected" | "starting" | "broken" }[] {
    return [...this.#entries.values()].map((entry) => ({
      id: entry.serverID,
      root: entry.root,
      status: entry.broken ? "broken" : entry.client?.running ? "connected" : "starting",
    }))
  }

  #log(message: string): void {
    if (this.#settings.debug) console.error(`[lsp] ${message}`)
  }

  async shutdown(): Promise<void> {
    this.#closed = true
    const entries = [...this.#entries.values()]
    this.#entries.clear()
    // Stop every server first, awaiting in-flight startups, so their exit
    // handlers see #closed and stay quiet.
    await Promise.all(
      entries.map(async (entry) => {
        const client = entry.client ?? (await entry.starting?.catch(() => undefined))
        await client?.stop()
      }),
    )
    // Then clear every row the sidebar saw, including rows that never connected.
    await Promise.all(entries.map((entry) => this.#notifyServer("shutdown", entry.serverID, entry.root)))
  }
}

/** Send a request, retrying while the server reports it is still loading. */
export async function requestWithRetry(client: LspClient, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    try {
      return await client.request(method, params, undefined, signal)
    } catch (error) {
      signal?.throwIfAborted()
      if (attempt >= 5 || !(error instanceof LspError) || !TRANSIENT_CODES.has(error.code ?? 0)) throw error
      try {
        await delay(400 * attempt, undefined, { signal })
      } catch (error) {
        signal?.throwIfAborted()
        throw error
      }
    }
  }
}
