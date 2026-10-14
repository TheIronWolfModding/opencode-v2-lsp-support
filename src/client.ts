import { spawn, type ChildProcess } from "node:child_process"

export interface Position {
  readonly line: number
  readonly character: number
}

export interface Range {
  readonly start: Position
  readonly end: Position
}

export interface Diagnostic {
  readonly range: Range
  readonly severity?: number
  readonly code?: string | number
  readonly source?: string
  readonly message: string
}

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  cleanup: () => void
}

/** A JSON-RPC error that keeps the server's code, so callers can retry transient failures. */
export class LspError extends Error {
  readonly code: number | undefined
  constructor(message: string, code: number | undefined) {
    super(message)
    this.name = "LspError"
    this.code = code
  }
}

export interface ClientOptions {
  readonly id: string
  readonly command: string[]
  readonly root: string
  readonly rootUri: string
  readonly env: Record<string, string>
  readonly initialization?: Record<string, unknown>
  readonly initializeTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly onDiagnostics: (uri: string, diagnostics: Diagnostic[], version: number | undefined) => void
  /** Called for every message from the server. Diagnostics waits use it to tell when the server is busy. */
  readonly onActivity: () => void
  readonly onExit: () => void
  readonly debug: boolean
}

/** A JSON-RPC 2.0 client for one language server over stdio. */
/** A `client/registerCapability` entry for pull diagnostics, as OpenCode 1 tracked them. */
interface PullRegistration {
  readonly id: string
  readonly method: string
  readonly registerOptions?: {
    readonly identifier?: string[]
    readonly workspaceDiagnostics?: boolean
  }
}

export class LspClient {
  readonly id: string
  readonly #options: ClientOptions
  #child?: ChildProcess
  #buffer: Buffer = Buffer.alloc(0)
  #nextId = 1
  #pending = new Map<number, Pending>()
  #capabilities: Record<string, any> = {}
  #pullRegistrations = new Map<string, PullRegistration>()
  #stopping = false

  constructor(options: ClientOptions) {
    this.id = options.id
    this.#options = options
  }

  get capabilities(): Record<string, any> {
    return this.#capabilities
  }

  /**
   * Pull-diagnostic state as OpenCode 1 computed it: the static `diagnosticProvider`
   * capability plus `client/registerCapability` entries for `textDocument/diagnostic`
   * (excluding workspace-scoped ones, which answer `workspace/diagnostic` instead).
   */
  get documentPullState(): { supported: boolean; identifiers: string[] } {
    const registrations = [...this.#pullRegistrations.values()]
    const documentRegistrations = registrations.filter((registration) => registration.registerOptions?.workspaceDiagnostics !== true)
    return {
      supported: Boolean(this.#capabilities.diagnosticProvider) || documentRegistrations.length > 0,
      identifiers: [...new Set(documentRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? []))],
    }
  }

  get running(): boolean {
    return !this.#stopping && this.#child !== undefined && this.#child.exitCode === null && this.#child.signalCode === null
  }

  async start(): Promise<void> {
    const [command, ...args] = this.#options.command
    if (!command) throw new Error(`${this.id}: no command configured`)
    const child = spawn(command, args, {
      cwd: this.#options.root,
      env: { ...process.env, ...this.#options.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.#child = child
    child.stdout?.on("data", (chunk: Buffer) => this.#onData(chunk))
    child.stderr?.on("data", (chunk: Buffer) => {
      if (this.#options.debug) process.stderr.write(`[lsp:${this.id}] ${chunk}`)
    })
    child.on("exit", (code, signal) => this.#onExit(code, signal))
    // A server that exits while a notification is being written raises EPIPE.
    child.stdin?.on("error", () => {})
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve())
      child.once("error", (error) => reject(new Error(`${this.id}: cannot start "${command}": ${error.message}`)))
    })
    const result = await this.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "opencode-lsp", version: "1" },
        rootUri: this.#options.rootUri,
        rootPath: this.#options.root,
        workspaceFolders: [{ uri: this.#options.rootUri, name: "workspace" }],
        initializationOptions: this.#options.initialization ?? {},
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          window: { workDoneProgress: true },
          workspace: { configuration: true, workspaceFolders: true, symbol: {}, didChangeWatchedFiles: { dynamicRegistration: true } },
          textDocument: {
            // OpenCode 1 declared didOpen/didChange; didSave is this port's addition (v1 never sent it).
            synchronization: { didOpen: true, didChange: true, didSave: true },
            publishDiagnostics: { versionSupport: true },
            // OpenCode 1 asked for dynamic pull registration and related documents; servers
            // like eclipse.jdt.ls only offer pull diagnostics through a registration.
            diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            implementation: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            callHierarchy: {},
          },
        },
      },
      this.#options.initializeTimeoutMs,
    )
    this.#capabilities = result?.capabilities ?? {}
    this.notify("initialized", {})
    if (this.#options.initialization) {
      this.notify("workspace/didChangeConfiguration", { settings: this.#options.initialization })
    }
  }

  request(method: string, params: unknown, timeoutMs = this.#options.requestTimeoutMs, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      if (!this.#child) {
        reject(new Error(`${this.id}: server is not running`))
        return
      }
      const id = this.#nextId++
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        cleanup()
        reject(new Error(`${this.id}: ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const abort = () => {
        this.#pending.delete(id)
        cleanup()
        this.notify("$/cancelRequest", { id })
        reject(signal!.reason)
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
      }
      this.#pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener("abort", abort, { once: true })
      this.#send({ jsonrpc: "2.0", id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params })
  }

  async stop(): Promise<void> {
    if (this.#stopping) return
    this.#stopping = true
    const child = this.#child
    if (child && child.exitCode === null) {
      await this.request("shutdown", null, 2_000).catch(() => undefined)
      this.#send({ jsonrpc: "2.0", method: "exit" })
      // OpenCode 1 only ever sent SIGTERM (via Process.stop); this port escalates
      // SIGTERM -> SIGKILL only if the server ignores the LSP exit notification.
      await new Promise<void>((resolve) => {
        const terminate = setTimeout(() => child.kill("SIGTERM"), 500)
        const kill = setTimeout(() => child.kill("SIGKILL"), 1_000)
        child.once("exit", () => {
          clearTimeout(terminate)
          clearTimeout(kill)
          resolve()
        })
      })
    }
    this.#child = undefined
    this.#rejectPending(new Error(`${this.id}: server stopped`))
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #send(message: Record<string, unknown>): void {
    const stdin = this.#child?.stdin
    if (!stdin || stdin.destroyed) return
    const body = JSON.stringify(message)
    stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    while (true) {
      // The LSP base protocol mandates CRLF, but the vscode-jsonrpc reader OpenCode 1
      // used also accepted LF-only header lines, so accept both header separators.
      const crlf = this.#buffer.indexOf("\r\n\r\n")
      const lf = this.#buffer.indexOf("\n\n")
      const separator = crlf >= 0 && (lf < 0 || crlf <= lf) ? crlf : lf
      if (separator < 0) return
      const boundary = separator === crlf ? 4 : 2
      const header = this.#buffer.subarray(0, separator).toString("utf8")
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        this.#buffer = this.#buffer.subarray(separator + boundary)
        continue
      }
      const start = separator + boundary
      const end = start + Number(match[1])
      if (this.#buffer.length < end) return
      const body = this.#buffer.subarray(start, end).toString("utf8")
      this.#buffer = this.#buffer.subarray(end)
      try {
        this.#handle(JSON.parse(body))
      } catch (error) {
        if (this.#options.debug) console.error(`[lsp:${this.id}] bad message: ${errorMessage(error)}`)
      }
    }
  }

  #handle(message: any): void {
    if (!message || typeof message !== "object") return
    this.#options.onActivity()
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      pending.cleanup()
      this.#pending.delete(message.id)
      if (message.error) pending.reject(new LspError(`${this.id}: ${message.error.message ?? "request failed"}`, message.error.code))
      else pending.resolve(message.result)
      return
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params ?? {}
      this.#options.onDiagnostics(
        String(params.uri ?? ""),
        Array.isArray(params.diagnostics) ? params.diagnostics : [],
        typeof params.version === "number" ? params.version : undefined,
      )
      return
    }
    if (message.id !== undefined) this.#respond(message.id, message.method, message.params)
  }

  #respond(id: unknown, method: string, params: any): void {
    const reply = (result: unknown) => this.#send({ jsonrpc: "2.0", id, result })
    switch (method) {
      case "workspace/configuration": {
        const items: any[] = Array.isArray(params?.items) ? params.items : []
        reply(items.map((item) => this.#section(item?.section)))
        return
      }
      case "workspace/workspaceFolders":
        reply([{ uri: this.#options.rootUri, name: "workspace" }])
        return
      case "client/registerCapability": {
        // Keep pull-diagnostic registrations so diagnostics waits can use them, as OpenCode 1 did.
        for (const registration of Array.isArray(params?.registrations) ? params.registrations : []) {
          if (registration?.method === "textDocument/diagnostic" && typeof registration?.id === "string") {
            this.#pullRegistrations.set(registration.id, registration)
          }
        }
        reply(null)
        return
      }
      case "client/unregisterCapability": {
        for (const registration of Array.isArray(params?.unregisterations) ? params.unregisterations : []) {
          if (registration?.method === "textDocument/diagnostic" && typeof registration?.id === "string") {
            this.#pullRegistrations.delete(registration.id)
          }
        }
        reply(null)
        return
      }
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
      case "workspace/diagnostic/refresh":
        reply(null)
        return
      default:
        this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  }

  /** Answers `workspace/configuration` from the server's `initialization` options. */
  #section(section: unknown): unknown {
    // v1's configurationValue: with no initialization the answer is null, not {}.
    const settings = this.#options.initialization
    if (typeof section !== "string" || section === "") return settings ?? null
    let value: any = settings
    for (const key of section.split(".")) {
      value = value?.[key]
      if (value === undefined) return null
    }
    return value
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#child = undefined
    this.#rejectPending(new Error(`${this.id}: server exited (${code ?? signal})`))
    if (!this.#stopping && this.#options.debug) console.error(`[lsp:${this.id}] exited (${code ?? signal})`)
    this.#options.onExit()
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The server's document sync kind from its capabilities, as OpenCode 1 read it: numeric or `{ change }`. */
export function syncKindOf(capabilities: Record<string, any>): number | undefined {
  const sync = capabilities.textDocumentSync
  if (typeof sync === "number") return sync
  return typeof sync?.change === "number" ? sync.change : undefined
}

/** The position just past the last character of `text`, used to replace the whole document incrementally. */
export function endPosition(text: string): Position {
  const lines = text.split(/\r\n|\r|\n/)
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }
}
