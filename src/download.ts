/**
 * OpenCode 1's other half: with the plugin option `download: true`, a built-in
 * server that is neither configured nor on PATH is fetched on first use into a
 * plugin-owned bin dir (default ~/.cache/opencode-lsp-bin, `binDir` overrides).
 * The npm, GitHub-release, hashicorp, dotnet-tool, and go-install flows are
 * ported from OpenCode 1's server.ts; the flows OpenCode 1 had to compile
 * (elixir-ls via mix, jdtls/Eclipse, kotlin-ls, eslint's server bundle), the
 * macOS-only sourcekit-lsp, and language-toolchain installs (deno, dart,
 * julia, opam) are skipped. Extraction assumes tar/unzip exist on PATH.
 */
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { findOnPath } from "./discover.ts"
import type { ServerConfig } from "./config.ts"

export const DEFAULT_BIN_DIR = join(homedir(), ".cache", "opencode-lsp-bin")

/**
 * Installs can be slow (a cold `go install` compiles from source); bound them
 * so a stalled network or tool cannot wedge the first edit, plugin unload, or
 * the sidebar's starting row forever.
 */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

const fetchWithTimeout = (url: string, init?: RequestInit): Promise<Response> =>
  fetch(url, { ...init, signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) })

/**
 * V1's exact per-platform asset names. The tar flow only extracts the
 * tarball platforms; elsewhere the spec has no asset and the failure names
 * the platform instead of trying a download.
 */
const zlsAsset: string | undefined =
  process.platform === "linux" || process.platform === "darwin"
    ? `zls-${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch === "ia32" ? "x86" : process.arch}-${process.platform === "darwin" ? "macos" : "linux"}.tar.xz`
    : undefined
const texlabAsset: string | undefined =
  process.platform === "linux" || process.platform === "darwin"
    ? `texlab-${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "macos" : "linux"}.tar.gz`
    : undefined
const lualsAsset: string | undefined =
  (process.platform === "linux" || process.platform === "darwin") && (process.arch === "x64" || process.arch === "arm64")
    ? `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`
    : undefined

interface DownloadSpec {
  readonly args: string[]
  readonly install: "npm" | "dotnet" | "tar" | "hashicorp" | "go"
  /** npm package spec; the bin name is `binary`. */
  readonly pkg?: string
  /** dotnet tool name. */
  readonly tool?: string
  readonly prerelease?: boolean
  /** GitHub repo; the release asset ending in `asset` is unpacked. */
  readonly repo?: string
  readonly asset?: string
  /** hashicorp release name. */
  /** Tool that must already be on PATH before the download is attempted (v1's precondition). */
  readonly requires?: string
  /** Binary file name under the per-server install dir. */
  binary?: string
  /** Binary location relative to the per-server install dir. */
  path?: string[]
}

const DOWNLOADS: Record<string, DownloadSpec> = {
  typescript: { install: "npm", pkg: "typescript-language-server", binary: "typescript-language-server", path: ["bin", "typescript-language-server"], args: ["--stdio"] },
  vue: { install: "npm", pkg: "@vue/language-server", binary: "vue-language-server", path: ["bin", "vue-language-server"], args: ["--stdio"] },
  pyright: { install: "npm", pkg: "pyright", binary: "pyright-langserver", path: ["bin", "pyright-langserver"], args: ["--stdio"] },
  // Unscoped `biomejs` on npm is a squatted 0.0.0 placeholder with no CLI.
  biome: { install: "npm", pkg: "@biomejs/biome", binary: "biome", path: ["bin", "biome"], args: ["lsp-proxy", "--stdio"] },
  "yaml-ls": { install: "npm", pkg: "yaml-language-server", binary: "yaml-language-server", path: ["bin", "yaml-language-server"], args: ["--stdio"] },
  svelte: { install: "npm", pkg: "svelte-language-server", binary: "svelteserver", path: ["bin", "svelteserver"], args: ["--stdio"] },
  astro: { install: "npm", pkg: "@astrojs/language-server", binary: "astro-ls", path: ["bin", "astro-ls"], args: ["--stdio"] },
  "php intelephense": { install: "npm", pkg: "intelephense", binary: "intelephense", path: ["bin", "intelephense"], args: ["--stdio"] },
  bash: { install: "npm", pkg: "bash-language-server", binary: "bash-language-server", path: ["bin", "bash-language-server"], args: ["start"] },
  dockerfile: { install: "npm", pkg: "dockerfile-language-server-nodejs", binary: "docker-langserver", path: ["bin", "docker-langserver"], args: ["--stdio"] },
  csharp: { install: "dotnet", tool: "roslyn-language-server", prerelease: true, binary: "roslyn-language-server", path: ["roslyn-language-server"], args: ["--stdio", "--autoLoadProjects"] },
  fsharp: { install: "dotnet", tool: "fsautocomplete", binary: "fsautocomplete", path: ["fsautocomplete"], args: [] },
  // V1's exact per-platform asset names; the zls tarball holds the binary at its root.
  // v1 required zig on PATH before fetching zls, since zls is useless without the toolchain.
  zls: { install: "tar", repo: "zigtools/zls", asset: zlsAsset, requires: "zig", binary: "zls", path: ["zls"], args: [] },
  "lua-ls": { install: "tar", repo: "LuaLS/lua-language-server", asset: lualsAsset, binary: "lua-language-server", path: ["bin", "lua-language-server"], args: [] },
  texlab: { install: "tar", repo: "latex-lsp/texlab", asset: texlabAsset, binary: "texlab", path: ["texlab"], args: [] },
  terraform: { install: "hashicorp", pkg: "terraform-ls", binary: "terraform-ls", path: ["terraform-ls"], args: ["serve"] },
  gopls: { install: "go", binary: "gopls", path: ["gopls"], args: [] },
}

export function hasDownloadSpec(id: string): boolean {
  return Object.hasOwn(DOWNLOADS, id)
}

async function isExecutable(file: string): Promise<boolean> {
  return access(file, constants.CAN_EXECUTE).then(() => true, () => false)
}

async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv, extra: Record<string, string>): Promise<void> {
  const [file, ...args] = command
  const proc = spawn(file, args, { cwd, env: { ...env, ...extra }, stdio: "ignore" })
  let spawnError: unknown
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGKILL")
  }, INSTALL_TIMEOUT_MS)
  const code = await new Promise((resolve) => {
    proc.on("exit", (exit) => resolve(exit))
    proc.on("error", (error) => {
      spawnError = error
      resolve(undefined)
    })
  })
  clearTimeout(timer)
  if (spawnError) throw new Error(`${command.join(" ")}: ${spawnError}`)
  if (timedOut) throw new Error(`${command.join(" ")} timed out after ${INSTALL_TIMEOUT_MS / 1000}s`)
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code ?? "signal"}`)
}

async function readBytes(stream: unknown): Promise<Uint8Array> {
  const reader = (stream as any).getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Latest GitHub release asset unpacked into `dir`; tar keeps member modes. */
async function githubAsset(spec: DownloadSpec, dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const asset = spec.asset
  if (!asset) throw new Error(`${spec.repo} has no release asset for ${process.platform}/${process.arch}`)
  if (asset.endsWith(".zip")) throw new Error(`${spec.repo}'s ${asset} is a zip, but this flow only extracts tar archives`)
  const release = await fetchWithTimeout(`https://api.github.com/repos/${spec.repo}/releases/latest`, { headers: { "user-agent": "opencode-v2-lsp-support" } })
  if (!release.ok) throw new Error(`cannot list ${spec.repo} releases: ${release.status}`)
  const assets = (await release.json() as any).assets
  const url = Array.isArray(assets) ? assets.find((item: any) => typeof item?.name === "string" && item.name.endsWith(asset))?.browser_download_url : undefined
  if (!url) throw new Error(`${spec.repo} has no ${asset} release asset`)
  const download = await fetchWithTimeout(url)
  if (!download.ok) throw new Error(`cannot download ${spec.repo} asset: ${download.status}`)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `download.${asset}`)
  await writeFile(tmp, await readBytes(download.body))
  const extract = asset.endsWith(".xz") ? "-xJf" : "-xzf"
  await run(["tar", extract, tmp, "-C", dir], dir, env, {})
  await rm(tmp, { force: true })
}

/** OpenCode 1's flow: the latest hashicorp build for this platform, unpacked into `dir`. */
async function hashicorpAsset(name: string, dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const release = await fetchWithTimeout(`https://api.releases.hashicorp.com/v1/releases/${name}/latest`)
  if (!release.ok) throw new Error(`cannot list ${name} releases: ${release.status}`)
  const builds: any[] = (await release.json() as any).builds ?? []
  const arch = process.arch === "arm64" ? "arm64" : "amd64"
  const platform = process.platform === "win32" ? "windows" : process.platform
  const build = builds.find((item) => item?.arch === arch && item?.os === platform)
  if (typeof build?.url !== "string") throw new Error(`${name} has no ${platform}/${arch} release build`)
  const download = await fetchWithTimeout(build.url)
  if (!download.ok) throw new Error(`cannot download ${name}: ${download.status}`)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, "download.zip")
  await writeFile(tmp, await readBytes(download.body))
  await run(["unzip", "-o", tmp, "-d", dir], dir, env, {})
  await rm(tmp, { force: true })
}

/**
 * Lazy on-demand install: one attempt per server and bin dir; concurrent
 * callers share the in-flight promise, and a resolved binary is reused on the
 * next plugin load without a re-probe.
 */
const installs = new Map<string, Promise<string[]>>()

export async function ensureServer(server: ServerConfig, binDir: string, env = process.env): Promise<string[]> {
  const spec = server.download === true ? DOWNLOADS[server.id] : undefined
  if (!spec) return server.command
  const dir = join(binDir, server.id)
  const exe = join(dir, ...(spec.path as string[]))
  if (await isExecutable(exe)) return [exe, ...spec.args]
  const key = `${binDir}:${server.id}`
  const cached = installs.get(key)
  if (cached) return await cached
  const done = async (): Promise<void> => {
    if (spec.requires && !(await findOnPath(spec.requires, env)))
      throw new Error(`${spec.requires} is not installed; cannot fetch this server`)
    if (spec.install === "npm") {
      const npm = await findOnPath("npm", env)
      if (!npm) throw new Error("npm is not installed; cannot fetch this server")
      await mkdir(dir, { recursive: true })
      // Global mode with a user-writable prefix is what puts binaries in <prefix>/bin;
      // a local --prefix install only makes node_modules/.bin shims. OpenCode 1's
      // Arborist install used ignoreScripts; npm keeps the habit.
      await run([npm, "install", spec.pkg, "--ignore-scripts", "--global", "--prefix", dir], dir, env, {})
    } else if (spec.install === "dotnet") {
      await mkdir(dir, { recursive: true })
      await run(["dotnet", "tool", "install", "--tool-path", dir, ...(spec.prerelease ? ["--prerelease"] : []), spec.tool], dir, env, {})
    } else if (spec.install === "tar") {
      await githubAsset(spec, dir, env)
    } else if (spec.install === "hashicorp") {
      await hashicorpAsset(spec.pkg as string, dir, env)
    } else {
      if (!await findOnPath("go", env)) throw new Error("Go is not installed; cannot fetch gopls")
      await mkdir(dir, { recursive: true })
      await run(["go", "install", "golang.org/x/tools/gopls@latest"], dir, env, { GOBIN: dir })
    }
    if (!await isExecutable(exe)) await chmod(exe, 0o755)
  }
  const promise = done().then(() => [exe, ...spec.args])
  installs.set(key, promise)
  void promise.catch(() => installs.delete(key))
  return await promise
}
