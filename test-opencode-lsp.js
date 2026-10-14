#!/usr/bin/env node
// Usage: test-opencode-lsp.js [plugin-dir]
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { constants } from "node:fs"
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const PLUGIN = pathToFileURL(resolve(process.argv[2] ?? new URL(".", import.meta.url).pathname) + "/")
const { default: plugin } = await import(new URL("index.ts", PLUGIN))
const { resolveSettings } = await import(new URL("src/config.ts", PLUGIN))
const { LspManager, serverRoot, requestWithRetry } = await import(new URL("src/manager.ts", PLUGIN))
const { ensureServer } = await import(new URL("src/download.ts", PLUGIN))
const { LspError } = await import(new URL("src/client.ts", PLUGIN))

const cases = []
const test = (name, run) => cases.push({ name, run })

// A language server that reports one diagnostic per line containing ERROR,
// WARN, or NOSEV (no severity), and answers navigation requests with fixed results.
const FAKE_SERVER = String.raw`
import { appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
const pull = process.env.FAKE_PULL === "1" || process.env.FAKE_REG === "1"
const documents = new Map()
let buffer = Buffer.alloc(0)
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message })
  // LF-only header endings, like the vscode-jsonrpc readers tolerate.
  const boundary = process.env.FAKE_LF ? "\n\n" : "\r\n\r\n"
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + boundary + body)
}
const diagnose = (text) =>
  text.split("\n").flatMap((line, index) => {
    const severity = line.includes("ERROR") ? 1 : line.includes("WARN") ? 2 : line.includes("NOSEV") ? undefined : 0
    if (severity === 0) return []
    const character = line.search(/ERROR|WARN|NOSEV/)
    return [{ range: { start: { line: index, character }, end: { line: index, character: character + 1 } }, severity, message: "bad " + index }]
  })
const changed = (uri, version, text) => {
  documents.set(uri, text)
  if (pull || text.includes("SILENT")) return
  setTimeout(() => {
    send({ method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: diagnose(text) } })
    if (text.includes("LATE")) {
      setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: { uri, version: version - 1, diagnostics: diagnose("old\nERROR late") } }), 100)
    }
    if (text.includes("BREAK_OTHER")) {
      const other = new URL("other.ts", uri).href
      send({ method: "textDocument/publishDiagnostics", params: { uri: "untitled:scratch.ts", diagnostics: diagnose("ERROR unsaved") } })
      send({ method: "textDocument/publishDiagnostics", params: { uri: other, diagnostics: diagnose("ERROR elsewhere") } })
      for (const extra of JSON.parse(process.env.FAKE_OTHER_URIS ?? "[]")) {
        send({ method: "textDocument/publishDiagnostics", params: { uri: extra, diagnostics: diagnose("ERROR outside") } })
      }
    }
  }, text.includes("DELAYED") ? 700 : 20)
}
const at = (uri, line, character) => ({ uri, range: { start: { line, character }, end: { line, character: character + 1 } } })
const item = (name, uri, line) => ({ name, kind: 12, uri, range: at(uri, line, 0).range, selectionRange: at(uri, line, 0).range })
const handle = (message) => {
  const { id, method, params } = message
  const uri = params?.textDocument?.uri
  // A co-serving server that errors on every navigation request, like a biome that
  // chokes on a file while the healthy file server answers.
  if (process.env.FAKE_FAIL_NAV && id !== undefined && method?.startsWith("textDocument/"))
    return send({ id, error: { code: -32603, message: "nav down" } })
  if (process.env.FAKE_LOG && (method?.startsWith("textDocument/") || method === "$/cancelRequest" || method === "initialize" || method === "workspace/didChangeWatchedFiles")) {
    const text = params?.textDocument?.text ?? params?.contentChanges?.[0]?.text ?? ""
    appendFileSync(process.env.FAKE_LOG, JSON.stringify({ method, uri, version: params?.textDocument?.version, id: params?.id, outside: text.includes("OUTSIDE"), text: params?.text, initializationOptions: params?.initializationOptions, watchTypes: Array.isArray(params?.changes) ? params.changes.map((change) => change.type) : undefined, changeRange: params?.contentChanges?.[0]?.range, identifier: params?.identifier }) + "\n")
  }
  switch (method) {
    case "initialize": {
      const result = { capabilities: {
        textDocumentSync: process.env.FAKE_SYNC ? JSON.parse(process.env.FAKE_SYNC) : { openClose: true, change: 1, save: { includeText: false } },
        hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true,
        workspaceSymbolProvider: true, callHierarchyProvider: true,
        ...(process.env.FAKE_PULL === "1" ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {}),
      } }
      // A jdtls-style server only offers pull diagnostics through a dynamic registration.
      if (process.env.FAKE_REG) send({ id: 900, method: "client/registerCapability", params: { registrations: [{ id: "pull-extra", method: "textDocument/diagnostic", registerOptions: { identifier: ["registered"] } }] } })
      if (!process.env.FAKE_EARLY) {
        const replyInit = () => {
          send({ id, result })
          // A server polling its configuration right after initialize, like lua-ls and pylsp do.
          if (process.env.FAKE_CONFIG) send({ id: 901, method: "workspace/configuration", params: { items: [{}, { section: "python" }, { section: "python.pythonPath" }, { section: "missing.deep" }] } })
        }
        return process.env.FAKE_INIT_DELAY ? setTimeout(replyInit, Number(process.env.FAKE_INIT_DELAY)) : replyInit()
      }
      // An unversioned report from before the file was sent, then a slow start.
      send({ method: "textDocument/publishDiagnostics", params: { uri: new URL(process.env.FAKE_EARLY, params.rootUri + "/").href, diagnostics: diagnose("ERROR stale") } })
      return setTimeout(() => send({ id, result }), 200)
    }
    case "textDocument/didOpen":
      return changed(uri, params.textDocument.version, params.textDocument.text)
    case "textDocument/didChange":
      return changed(uri, params.textDocument.version, params.contentChanges[0].text)
    case "textDocument/diagnostic": {
      const text = documents.get(uri) ?? ""
      const result = params?.identifier === "registered" && process.env.FAKE_REG
        ? { kind: "full", items: diagnose("ERROR registered") }
        : { kind: "full", items: diagnose(text) }
      return text.includes("SLOWPULL") ? setTimeout(() => send({ id, result }), 300) : send({ id, result })
    }
    case "textDocument/hover": {
      const reply = () => send({ id, result: { contents: { kind: "markdown", value: "hover " + params.position.line + ":" + params.position.character } } })
      return process.env.FAKE_HOVER_DELAY ? setTimeout(reply, Number(process.env.FAKE_HOVER_DELAY)) : reply()
    }
    case "textDocument/definition":
      return send({ id, result: [{ targetUri: uri, targetRange: at(uri, 4, 2).range, targetSelectionRange: at(uri, 5, 3).range }] })
    case "textDocument/references":
      return send({ id, result: [at(uri, 0, 0), at(uri, 2, 6)] })
    case "textDocument/documentSymbol":
      return send({ id, result: [{ name: "Outer", kind: 5, range: at(uri, 0, 0).range, selectionRange: at(uri, 0, 6).range,
        children: [{ name: "inner", detail: "(): void", kind: 6, range: at(uri, 1, 2).range, selectionRange: at(uri, 1, 2).range }] }] })
    case "workspace/symbol": {
      const location = at(new URL("lib/x.ts", "file://" + process.cwd() + "/").href, 9, 0)
      if (params.query === "kinds")
        return send({ id, result: [
          { name: "FileThing", kind: 1, location },
          { name: "Container", kind: 4, location },
          { name: "Cls", kind: 5, location },
          { name: "fn", kind: 12, location },
        ] })
      const count = params.query === "many" ? 25 : 1
      return send({ id, result: Array.from({ length: count }, (_, n) => ({ name: "Thing" + params.query + (n || ""), kind: 13, containerName: "mod", location })) })
    }
    case "textDocument/prepareCallHierarchy":
      // A call on an imported function prepares the item where that function is defined.
      return send({ id, result: [item("target", documents.get(uri)?.includes("IMPORTED") ? new URL("def.ts", uri).href : uri, 3)] })
    case "callHierarchy/incomingCalls":
      return send({ id, result: [{ from: item("caller", params.item.uri, 7), fromRanges: [at(uri, 2, 4).range] }] })
    case "callHierarchy/outgoingCalls":
      return send({ id, result: [{ to: item("callee", params.item.uri, 11), fromRanges: [at(uri, 4, 8).range, at(uri, 5, 0).range] }] })
    case "shutdown":
      return send({ id, result: null })
    case "exit":
      return process.exit(0)
    default:
      // Record how the client answered our configuration poll (a response carries no method).
      if (id === 901 && method === undefined && process.env.FAKE_LOG)
        appendFileSync(process.env.FAKE_LOG, JSON.stringify({ method: "configuration-reply", config: message.result }) + "\n")
      // Only answer requests; a response to one of our own requests has no method.
      if (id !== undefined && method) send({ id, result: null })
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const end = buffer.indexOf("\r\n\r\n")
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length).toString()
    buffer = buffer.subarray(end + 4 + length)
    handle(JSON.parse(body))
  }
})
`

async function project(lsp) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-lsp-")))
  await writeFile(join(root, "fake-lsp.mjs"), FAKE_SERVER)
  for (const server of Object.values(lsp)) {
    if (server.command?.[0] === "FAKE") server.command = [process.execPath, join(root, "fake-lsp.mjs")]
  }
  await writeFile(join(root, "opencode.json"), JSON.stringify({ lsp }))
  return root
}

/** A stand-in for the parts of OpenCode 2's plugin context the plugin uses. */
async function start(root, options = {}) {
  const tools = []
  const hooks = []
  const disposed = []
  const emitted = []
  let status
  const ctx = {
    location: { directory: root },
    options,
    rpc: {
      register: async (definition, handlers) => {
        status = handlers.status
        return {
          events: { emit: (name, data) => emitted.push({ name, data }) },
          dispose: async () => disposed.push("rpc"),
        }
      },
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (tool) => tools.push(tool) })
        return { dispose: async () => disposed.push("tools") }
      },
      hook: async (name, callback) => {
        hooks.push({ name, callback })
        return { dispose: async () => disposed.push(name) }
      },
    },
  }
  const env = { ...process.env }
  process.env.OPENCODE_CONFIG_DIR = join(root, "no-global")
  delete process.env.OPENCODE_CONFIG
  delete process.env.OPENCODE_CONFIG_CONTENT
  process.env.PATH = join(root, "empty-path")
  let cleanup
  try {
    cleanup = await plugin.setup(ctx)
  } finally {
    process.env = env
  }
  const lsp = tools.find((tool) => tool.name === "lsp")
  const after = hooks.find((hook) => hook.name === "execute.after")?.callback
  return { tools, hooks, disposed, cleanup, lsp, after, emitted, status }
}

const completed = (tool, input, result) => ({ tool, input, status: "completed", sessionID: "s", agent: "a", messageID: "m", id: "c", result })

const FAKE = { fake: { command: ["FAKE"], extensions: [".ts"] } }

async function waitForLog(log, method) {
  for (const deadline = Date.now() + 5_000; Date.now() < deadline; ) {
    const entries = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse)
    const found = entries.find((entry) => entry.method === method)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Server did not log ${method}`)
}

test("write results get OpenCode 1's error block and TUI metadata; warnings and clean files add nothing", async () => {
  const root = await project(structuredClone(FAKE))
  const { after, cleanup } = await start(root)
  try {
    await writeFile(join(root, "a.ts"), "ok\nWARN here\n  ERROR there\n")
    const event = completed("write", { path: "a.ts" }, { output: { operation: "write", target: join(root, "a.ts"), resource: "a.ts", existed: false }, content: "Created file successfully: a.ts" })
    await after(event)
    assert.equal(
      event.result.content,
      `Created file successfully: a.ts\n\nLSP errors detected in this file, please fix:\n<diagnostics file="${join(root, "a.ts")}">\nERROR [3:3] bad 2\n</diagnostics>`,
    )
    assert.deepEqual(Object.keys(event.result.metadata.diagnostics).sort(), [join(root, "a.ts"), "a.ts"].sort())
    assert.equal(event.result.metadata.diagnostics["a.ts"][0].severity, 1)

    await writeFile(join(root, "a.ts"), "ok\nWARN only\n")
    const clean = completed("edit", { path: "a.ts" }, { content: "Edited a.ts (1 replacement)", metadata: { files: [] } })
    await after(clean)
    assert.equal(clean.result.content, "Edited a.ts (1 replacement)")
    assert.equal(clean.result.metadata.diagnostics, undefined)
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("patch reports each changed file by path, skips deletions and non-file URIs, and lists fresh errors in other files", async () => {
  const root = await project(structuredClone(FAKE))
  const { after, cleanup } = await start(root)
  try {
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src", "b.ts"), "ERROR one\nBREAK_OTHER\n")
    await writeFile(join(root, "src", "other.ts"), "fine\n")
    await writeFile(join(root, "notes.md"), "ERROR not checked\n")
    const event = completed("patch", { patchText: "..." }, {
      output: {
        applied: [
          { type: "update", resource: "src/b.ts", target: join(root, "src", "b.ts") },
          { type: "add", resource: "notes.md", target: join(root, "notes.md") },
          { type: "delete", resource: "gone.ts", target: join(root, "gone.ts") },
        ],
        files: [],
      },
      content: "Success. Updated the following files:\nM src/b.ts",
    })
    await after(event)
    assert.match(event.result.content, /LSP errors detected in src\/b\.ts, please fix:\n<diagnostics file="[^"]+b\.ts">\nERROR \[1:1\] bad 0\n<\/diagnostics>/)
    assert.match(event.result.content, /LSP errors detected in other files:\n<diagnostics file="[^"]+other\.ts">\nERROR \[1:1\] bad 0\n<\/diagnostics>/)
    assert.doesNotMatch(event.result.content, /notes\.md|gone\.ts|scratch\.ts/)
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("silent servers cost one timeout per patch and never resurface an older report", async () => {
  const root = await project(structuredClone(FAKE))
  const { after, cleanup } = await start(root, { diagnosticsTimeoutMs: 600 })
  try {
    await writeFile(join(root, "s.ts"), "ERROR before\n")
    const first = completed("write", { path: "s.ts" }, { output: { target: join(root, "s.ts") }, content: "Wrote s.ts" })
    await after(first)
    assert.match(first.result.content, /ERROR \[1:1\] bad 0/)
    await writeFile(join(root, "s.ts"), "SILENT fixed\n")
    const second = completed("edit", { path: "s.ts" }, { content: "Edited s.ts" })
    await after(second)
    assert.equal(second.result.content, "Edited s.ts")

    const names = ["p1.ts", "p2.ts", "p3.ts", "p4.ts"]
    for (const name of names) await writeFile(join(root, name), "SILENT\n")
    const patch = completed("patch", { patchText: "..." }, {
      output: { applied: names.map((name) => ({ type: "add", resource: name, target: join(root, name) })) },
      content: "Success.",
    })
    const started = Date.now()
    await after(patch)
    assert.equal(patch.result.content, "Success.")
    assert.ok(Date.now() - started < 1_800, "files in one patch should wait for diagnostics concurrently")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("an extensionless Dockerfile matches a server that lists .dockerfile", async () => {
  const root = await project({ dockerfile: { command: ["FAKE"], extensions: [".dockerfile"] } })
  const { after, cleanup } = await start(root)
  try {
    await writeFile(join(root, "Dockerfile"), "FROM x\nERROR here\n")
    const event = completed("write", { path: "Dockerfile" }, { output: { target: join(root, "Dockerfile") }, content: "Wrote Dockerfile" })
    await after(event)
    assert.match(event.result.content, /LSP errors detected in this file, please fix:\n<diagnostics file="[^"]+Dockerfile">\nERROR \[2:1\] bad 1/)
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("hooks never send files outside the project, keep versions in order, and close deleted files", async () => {
  const root = await project({ fake: { command: ["FAKE"], extensions: [".ts"], env: { FAKE_LOG: "LOG" } } })
  const log = join(root, "lsp.log")
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.fake.env.FAKE_LOG = log
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const outside = await realpath(await mkdtemp(join(tmpdir(), "opencode-lsp-outside-")))
  const { after, cleanup } = await start(root)
  const sent = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  try {
    await writeFile(join(outside, "secret.ts"), "ERROR secret\n")
    await symlink(join(outside, "secret.ts"), join(root, "linked.ts"))
    await after(completed("read", { path: join(outside, "secret.ts") }, { content: "" }))
    await after(completed("read", { path: "linked.ts" }, { content: "" }))
    const escaped = completed("write", { path: join(outside, "secret.ts") }, { output: { target: join(outside, "secret.ts") }, content: "Wrote secret.ts" })
    await after(escaped)
    const linked = completed("edit", { path: "linked.ts" }, { content: "Edited linked.ts" })
    await after(linked)
    assert.equal(escaped.result.content, "Wrote secret.ts")
    assert.equal(linked.result.content, "Edited linked.ts")

    const file = join(root, "a.ts")
    await writeFile(file, "ok\n")
    for (let n = 0; n < 8; n++) void after(completed("read", { path: "a.ts" }, { content: "" }))
    await after(completed("edit", { path: "a.ts" }, { content: "Edited a.ts" }))
    const uri = pathToFileURL(file).href
    const versions = (await sent()).filter((entry) => entry.uri === uri && entry.method !== "textDocument/didSave").map((entry) => entry.version)
    assert.deepEqual(versions, versions.toSorted((a, b) => a - b), "versions must reach the server in order")
    assert.equal(new Set(versions).size, versions.length)

    await after(completed("patch", { patchText: "..." }, { output: { applied: [{ type: "delete", resource: "a.ts", target: file }] }, content: "Success." }))
    await rm(file)
    await writeFile(file, "ERROR again\n")
    const recreated = completed("write", { path: "a.ts" }, { output: { target: file }, content: "Wrote a.ts" })
    await after(recreated)
    assert.match(recreated.result.content, /ERROR \[1:1\] bad 0/)
    const tail = (await sent()).filter((entry) => entry.uri === uri).slice(-3).map((entry) => `${entry.method} ${entry.version ?? ""}`.trim())
    const reopened = versions.at(-1) + 1
    assert.deepEqual(tail, ["textDocument/didClose", `textDocument/didOpen ${reopened}`, "textDocument/didSave"], "a recreated file continues the version count")
    assert.ok((await sent()).every((entry) => !entry.uri?.includes("secret") && !entry.uri?.includes("linked")), "outside files must never reach a server")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("a symlink swapped to an outside file mid-check never sends its contents", async () => {
  const root = await project({ fake: { command: ["FAKE"], extensions: [".ts"], env: { FAKE_LOG: "LOG" } } })
  const log = join(root, "lsp.log")
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.fake.env.FAKE_LOG = log
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const outside = await realpath(await mkdtemp(join(tmpdir(), "opencode-lsp-outside-")))
  await writeFile(join(outside, "secret.ts"), "OUTSIDE\n")
  await writeFile(join(root, "inner.ts"), "inside\n")
  await symlink(join(root, "inner.ts"), join(root, "swap.ts"))
  // Flips swap.ts between the inside and outside targets with atomic renames.
  const swapper = spawn(process.execPath, ["-e", String.raw`
    const { renameSync, symlinkSync } = require("node:fs")
    const [root, outside] = process.argv.slice(1)
    for (let n = 0; ; n++) {
      const next = root + "/swap.next"
      symlinkSync(n % 2 ? outside + "/secret.ts" : root + "/inner.ts", next)
      renameSync(next, root + "/swap.ts")
    }`, root, outside], { stdio: "ignore" })
  const { after, cleanup } = await start(root)
  try {
    for (const deadline = Date.now() + 1_500; Date.now() < deadline; ) {
      await after(completed("edit", { path: "swap.ts" }, { content: "Edited swap.ts" }))
    }
    const sent = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    assert.ok(sent.some((entry) => entry.uri?.endsWith("/swap.ts")), "the inside target should still be synced")
    assert.ok(sent.every((entry) => !entry.outside), "outside contents must never reach a server")
  } finally {
    const exited = once(swapper, "exit")
    swapper.kill()
    await exited
    await cleanup()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("patches check every changed file, close moved-away files, and count diagnostics without severity as errors", async () => {
  const root = await project({ fake: { command: ["FAKE"], extensions: [".ts"], env: { FAKE_LOG: "LOG" } } })
  const log = join(root, "lsp.log")
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.fake.env.FAKE_LOG = log
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const { after, cleanup } = await start(root)
  try {
    const names = Array.from({ length: 11 }, (_, n) => `f${n}.ts`)
    for (const name of names) await writeFile(join(root, name), name === "f10.ts" ? "NOSEV here\n" : "ERROR here\n")
    const many = completed("patch", { patchText: "..." }, {
      output: { applied: names.map((name) => ({ type: "add", resource: name, target: join(root, name) })) },
      content: "Success.",
    })
    await after(many)
    for (const name of names) assert.match(many.result.content, new RegExp(`LSP errors detected in ${name}, please fix:\n<diagnostics file="[^"]+">\nERROR \\[1:1\\] bad 0`))

    await writeFile(join(root, "old.ts"), "ok\n")
    await after(completed("read", { path: "old.ts" }, { content: "" }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    await rm(join(root, "old.ts"))
    await writeFile(join(root, "new.ts"), "ok\n")
    const patchText = "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n ok\n*** End Patch"
    await after(completed("patch", { patchText }, {
      output: { applied: [{ type: "update", resource: "new.ts", target: join(root, "new.ts") }], files: [{ file: "new.ts", status: "modified" }] },
      content: "Success.",
    }))
    const sent = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    const old = pathToFileURL(join(root, "old.ts")).href
    assert.deepEqual(sent.filter((entry) => entry.uri === old).map((entry) => entry.method).at(-1), "textDocument/didClose")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("reports from before the file reached the server, or for an older version, are not taken as its result", async () => {
  const root = await project({ fake: { command: ["FAKE"], extensions: [".ts"], env: { FAKE_EARLY: "early.ts" } } })
  const { after, cleanup } = await start(root, { diagnosticsTimeoutMs: 600 })
  try {
    await writeFile(join(root, "early.ts"), "SILENT fine\n")
    const event = completed("write", { path: "early.ts" }, { output: { target: join(root, "early.ts") }, content: "Wrote early.ts" })
    await after(event)
    assert.equal(event.result.content, "Wrote early.ts")

    // A slow report for deleted contents must not land on the recreated file.
    await writeFile(join(root, "gone.ts"), "ERROR DELAYED\n")
    await after(completed("write", { path: "gone.ts" }, { output: { target: join(root, "gone.ts") }, content: "Wrote gone.ts" }))
    await after(completed("patch", { patchText: "..." }, { output: { applied: [{ type: "delete", resource: "gone.ts", target: join(root, "gone.ts") }] }, content: "Success." }))
    await writeFile(join(root, "gone.ts"), "clean\n")
    const recreated = completed("write", { path: "gone.ts" }, { output: { target: join(root, "gone.ts") }, content: "Wrote gone.ts" })
    await after(recreated)
    assert.equal(recreated.result.content, "Wrote gone.ts")

    await writeFile(join(root, "late.ts"), "ERROR now LATE\n")
    const late = completed("write", { path: "late.ts" }, { output: { target: join(root, "late.ts") }, content: "Wrote late.ts" })
    await after(late)
    assert.match(late.result.content, /ERROR \[1:1\] bad 0/)
    assert.doesNotMatch(late.result.content, /\[2:1\]/)
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("a slow report for a file the same patch deletes never shows up as another file's error", async () => {
  const root = await project({ fake: { command: ["FAKE"], extensions: [".ts"] } })
  const { after, cleanup } = await start(root)
  try {
    await writeFile(join(root, "doomed.ts"), "ERROR DELAYED\n")
    await after(completed("read", { path: "doomed.ts" }, { content: "" }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    await rm(join(root, "doomed.ts"))
    await writeFile(join(root, "sibling.ts"), "fine DELAYED\n")
    const sibling = completed("patch", { patchText: "..." }, {
      output: { applied: [
        { type: "delete", resource: "doomed.ts", target: join(root, "doomed.ts") },
        { type: "update", resource: "sibling.ts", target: join(root, "sibling.ts") },
      ] },
      content: "Success.",
    })
    await after(sibling)
    assert.equal(sibling.result.content, "Success.")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("servers that support pull diagnostics are asked directly", async () => {
  const root = await project({ fake: { command: ["FAKE"], extensions: [".ts"], env: { FAKE_PULL: "1" } } })
  const { after, cleanup } = await start(root)
  try {
    await writeFile(join(root, "c.ts"), "ERROR pulled\n")
    const event = completed("write", { path: join(root, "c.ts") }, { output: { target: join(root, "c.ts") }, content: "Wrote file successfully: c.ts" })
    const started = Date.now()
    await after(event)
    assert.match(event.result.content, /ERROR \[1:1\] bad 0/)
    assert.ok(Date.now() - started < 2_000, "pull diagnostics should not wait for the push timeout")

    // An older edit's slow answer must not report errors a later edit already fixed.
    await writeFile(join(root, "c.ts"), "ERROR SLOWPULL\n")
    const older = completed("edit", { path: "c.ts" }, { content: "Edited c.ts" })
    const pending = after(older)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await writeFile(join(root, "c.ts"), "fine\n")
    const newer = completed("edit", { path: "c.ts" }, { content: "Edited c.ts" })
    await Promise.all([pending, after(newer)])
    assert.equal(newer.result.content, "Edited c.ts")
    assert.equal(older.result.content, "Edited c.ts")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("the lsp tool runs OpenCode 1's operations with 1-based positions", async () => {
  const root = await project(structuredClone(FAKE))
  const { lsp, cleanup } = await start(root)
  try {
    await writeFile(join(root, "d.ts"), "class Outer {\n  inner() {}\n}\n")
    const run = async (input) => (await lsp.execute({ path: "d.ts", ...input }, {})).content
    assert.equal(lsp.options.permission, "lsp")
    assert.equal(lsp.options.codemode, false)
    assert.equal(await run({ operation: "hover", line: 2, character: 3 }), "hover 1:2")
    assert.equal(await run({ operation: "goToDefinition", line: 1, character: 1 }), "d.ts:6:4")
    assert.equal(await run({ operation: "findReferences", line: 1, character: 1 }), "d.ts:1:1\nd.ts:3:7")
    assert.equal(await run({ operation: "documentSymbol" }), "Outer (class) 1:7\n  inner (): void (method) 2:3")
    assert.equal(await run({ operation: "workspaceSymbol", query: "Q" }), "ThingQ (variable) in mod lib/x.ts:10:1")
    assert.equal(await run({ operation: "prepareCallHierarchy", line: 4, character: 1 }), "target (function) d.ts:4:1")
    const many = (await run({ operation: "workspaceSymbol", query: "many" })).split("\n")
    assert.equal(many.length, 21)
    assert.equal(many.at(-1), "... and 5 more; use a more specific query")
    assert.equal(await run({ operation: "incomingCalls", line: 4, character: 1 }), "caller (function) d.ts:8:1 called at d.ts:3:5")
    assert.equal(await run({ operation: "outgoingCalls", line: 4, character: 1 }), "callee (function) d.ts:12:1 called at d.ts:5:9, d.ts:6:1")
    await writeFile(join(root, "imp.ts"), "IMPORTED()\n")
    assert.equal(
      (await lsp.execute({ operation: "outgoingCalls", path: "imp.ts", line: 1, character: 1 }, {})).content,
      "callee (function) def.ts:12:1 called at def.ts:5:9, def.ts:6:1",
    )
    assert.equal(await run({ operation: "goToImplementation", line: 1, character: 1 }).catch((error) => error.message), "No LSP server for this file supports implementationProvider.")
    await assert.rejects(run({ operation: "hover" }), /needs line and character/)
    await assert.rejects(lsp.execute({ operation: "hover", path: "../outside.ts", line: 1, character: 1 }, {}), /outside the project/)
    const outside = await mkdtemp(join(tmpdir(), "opencode-lsp-outside-"))
    await writeFile(join(outside, "secret.ts"), "secret\n")
    await symlink(join(outside, "secret.ts"), join(root, "linked.ts"))
    await assert.rejects(lsp.execute({ operation: "hover", path: "linked.ts", line: 1, character: 1 }, {}), /outside the project/)
    await rm(outside, { recursive: true, force: true })
    await assert.rejects(lsp.execute({ operation: "hover", path: "missing.ts", line: 1, character: 1 }, {}), /File not found/)
    await writeFile(join(root, "e.py"), "x = 1\n")
    await assert.rejects(lsp.execute({ operation: "hover", path: "e.py", line: 1, character: 1 }, {}), /No LSP server available for this file type/)
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("builtin server IDs run at OpenCode 1's per-server roots; custom IDs run at the project", async () => {
  const root = await project({ pyright: { command: ["FAKE"] }, typescript: { command: ["FAKE"] }, custom: { command: ["FAKE"], extensions: [".sh"] } })
  const { lsp, cleanup } = await start(root)
  try {
    await mkdir(join(root, "svc", "src"), { recursive: true })
    await writeFile(join(root, "svc", "pyproject.toml"), "")
    await writeFile(join(root, "svc", "src", "app.py"), "x = 1\n")
    await writeFile(join(root, "top.py"), "x = 1\n")
    await mkdir(join(root, "web", "sub"), { recursive: true })
    await writeFile(join(root, "web", "package-lock.json"), "{}")
    await writeFile(join(root, "web", "sub", "run.sh"), "true\n")
    await mkdir(join(root, "denoapp"))
    await writeFile(join(root, "denoapp", "deno.json"), "{}")
    await writeFile(join(root, "denoapp", "main.ts"), "ERROR\n")
    // The fake server reports workspace symbols under its working directory.
    const symbols = async (path) => (await lsp.execute({ operation: "workspaceSymbol", path, query: "Q" }, {})).content
    assert.equal(await symbols("svc/src/app.py"), "ThingQ (variable) in mod svc/lib/x.ts:10:1")
    assert.equal(await symbols("top.py"), "ThingQ (variable) in mod lib/x.ts:10:1")
    assert.equal(await symbols("web/sub/run.sh"), "ThingQ (variable) in mod lib/x.ts:10:1")
    await assert.rejects(symbols("denoapp/main.ts"), /No configured LSP server applies/)

    await mkdir(join(root, "ws", "crates", "a", "src"), { recursive: true })
    await writeFile(join(root, "ws", "Cargo.toml"), '[workspace]\nmembers = ["crates/a"]\n')
    await writeFile(join(root, "ws", "crates", "a", "Cargo.toml"), '[package]\nname = "a"\n')
    assert.equal(await serverRoot("rust", join(root, "ws", "crates", "a", "src", "lib.rs"), root), join(root, "ws"))
    await mkdir(join(root, "mod", "pkg"), { recursive: true })
    await writeFile(join(root, "mod", "go.mod"), "module m\n")
    assert.equal(await serverRoot("gopls", join(root, "mod", "pkg", "x.go"), root), root)
    await writeFile(join(root, "mod", "go.work"), "go 1.22\n")
    assert.equal(await serverRoot("gopls", join(root, "mod", "pkg", "x.go"), root), join(root, "mod"))
    assert.equal(await serverRoot("deno", join(root, "top.ts"), root), undefined)
    // OpenCode 1 skipped Prisma in any npm project; every Prisma project has a package.json.
    await mkdir(join(root, "db", "prisma"), { recursive: true })
    await writeFile(join(root, "db", "package.json"), "{}")
    await writeFile(join(root, "db", "prisma", "schema.prisma"), "")
    assert.equal(await serverRoot("prisma", join(root, "db", "prisma", "schema.prisma"), root), join(root, "db", "prisma"))
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("a server that cannot start leaves edits alone and makes the tool explain why", async () => {
  const root = await project({ broken: { command: ["/nonexistent/lsp-binary"], extensions: [".ts"] } })
  const { after, lsp, cleanup } = await start(root)
  try {
    await writeFile(join(root, "f.ts"), "ERROR\n")
    const event = completed("edit", { path: "f.ts" }, { content: "Edited f.ts" })
    await after(event)
    assert.equal(event.result.content, "Edited f.ts")
    await assert.rejects(lsp.execute({ operation: "hover", path: "f.ts", line: 1, character: 1 }, {}), /could start\. broken: .*cannot start "\/nonexistent\/lsp-binary"/)
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("setup registers nothing without servers and cleans up what it registered", async () => {
  const empty = await project({ off: { disabled: true } })
  try {
    const { tools, hooks, disposed, cleanup } = await start(empty)
    assert.equal(tools.length + hooks.length, 0)
    await cleanup()
    assert.deepEqual(disposed, ["rpc"])
  } finally {
    await rm(empty, { recursive: true, force: true })
  }

  const root = await project(structuredClone(FAKE))
  try {
    const { disposed, cleanup } = await start(root)
    await cleanup()
    assert.deepEqual(disposed.sort(), ["execute.after", "rpc", "tools"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("status and lifecycle events drive the terminal sidebar rows", async () => {
  const root = await project(structuredClone(FAKE))
  try {
    const { after, cleanup, emitted, status } = await start(root)
    assert.deepEqual(await status(), { configured: true, servers: [] })
    await writeFile(join(root, "a.ts"), "ok\n")
    const event = completed("write", { path: "a.ts" }, { content: "Edited a.ts" })
    await after(event)
    assert.ok(emitted.some((entry) => entry.name === "connected" && entry.data.id === "fake" && entry.data.root === root))
    assert.deepEqual(await status(), { configured: true, servers: [{ id: "fake", root, status: "connected" }] })
    await cleanup()
    assert.ok(emitted.some((entry) => entry.name === "shutdown" && entry.data.id === "fake"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("other-file diagnostics exclude outside paths and symlinks but keep inside files", async () => {
  const root = await project(structuredClone(FAKE))
  const outside = await realpath(await mkdtemp(join(tmpdir(), "opencode-lsp-outside-")))
  let cleanup
  try {
    await writeFile(join(outside, "secret.ts"), "secret\n")
    await symlink(join(outside, "secret.ts"), join(root, "linked.ts"))
    await writeFile(join(root, "other.ts"), "fine\n")
    const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
    config.lsp.fake.env = { FAKE_OTHER_URIS: JSON.stringify([
      pathToFileURL(join(outside, "secret.ts")).href,
      pathToFileURL(join(root, "linked.ts")).href,
      pathToFileURL(join(root, "missing.ts")).href,
    ]) }
    await writeFile(join(root, "opencode.json"), JSON.stringify(config))
    const started = await start(root)
    cleanup = started.cleanup
    await writeFile(join(root, "a.ts"), "BREAK_OTHER\n")
    const event = completed("edit", { path: "a.ts" }, { content: "Edited a.ts" })
    await started.after(event)
    assert.match(event.result.content, /other\.ts/)
    assert.doesNotMatch(event.result.content, /secret\.ts|linked\.ts|missing\.ts|ERROR outside/)
  } finally {
    await cleanup?.()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("didSave respects disabled, omitted, numeric, boolean, and object capabilities", async () => {
  for (const [sync, sendsSave, includesText] of [
    [{ openClose: true, change: 1, save: false }, false, false],
    [{ openClose: true, change: 1 }, false, false],
    [1, false, false],
    [2, false, false],
    [{ openClose: true, change: 1, save: true }, true, false],
    [{ openClose: true, change: 1, save: {} }, true, false],
    [{ openClose: true, change: 1, save: { includeText: true } }, true, true],
  ]) {
    const root = await project(structuredClone(FAKE))
    const log = join(root, "server.log")
    const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
    config.lsp.fake.env = { FAKE_SYNC: JSON.stringify(sync), FAKE_LOG: log }
    await writeFile(join(root, "opencode.json"), JSON.stringify(config))
    const { after, cleanup } = await start(root)
    try {
      await writeFile(join(root, "a.ts"), "ERROR here\n")
      await after(completed("edit", { path: "a.ts" }, { content: "Edited a.ts" }))
      const saved = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse).filter((entry) => entry.method === "textDocument/didSave")
      assert.equal(saved.length, sendsSave ? 1 : 0, JSON.stringify(sync))
      if (sendsSave) assert.equal(saved[0].text, includesText ? "ERROR here\n" : undefined)
    } finally {
      await cleanup()
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("OpenCode 1's watched-files announcement precedes document notifications, and incremental servers get whole-document range replacements", async () => {
  const root = await project(structuredClone(FAKE))
  const log = join(root, "server.log")
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.fake.env = { FAKE_SYNC: JSON.stringify({ openClose: true, change: 2, save: false }), FAKE_LOG: log }
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const { after, cleanup } = await start(root)
  try {
    await writeFile(join(root, "a.ts"), "one\nERROR two\n")
    await after(completed("edit", { path: "a.ts" }, { content: "Edited a.ts" }))
    await writeFile(join(root, "a.ts"), "one\nERROR two\nthree\n")
    await after(completed("edit", { path: "a.ts" }, { content: "Edited a.ts" }))
    const entries = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse).filter((entry) => entry.method !== "initialize")
    assert.deepEqual(
      entries.map((entry) => entry.method),
      ["workspace/didChangeWatchedFiles", "textDocument/didOpen", "workspace/didChangeWatchedFiles", "textDocument/didChange"],
      "the watched-files event must precede each document notification",
    )
    assert.deepEqual(entries[0].watchTypes, [1], "the first announcement is Created")
    assert.deepEqual(entries[2].watchTypes, [2], "the second announcement is Changed")
    assert.deepEqual(entries[3].changeRange, { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, "the incremental change must replace the text the server holds")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("dynamically registered pull diagnostics are requested with the registered identifier", async () => {
  const root = await project(structuredClone(FAKE))
  const log = join(root, "server.log")
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.fake.env = { FAKE_REG: "1", FAKE_LOG: log }
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const { after, cleanup } = await start(root)
  try {
    await writeFile(join(root, "d.ts"), "fine\n")
    const event = completed("edit", { path: "d.ts" }, { content: "Edited d.ts" })
    const started = Date.now()
    await after(event)
    assert.match(event.result.content, /ERROR \[1:1\] bad 0/, "the registered identifier's report must reach the edit result")
    assert.ok(Date.now() - started < 2_000, "the registered pull must answer, not the push timeout")
    const pulls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse).filter((entry) => entry.method === "textDocument/diagnostic")
    assert.ok(pulls.some((entry) => entry.identifier === "registered"), "the registered identifier must be pulled alongside the base provider")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("workspace/configuration answers from the initialization options, v1's configurationValue semantics", async () => {
  const root = await project(structuredClone(FAKE))
  const log = join(root, "server.log")
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.fake.env = { FAKE_LOG: log, FAKE_CONFIG: "1" }
  config.lsp.fake.initialization = { python: { pythonPath: "/venv/bin/python" } }
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const { lsp, cleanup } = await start(root)
  try {
    await writeFile(join(root, "c.ts"), "ok\n")
    await lsp.execute({ operation: "hover", path: "c.ts", line: 1, character: 1 }, {})
    const entry = await waitForLog(log, "configuration-reply")
    assert.deepEqual(entry.config, [
      { python: { pythonPath: "/venv/bin/python" } },
      { pythonPath: "/venv/bin/python" },
      "/venv/bin/python",
      null,
    ], "no section returns the whole options, sections walk them, and a missing path answers null")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("workspace/configuration answers null everywhere when the server has no initialization options", async () => {
  const root = await project(structuredClone(FAKE))
  const log = join(root, "server.log")
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.fake.env = { FAKE_LOG: log, FAKE_CONFIG: "1" }
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const { lsp, cleanup } = await start(root)
  try {
    await writeFile(join(root, "c.ts"), "ok\n")
    await lsp.execute({ operation: "hover", path: "c.ts", line: 1, character: 1 }, {})
    const entry = await waitForLog(log, "configuration-reply")
    assert.deepEqual(entry.config, [null, null, null, null], "v1's configurationValue(undefined, section) is always null")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("navigation keeps the healthy server's answers when a co-serving server errors", async () => {
  // OpenCode 1 caught each client's failure separately, so one broken server among
  // several for the same file must not sink the request.
  const root = await project(structuredClone(FAKE))
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.failing = { command: ["FAKE"], extensions: [".ts"], env: { FAKE_FAIL_NAV: "1" } }
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const { lsp, cleanup } = await start(root)
  try {
    await writeFile(join(root, "a.ts"), "ok\n")
    const hover = await lsp.execute({ operation: "hover", path: "a.ts", line: 1, character: 1 }, {})
    assert.match(hover.content, /hover 0:0/, "the healthy server's hover must survive the failing one")
    const definition = await lsp.execute({ operation: "goToDefinition", path: "a.ts", line: 1, character: 1 }, {})
    assert.match(definition.content, /a\.ts:6:4/, "the healthy server's definition must survive the failing one")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("navigation explains the failure when every server for the file errors", async () => {
  const root = await project(structuredClone(FAKE))
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.fake.env = { FAKE_FAIL_NAV: "1" }
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const { lsp, cleanup } = await start(root)
  try {
    await writeFile(join(root, "a.ts"), "ok\n")
    await assert.rejects(
      lsp.execute({ operation: "hover", path: "a.ts", line: 1, character: 1 }, {}),
      /nav down/,
      "a total failure must still be explained, not swallowed like OpenCode 1 swallowed it",
    )
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("messages framed with LF-only header endings are parsed like CRLF ones", async () => {
  const root = await project(structuredClone(FAKE))
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.fake.env = { FAKE_LF: "1" }
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const { lsp, after, cleanup } = await start(root)
  try {
    await writeFile(join(root, "a.ts"), "ERROR broken\n")
    const event = completed("edit", { path: "a.ts" }, { content: "Edited a.ts" })
    await after(event)
    assert.match(event.result.content, /ERROR \[1:1\] bad 0/, "diagnostic pushes over LF-framed messages must arrive")
    const hover = await lsp.execute({ operation: "hover", path: "a.ts", line: 1, character: 1 }, {})
    assert.match(hover.content, /hover 0:0/, "responses over LF-framed messages must arrive")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("workspaceSymbol keeps OpenCode 1's meaningful kinds and drops file/package noise", async () => {
  const root = await project(structuredClone(FAKE))
  const { lsp, cleanup } = await start(root)
  try {
    await writeFile(join(root, "a.ts"), "ok\n")
    const result = await lsp.execute({ operation: "workspaceSymbol", path: "a.ts", query: "kinds" }, {})
    assert.match(result.content, /Cls \(class\) lib\/x\.ts:10:1/)
    assert.match(result.content, /fn \(function\) lib\/x\.ts:10:1/)
    assert.doesNotMatch(result.content, /FileThing|Container/, "file and package kinds must be filtered like OpenCode 1 filtered them")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("already-aborted navigation does not start a server", async () => {
  const root = await project(structuredClone(FAKE))
  const log = join(root, "server.log")
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.fake.env = { FAKE_LOG: log }
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const { lsp, cleanup } = await start(root)
  try {
    await writeFile(join(root, "a.ts"), "fine\n")
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(lsp.execute({ operation: "hover", path: "a.ts", line: 1, character: 1 }, { signal: controller.signal }), { name: "AbortError" })
    await assert.rejects(readFile(log), { code: "ENOENT" })
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("already-aborted sync returns a rejected promise without starting a server", async () => {
  const root = await project(structuredClone(FAKE))
  const settings = resolveSettings(root, {}, { OPENCODE_CONFIG_DIR: join(root, "no-global") })
  const manager = new LspManager(settings, root)
  try {
    const controller = new AbortController()
    const reason = new Error("cancelled before sync")
    controller.abort(reason)
    const pending = manager.sync(join(root, "a.ts"), controller.signal)
    assert.ok(pending instanceof Promise)
    await assert.rejects(pending, (error) => error === reason)
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

test("cancelling an in-flight request sends cancelRequest and keeps the server usable", async () => {
  const root = await project(structuredClone(FAKE))
  const log = join(root, "server.log")
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.fake.env = { FAKE_LOG: log, FAKE_HOVER_DELAY: "2000" }
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const { lsp, cleanup } = await start(root)
  try {
    await writeFile(join(root, "a.ts"), "fine\n")
    const controller = new AbortController()
    const pending = lsp.execute({ operation: "hover", path: "a.ts", line: 1, character: 1 }, { signal: controller.signal })
    const rejected = assert.rejects(pending, { name: "AbortError" })
    await waitForLog(log, "textDocument/hover")
    const began = Date.now()
    controller.abort()
    await rejected
    assert.ok(Date.now() - began < 1_000, "cancellation must not wait for the server's reply")
    const cancel = await waitForLog(log, "$/cancelRequest")
    assert.equal(typeof cancel.id, "number")
    const symbols = await lsp.execute({ operation: "documentSymbol", path: "a.ts" }, {})
    assert.match(symbols.content, /Outer/)
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("cancelling cold navigation interrupts push and pull diagnostic waits", async () => {
  for (const pull of [false, true]) {
    const root = await project(structuredClone(FAKE))
    const log = join(root, "server.log")
    const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
    config.lsp.fake.env = { FAKE_LOG: log, ...(pull ? { FAKE_PULL: "1" } : {}) }
    await writeFile(join(root, "opencode.json"), JSON.stringify(config))
    const { lsp, cleanup } = await start(root)
    try {
      await writeFile(join(root, "a.ts"), pull ? "ERROR SLOWPULL\n" : "SILENT\n")
      const controller = new AbortController()
      const pending = lsp.execute({ operation: "hover", path: "a.ts", line: 1, character: 1 }, { signal: controller.signal })
      const rejected = assert.rejects(pending, { name: "AbortError" })
      await waitForLog(log, pull ? "textDocument/diagnostic" : "textDocument/didOpen")
      const began = Date.now()
      controller.abort()
      await rejected
      assert.ok(Date.now() - began < 1_000, "cancellation must not wait for diagnostic warm-up")
      if (pull) await waitForLog(log, "$/cancelRequest")
      await writeFile(join(root, "a.ts"), "fine\n")
      assert.match((await lsp.execute({ operation: "documentSymbol", path: "a.ts" }, {})).content, /Outer/)
    } finally {
      await cleanup()
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("cancelling startup does not break another caller's shared server", async () => {
  const root = await project(structuredClone(FAKE))
  const log = join(root, "server.log")
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.fake.env = { FAKE_LOG: log, FAKE_INIT_DELAY: "500" }
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const { lsp, cleanup } = await start(root)
  try {
    await writeFile(join(root, "a.ts"), "fine\n")
    await writeFile(join(root, "b.ts"), "fine\n")
    const controller = new AbortController()
    const pending = lsp.execute({ operation: "hover", path: "a.ts", line: 1, character: 1 }, { signal: controller.signal })
    const rejected = assert.rejects(pending, { name: "AbortError" })
    await waitForLog(log, "initialize")
    controller.abort()
    await rejected
    assert.match((await lsp.execute({ operation: "documentSymbol", path: "b.ts" }, {})).content, /Outer/)
    const sent = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse)
    assert.equal(sent.filter((entry) => entry.method === "initialize").length, 1)
    assert.ok(!sent.some((entry) => entry.uri === pathToFileURL(join(root, "a.ts")).href))
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("cancelled multi-server startup keeps prior diagnostic versions valid", async () => {
  const root = await project({
    first: { command: ["FAKE"], extensions: [".ts"] },
    second: { command: ["FAKE"], extensions: [".alt"] },
  })
  const firstLog = join(root, "first.log")
  const secondLog = join(root, "second.log")
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.first.env = { FAKE_LOG: firstLog }
  config.lsp.second.env = { FAKE_LOG: secondLog, FAKE_INIT_DELAY: "500" }
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const settings = resolveSettings(root, {}, { OPENCODE_CONFIG_DIR: join(root, "no-global") })
  const manager = new LspManager(settings, root)
  try {
    const file = join(root, "a.ts")
    await writeFile(file, "ERROR DELAYED\n")
    const pendingDiagnostics = manager.diagnostics(file, 1_200)
    await waitForLog(firstLog, "textDocument/didOpen")
    // Make a second, cold server applicable while the first's report is in flight.
    settings.servers.find((server) => server.id === "second").extensions.push(".ts")
    const controller = new AbortController()
    const rejected = assert.rejects(manager.sync(file, controller.signal), { name: "AbortError" })
    await waitForLog(secondLog, "initialize")
    controller.abort()
    await rejected
    const report = await pendingDiagnostics
    assert.equal(report.file?.length, 1, "a cancelled sync must not invalidate the first server's pending report")
    const firstSent = (await readFile(firstLog, "utf8")).trim().split("\n").map(JSON.parse)
    assert.equal(firstSent.filter((entry) => entry.method === "textDocument/didChange").length, 0)
    const synced = await manager.sync(file)
    assert.ok(synced.every(({ version }) => version === 2), "a cancelled sync must not consume a version")
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

test("aborting after a completed request does not send a cancellation", async () => {
  const root = await project(structuredClone(FAKE))
  const log = join(root, "server.log")
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.fake.env = { FAKE_LOG: log }
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const { lsp, cleanup } = await start(root)
  try {
    await writeFile(join(root, "a.ts"), "fine\n")
    const controller = new AbortController()
    assert.equal((await lsp.execute({ operation: "hover", path: "a.ts", line: 1, character: 1 }, { signal: controller.signal })).content, "hover 0:0")
    controller.abort()
    await lsp.execute({ operation: "documentSymbol", path: "a.ts" }, {})
    const sent = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse)
    assert.ok(!sent.some((entry) => entry.method === "$/cancelRequest"))
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("cancellation stops transient-error retry delays", async () => {
  const controller = new AbortController()
  const reason = new Error("custom cancellation reason")
  let attempts = 0
  const client = { request: async () => {
    attempts++
    throw new LspError("still loading", -32802)
  } }
  const timer = setTimeout(() => controller.abort(reason), 50)
  try {
    await assert.rejects(requestWithRetry(client, "textDocument/hover", {}, controller.signal), (error) => error === reason)
    assert.equal(attempts, 1)
  } finally {
    clearTimeout(timer)
  }
})

test("settings follow OpenCode 2's config precedence and deep merge, then plugin options", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-lsp-config-"))
  try {
    const global = join(root, "global")
    const repo = join(root, "repo")
    const nested = join(repo, "pkg")
    await mkdir(global, { recursive: true })
    await mkdir(join(repo, ".opencode"), { recursive: true })
    await mkdir(nested, { recursive: true })
    await writeFile(join(global, "opencode.json"), JSON.stringify({ lsp: { pyright: { command: ["{env:PYRIGHT_BIN}", "--stdio"] }, gopls: { command: ["gopls"], initialization: { ui: { staticcheck: true, codelenses: ["test"] } } }, alias: { disabled: true } } }))
    await writeFile(join(repo, "gopls-bin"), "  /opt/go\"pls\n")
    await writeFile(join(repo, "opencode.jsonc"), '{\n  // comment {file:missing}\n  "lsp": { "gopls": { "command": ["{file:gopls-bin}", "serve"], "initialization": { "ui": { "gofumpt": true, "codelenses": [] } } }, },\n}\n')
    await writeFile(join(nested, "yaml-bin"), "yaml-language-server\n")
    await writeFile(join(repo, ".opencode", "opencode.json"), JSON.stringify({ lsp: { pyright: { disabled: true } } }))
    await writeFile(join(nested, "opencode.json"), JSON.stringify({ lsp: { custom: { command: ["custom-ls"] } } }))
    const env = { PYRIGHT_BIN: "/opt/pyright", OPENCODE_CONFIG_DIR: global, OPENCODE_CONFIG_CONTENT: JSON.stringify({ lsp: { yaml: { command: ["{file:yaml-bin}"], extensions: [".YML", ".yaml"] } } }) }

    const settings = resolveSettings(nested, { diagnosticsTimeoutMs: 1_000 }, env)
    assert.deepEqual(
      settings.servers.map(({ id, command, extensions }) => ({ id, command, extensions })),
      [
        { id: "gopls", command: ['/opt/go"pls', "serve"], extensions: [".go"] },
        // OpenCode 1 kept a configured custom ID with no extensions and applied it to every file.
        { id: "custom", command: ["custom-ls"], extensions: [] },
        { id: "yaml", command: ["yaml-language-server"], extensions: [".yml", ".yaml"] },
      ],
    )
    assert.deepEqual(settings.servers[0].initialization, { ui: { staticcheck: true, gofumpt: true, codelenses: [] } })
    assert.equal(settings.diagnosticsTimeoutMs, 1_000)
    assert.equal(settings.diagnostics, true)
    assert.deepEqual(resolveSettings(nested, { lsp: false }, env).servers, [])
    assert.deepEqual(
      resolveSettings(nested, {}, { ...env, OPENCODE_CONFIG_PROJECT_DISABLE: "1" }).servers.map((server) => [server.id, server.command[0]]),
      [["pyright", "/opt/pyright"], ["gopls", "gopls"], ["yaml", "yaml-language-server"]],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("auto-discovery enables installed built-ins implicitly; declared `lsp` IDs (even disabled) own themselves", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-lsp-discover-")))
  try {
    const bin = join(root, "bin")
    await mkdir(bin)
    const installed = ["bash-language-server", "gopls", "pyright-langserver", "texlab", "ty"]
    for (const name of installed) await writeFile(join(bin, name), "#!/bin/sh\n")
    for (const name of installed) await chmod(join(bin, name), 0o755)
    await mkdir(join(root, ".venv", "bin"), { recursive: true })
    await writeFile(join(root, ".venv", "bin", "python"), "#!/bin/sh\n")
    await chmod(join(root, ".venv", "bin", "python"), 0o755)
    await writeFile(join(root, "opencode.json"), JSON.stringify({ lsp: { texlab: { disabled: true }, gopls: { command: ["custom-gopls"] } } }))
    const env = { PATH: bin, OPENCODE_CONFIG_DIR: join(root, "no-global") }
    const servers = resolveSettings(root, {}, env).servers
    assert.deepEqual(
      servers.map(({ id, command }) => [id, command]),
      [
        ["gopls", ["custom-gopls"]],
        ["pyright", [join(bin, "pyright-langserver"), "--stdio"]],
        ["bash", [join(bin, "bash-language-server"), "start"]],
      ],
    )
    const pyright = servers.find((server) => server.id === "pyright")
    assert.deepEqual(pyright.initialization, { pythonPath: join(root, ".venv", "bin", "python") })
    assert.deepEqual(servers.find((server) => server.id === "bash").extensions, [".sh", ".bash", ".zsh", ".ksh"])
    assert.deepEqual(
      resolveSettings(root, { discover: false }, env).servers.map(({ id, command }) => [id, command]),
      [["gopls", ["custom-gopls"]]],
    )
    assert.deepEqual(
      resolveSettings(root, { experimentalTy: true }, env).servers.map(({ id, command }) => [id, command]),
      [
        ["gopls", ["custom-gopls"]],
        ["ty", [join(bin, "ty"), "server"]],
        ["bash", [join(bin, "bash-language-server"), "start"]],
      ],
    )
    const bare = await mkdtemp(join(tmpdir(), "opencode-lsp-unset-"))
    assert.deepEqual(resolveSettings(bare, {}, { PATH: bin, OPENCODE_CONFIG_DIR: join(root, "no-global") }).servers, [])
    await rm(bare, { recursive: true, force: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("download option marks every fetchable built-in as pending without fetching anything", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-lsp-download-")))
  try {
    await writeFile(join(root, "opencode.json"), JSON.stringify({ lsp: true }))
    const bin = join(root, "bin")
    await mkdir(bin)
    const env = { PATH: bin, OPENCODE_CONFIG_DIR: join(root, "no-global") }
    const settings = resolveSettings(root, { download: true }, env)
    assert.equal(settings.binDir, join(homedir(), ".cache", "opencode-lsp-bin"))
    assert.deepEqual(
      settings.servers.map(({ id }) => id).sort(),
      ["astro", "bash", "biome", "csharp", "dockerfile", "fsharp", "gopls", "lua-ls", "php intelephense", "pyright", "svelte", "terraform", "texlab", "typescript", "vue", "yaml-ls", "zls"],
    )
    const pyright = settings.servers.find((server) => server.id === "pyright")
    assert.deepEqual(pyright.command, [])
    assert.equal(pyright.download, true)
    assert.deepEqual(pyright.extensions, [".py", ".pyi"])
    assert.deepEqual(resolveSettings(root, {}, env).servers, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("ensureServer fetches a marked server lazily through its installer and reuses the binary", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-lsp-fetch-")))
  try {
    const stub = join(root, "stub")
    await mkdir(stub)
    await writeFile(join(stub, "npm"),
      "#!/usr/bin/env node\n" +
      "const fs = require(\"node:fs\")\n" +
      "const argv = process.argv.slice(2)\n" +
      "if (argv[0] !== \"install\" || !argv.includes(\"--ignore-scripts\") || !argv.includes(\"--global\") || !argv.includes(\"--prefix\")) process.exit(1)\n" +
      "const pkg = argv[1]\n" +
      "const prefix = argv[argv.indexOf(\"--prefix\") + 1]\n" +
      "fs.mkdirSync(prefix + \"/bin\", { recursive: true })\n" +
      "const bin = pkg === \"pyright\" ? \"pyright-langserver\" : pkg\n" +
      "fs.writeFileSync(prefix + \"/bin/\" + bin, \"#!/bin/sh\\nexit 0\\n\")\n" +
      "fs.chmodSync(prefix + \"/bin/\" + bin, 0o755)\n")
    await chmod(join(stub, "npm"), 0o755)
    const marker = { id: "pyright", command: [], extensions: [".py", ".pyi"], env: {}, download: true }
    const binDir = join(root, "lsp-bin")
    const env = { ...process.env, PATH: `${stub}:${dirname(process.execPath)}` }
    const command = await ensureServer(marker, binDir, env)
    assert.deepEqual(command, [join(binDir, "pyright", "bin", "pyright-langserver"), "--stdio"])
    assert.deepEqual(await ensureServer(marker, binDir, env), command)
    const configured = { id: "custom", command: ["python3", "lsp"], extensions: [".py"], env: {} }
    assert.deepEqual(await ensureServer(configured, binDir, env), ["python3", "lsp"])
    let failure
    try {
      await ensureServer(marker, join(root, "empty-bin"), { PATH: join(root, "nothing") })
    } catch (error) {
      failure = error
    }
    assert.ok(failure)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("binDir defaults to the cache directory, expands ~/ to the home directory, and resolves relative values", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-lsp-bindir-"))
  try {
    const env = { OPENCODE_CONFIG_DIR: join(root, "no-global") }
    assert.equal(resolveSettings(root, {}, env).binDir, join(homedir(), ".cache", "opencode-lsp-bin"))
    assert.equal(resolveSettings(root, { binDir: "" }, env).binDir, join(homedir(), ".cache", "opencode-lsp-bin"))
    assert.equal(resolveSettings(root, { binDir: "~/lsp-bins" }, env).binDir, join(homedir(), "lsp-bins"))
    assert.equal(resolveSettings(root, { binDir: "relative-lsp-bins" }, env).binDir, join(process.cwd(), "relative-lsp-bins"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the zls tar flow fetches the per-platform asset and unpacks the root-level binary", async () => {
  if (process.platform !== "linux" || process.arch !== "x64") return
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-lsp-zls-")))
  try {
    const asset = "zls-x86_64-linux.tar.xz"
    const payload = join(root, "payload")
    await mkdir(payload)
    await writeFile(join(payload, "zls"), "#!/bin/sh\nexit 0\n")
    await chmod(join(payload, "zls"), 0o755)
    const archive = join(root, asset)
    const made = spawnSync("tar", ["-cJf", archive, "-C", payload, "zls"], { stdio: "pipe" })
    assert.equal(made.status, 0, "GNU tar with xz support is required for this case")
    const bytes = await readFile(archive)
    const realFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url) => {
      const u = String(url)
      calls.push(u)
      if (u === `https://api.github.com/repos/zigtools/zls/releases/latest`) {
        return new Response(JSON.stringify({ assets: [
          { name: asset, browser_download_url: `https://example.invalid/${asset}` },
          // A .minisig decoy that must not match the asset suffix.
          { name: `${asset}.minisig`, browser_download_url: `https://example.invalid/${asset}.minisig` },
        ] }))
      }
      if (u === `https://example.invalid/${asset}`) return new Response(bytes)
      throw new Error(`unexpected fetch ${u}`)
    }
    const binDir = join(root, "lsp-bin")
    const stubBin = join(root, "stub-bin")
    await mkdir(stubBin)
    const noToolchain = join(root, "void-bin")
    await mkdir(noToolchain)
    try {
      // v1 refused to fetch zls without the zig toolchain; the precondition must hold.
      await assert.rejects(
        () => ensureServer({ id: "zls", command: [], extensions: [".zig"], env: {}, download: true }, join(binDir, "no-zig"), { PATH: noToolchain }),
        /zig is not installed/,
      )
      const zig = join(stubBin, "zig")
      await writeFile(zig, "#!/bin/sh\nexit 0\n")
      await chmod(zig, 0o755)
      const command = await ensureServer({ id: "zls", command: [], extensions: [".zig"], env: {}, download: true }, binDir, { ...process.env, PATH: `${stubBin}:${process.env.PATH}` })
      assert.deepEqual(command, [join(binDir, "zls", "zls")])
      assert.equal(await access(join(binDir, "zls", "zls"), constants.CAN_EXECUTE).then(() => true, () => false), true, "the unpacked zls binary must be executable")
      assert.deepEqual(calls, [`https://api.github.com/repos/zigtools/zls/releases/latest`, `https://example.invalid/${asset}`])
    } finally {
      globalThis.fetch = realFetch
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the hashicorp flow downloads the platform build named by the releases API", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-lsp-hashicorp-")))
  try {
    const arch = process.arch === "arm64" ? "arm64" : "amd64"
    const platform = process.platform === "win32" ? "windows" : process.platform
    const expected = `https://releases.hashicorp.com/terraform-ls/0.39.0/terraform-ls_0.39.0_${platform}_${arch}.zip`
    const realFetch = globalThis.fetch
    let requested
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u === "https://api.releases.hashicorp.com/v1/releases/terraform-ls/latest") {
        return new Response(JSON.stringify({ version: "0.39.0", builds: [{ arch, os: platform, url: expected }] }))
      }
      requested = u
      throw new Error("stop once the build url is requested")
    }
    const binDir = join(root, "lsp-bin")
    let failure
    try {
      await ensureServer({ id: "terraform", command: [], extensions: [".tf"], env: {}, download: true }, binDir, { ...process.env })
    } catch (error) {
      failure = error
    } finally {
      globalThis.fetch = realFetch
    }
    assert.equal(requested, expected, "the generic <name>_<version>.zip URL 404s; the build url from the API is the real one")
    assert.ok(failure, "the flow must fail once the build download is refused")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("shutdown clears rows for servers that failed to start", async () => {
  const root = await project({ broken: { command: ["/nonexistent/lsp-binary"], extensions: [".ts"] } })
  const { after, cleanup, emitted, status } = await start(root)
  try {
    await writeFile(join(root, "f.ts"), "ERROR\n")
    const event = completed("edit", { path: "f.ts" }, { content: "Edited f.ts" })
    await after(event)
    assert.ok(emitted.some((entry) => entry.name === "failed" && entry.data.id === "broken"), "the failed start must be reported")
    assert.deepEqual(await status(), { configured: true, servers: [{ id: "broken", root, status: "broken" }] })
    await cleanup()
    assert.ok(emitted.some((entry) => entry.name === "shutdown" && entry.data.id === "broken"), "shutdown must clear the broken row")
    assert.deepEqual(await status(), { configured: true, servers: [] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("typescript and astro get the workspace's tsserver passed to them; without one they do not start", async () => {
  // With a resolvable typescript in the project, the resolved tsserver is handed to the server.
  const root = await project({ typescript: { command: ["FAKE"], env: { FAKE_LOG: "LOG" } } })
  const log = join(root, "lsp.log")
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"))
  config.lsp.typescript.env.FAKE_LOG = log
  await writeFile(join(root, "opencode.json"), JSON.stringify(config))
  const tsserver = join(root, "node_modules", "typescript", "lib", "tsserver.js")
  await mkdir(join(root, "node_modules", "typescript", "lib"), { recursive: true })
  await writeFile(join(root, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", version: "5.9.0" }))
  await writeFile(tsserver, "module.exports = {}")
  const { after, status, cleanup } = await start(root)
  try {
    await writeFile(join(root, "a.ts"), "ERROR\n")
    await after(completed("write", { path: "a.ts" }, { content: "Wrote a.ts" }))
    const init = await waitForLog(log, "initialize")
    assert.deepEqual(init.initializationOptions?.tsserver, { path: tsserver })
    assert.deepEqual(await status(), { configured: true, servers: [{ id: "typescript", root, status: "connected" }] })
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }

  // Without a resolvable typescript the server does not start and leaves no row behind.
  const bare = await project({ typescript: { command: ["FAKE"] } })
  const { after: bareAfter, lsp, emitted, status: bareStatus, cleanup: bareCleanup } = await start(bare)
  try {
    await writeFile(join(bare, "a.ts"), "ERROR\n")
    await bareAfter(completed("write", { path: "a.ts" }, { content: "Wrote a.ts" }))
    assert.deepEqual(await bareStatus(), { configured: true, servers: [] })
    assert.ok(!emitted.some((entry) => entry.name === "failed"), "no failed row without a workspace tsserver")
    await assert.rejects(lsp.execute({ operation: "hover", path: "a.ts", line: 1, character: 1 }, {}), /tsserver\.js/)
  } finally {
    await bareCleanup()
    await rm(bare, { recursive: true, force: true })
  }
})

let failed = 0
for (const { name, run } of cases) {
  try {
    await run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}\n${error?.stack ?? error}`)
  }
}
if (failed) {
  console.log(`FAIL - ${failed} of ${cases.length} OpenCode LSP plugin cases`)
  process.exit(1)
}
console.log("PASS - OpenCode LSP plugin restores OpenCode 1 diagnostics and the lsp tool")
