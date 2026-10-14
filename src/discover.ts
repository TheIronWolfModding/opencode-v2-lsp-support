/**
 * OpenCode 1's built-in servers were active with zero config: probe PATH, spawn
 * with fixed args. This is the PATH half of that — nothing downloads a server,
 * only ones already installed on this machine are enabled implicitly. As in
 * OpenCode 1, discovery needs the `lsp` key present (`true` or an object); an
 * ID listed in the merged config (even disabled) is not probed, and `ty` stays
 * behind `experimentalTy` like OpenCode 1's experimentalLspTy flag. Set the
 * plugin option `discover: false` to turn the pass off.
 */
import { accessSync, constants, existsSync } from "node:fs"
import { delimiter, join } from "node:path"
import { BUILTIN_EXTENSIONS } from "./catalog.ts"
import { hasDownloadSpec } from "./download.ts"
import { isRecord } from "./config.ts"
import type { ServerConfig } from "./config.ts"

interface Probe {
  readonly id: string
  readonly binary: string
  readonly args: string[]
  /** V1 pointed pyright/ty at the venv's interpreter. */
  readonly pythonPath?: boolean
  readonly initialization?: Record<string, unknown>
  /** OpenCode 1 gated this server behind a runtime flag. */
  readonly experimental?: boolean
}

const PROBES: Probe[] = [
  { id: "deno", binary: "deno", args: ["lsp"] },
  { id: "typescript", binary: "typescript-language-server", args: ["--stdio"] },
  { id: "vue", binary: "vue-language-server", args: ["--stdio"] },
  // V1 also probed `oxlint --help` for a `--lsp` flag; the dedicated binary is the stable half.
  { id: "oxlint", binary: "oxc_language_server", args: [] },
  { id: "biome", binary: "biome", args: ["lsp-proxy", "--stdio"] },
  { id: "gopls", binary: "gopls", args: [] },
  { id: "ruby-lsp", binary: "rubocop", args: ["--lsp"] },
  { id: "ty", binary: "ty", args: ["server"], pythonPath: true, experimental: true },
  { id: "pyright", binary: "pyright-langserver", args: ["--stdio"], pythonPath: true },
  { id: "elixir-ls", binary: "elixir-ls", args: [] },
  { id: "zls", binary: "zls", args: [] },
  { id: "csharp", binary: "roslyn-language-server", args: ["--stdio", "--autoLoadProjects"] },
  { id: "fsharp", binary: "fsautocomplete", args: [] },
  { id: "sourcekit-lsp", binary: "sourcekit-lsp", args: [] },
  { id: "rust", binary: "rust-analyzer", args: [] },
  { id: "clangd", binary: "clangd", args: ["--background-index", "--clang-tidy"] },
  { id: "svelte", binary: "svelteserver", args: ["--stdio"] },
  { id: "astro", binary: "astro-ls", args: ["--stdio"] },
  { id: "yaml-ls", binary: "yaml-language-server", args: ["--stdio"] },
  { id: "lua-ls", binary: "lua-language-server", args: [] },
  { id: "php intelephense", binary: "intelephense", args: ["--stdio"], initialization: { telemetry: { enabled: false } } },
  { id: "prisma", binary: "prisma", args: ["language-server"] },
  { id: "dart", binary: "dart", args: ["language-server", "--lsp"] },
  { id: "ocaml-lsp", binary: "ocamllsp", args: [] },
  { id: "bash", binary: "bash-language-server", args: ["start"] },
  { id: "terraform", binary: "terraform-ls", args: ["serve"], initialization: { experimentalFeatures: { prefillRequiredFields: true, validateOnSave: true } } },
  { id: "texlab", binary: "texlab", args: [] },
  { id: "dockerfile", binary: "docker-langserver", args: ["--stdio"] },
  { id: "gleam", binary: "gleam", args: ["lsp"] },
  { id: "clojure-lsp", binary: "clojure-lsp", args: ["listen"] },
  { id: "nixd", binary: "nixd", args: [] },
  { id: "tinymist", binary: "tinymist", args: [] },
  { id: "haskell-language-server", binary: "haskell-language-server-wrapper", args: ["--lsp"] },
  { id: "julials", binary: "julia", args: ["--startup-file=no", "--history-file=no", "-e", "using LanguageServer; runserver()"] },
]
// eslint, razor, jdtls and kotlin-ls get no probe: OpenCode 1 fetched compiled
// servers for them, there is no PATH binary that stands in.

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.CAN_EXECUTE)
    return true
  } catch {
    return false
  }
}

/** Empty PATH segments mean the current directory, as POSIX requires. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const segment of (env.PATH ?? "").split(delimiter)) {
    const file = join(segment || ".", name)
    if (isExecutable(file)) return file
  }
  return undefined
}

/** V1's venv sniffing for pyright/ty: the first candidate holding an interpreter wins. */
function venvPython(directory: string, env: NodeJS.ProcessEnv): string | undefined {
  const windows = process.platform === "win32"
  for (const venv of [env.VIRTUAL_ENV, join(directory, ".venv"), join(directory, "venv")]) {
    if (!venv) continue
    const python = windows ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python")
    if (existsSync(python)) return python
  }
  return undefined
}

/** Implicit servers for catalog IDs the merged `lsp` config never mentioned. */
export function discoverServers(lsp: unknown, directory: string, env: NodeJS.ProcessEnv, options: { experimentalTy?: boolean; download?: boolean }): ServerConfig[] {
  if (lsp === undefined || lsp === false) return []
  const declared = new Set(isRecord(lsp) ? Object.keys(lsp) : [])
  const found: ServerConfig[] = []
  for (const probe of PROBES) {
    if (declared.has(probe.id)) continue
    if (probe.experimental && !options.experimentalTy) continue
    // OpenCode 1's flag swaps pyright for ty, not adds.
    if (options.experimentalTy && probe.id === "pyright") continue
    const binary = findOnPath(probe.binary, env)
    if (!binary && !(options.download && hasDownloadSpec(probe.id))) continue
    let initialization = probe.initialization
    if (probe.pythonPath) {
      const python = venvPython(directory, env)
      initialization = python ? { pythonPath: python } : {}
    }
    found.push({
      id: probe.id,
      command: binary ? [binary, ...probe.args] : [],
      extensions: [...BUILTIN_EXTENSIONS[probe.id]],
      env: {},
      initialization,
      download: binary ? undefined : true,
    })
  }
  return found
}
