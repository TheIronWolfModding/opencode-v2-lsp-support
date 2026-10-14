# LSP support for OpenCode V2

A local plugin that brings the OpenCode V1-style `lsp` tool and post-edit error diagnostics to OpenCode V2. Load the TypeScript source directly: no npm package, dependency install, or build step required for the plugin.

## Install

1. Clone the repository somewhere you will keep it:

   ```sh
   git clone https://github.com/christensenjairus/opencode-v2-lsp-support.git "$HOME/opencode-v2-lsp-support"
   ```

2. Add the clone's **absolute directory path** to `plugins` in your global `~/.config/opencode/opencode.json(c)` or your project's `opencode.json(c)`. Replace `/home/you` with your actual home directory, and preserve your other config entries:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/home/you/opencode-v2-lsp-support"],
     "lsp": {
       "pyright": {
         "command": ["pyright-langserver", "--stdio"],
         "extensions": [".py", ".pyi"]
       }
     }
   }
   ```

3. Install the language servers you want to use separately. For the Python example, `npm install --global pyright` provides `pyright-langserver`; with the default `discover: true`, the OpenCode service's `PATH` then activates it even without the `lsp` entry, so explicit configuration is only needed to override commands or turn a server off.
4. Reload the plugin or restart OpenCode's service so it picks up the plugin and configuration. Ask the agent to use `lsp` on a Python file in your project, or edit one and check the result for diagnostics.

The repo root is the plugin directory: `index.ts` is the entrypoint and `src/` contains its implementation. OpenCode loads both directly. `package.json` declares the source entrypoint, marks the repository as an ES module, and provides a test command; it has no dependencies and is marked private to prevent accidental npm publication. The sidebar rows on the terminal side come from `tui.tsx` at the repo root, exported as `./tui`; OpenCode loads it automatically beside the main plugin, so no `cli.json` change is needed.

For project-local automatic discovery, you can instead clone the repository into `.opencode/plugins/opencode-v2-lsp-support` within your project and omit the `plugins` entry. You still need the `lsp` configuration for servers outside the OpenCode 1 catalog; installed catalog servers activate by themselves.

See [examples/opencode.jsonc](examples/opencode.jsonc) for portable Python, TypeScript/JavaScript, Go, shell, YAML, and Rust commands. Keep only the servers you have installed. Loading the plugin does not install or download language servers — except under the optional `download` option, described below.

## Features

- Adds an `lsp` tool for definitions, references, hover, document/workspace symbols, implementations, and call hierarchies.
- Appends error diagnostics to successful `write`, `edit`, `patch`, and `apply_patch` results, with diagnostic metadata for the terminal UI.
- Publishes server lifecycle through the `lsp-opencode-v2-workaround` RPC (a `status` method plus `connected`/`failed`/`shutdown` events), and its `./tui` entrypoint draws OpenCode 1's `LSP` sidebar rows — one `• id` line per server, colored by connection state (the root path V1 printed is omitted), with expand/collapse when more than two rows — in the terminal's `sidebar.content` slot.
- Supports push diagnostics, static and dynamically registered pull diagnostics (identifiers and related documents, as OpenCode 1 handled them), document versions with whole-document range replacements for incremental-sync servers, `workspace/didChangeWatchedFiles` notifications, and fresh errors reported in other files.
- Starts servers lazily and warms them on file reads; uses one server process per server ID and detected root.
- OpenCode 1-style auto-discovery: catalog servers already installed on `PATH` activate without config (configured IDs win).
- Optional `download` option mirrors OpenCode 1's on-demand installs: fetchable servers missing from `PATH` are fetched on first use into a plugin-owned bin dir.
- Closes deleted and moved-away documents and shuts down servers when the plugin unloads.
- Rejects navigation paths outside the plugin's project directory, including symlinks to outside files; checks opened files before sending their contents.
- Filters other-file diagnostic reports to existing files inside the project, including symlink checks.
- Cancels navigation requests and diagnostic warm-up when OpenCode stops a tool, without shutting down servers shared by other callers.

### Tool inputs

Every operation requires `path`. Positions are **1-based**, with UTF-16 character offsets. All operations except `documentSymbol` and `workspaceSymbol` also require `line` and `character`.

```json
{"operation": "goToDefinition", "path": "src/app.py", "line": 12, "character": 5}
```

```json
{"operation": "workspaceSymbol", "path": "src/app.py", "query": "Handler"}
```

The supported operation names are `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, and `outgoingCalls`. For `workspaceSymbol`, the path selects the server; an empty query requests all symbols. As in OpenCode 1, `workspaceSymbol` keeps only the meaningful kinds (class, function, method, interface, variable, constant, struct, enum). Each operation depends on the server advertising the corresponding capability.

## Configuration

The plugin reads the V1-shaped `lsp` map from OpenCode config files. Each server takes `command` (executable and arguments), optional `extensions`, `env`, `initialization`, and `disabled`. `initialization` supplies initialization options, configuration-change settings, and answers to `workspace/configuration` requests.

Known V1 server IDs have default extensions and root rules in [src/catalog.ts](src/catalog.ts). For example, `pyright` selects the nearest Python project marker, `typescript` selects the nearest JavaScript lockfile and skips Deno projects, and `rust` detects Cargo workspaces. Custom IDs run at the plugin's project directory; like OpenCode 1, one without `extensions` applies to every file.

An ID the config never mentions can still activate: with the default `discover: true`, the plugin probes the OpenCode 1 executable for each catalog ID (e.g. `pyright-langserver`, `bash-language-server`, `rust-analyzer`, `clangd`) on the service's `PATH` and enables it implicitly with OpenCode 1's arguments and initialization. Like OpenCode 1, discovery needs the `lsp` key present (`true` or an object) — no `lsp` key means no servers. An ID the config declares — even `{ "disabled": true }` — keeps the config's authority and is never probed. Set `discover: false` to turn the probe pass off.

The config reader loads global files, `OPENCODE_CONFIG`, ancestor project files, ancestor `.opencode` files, then `OPENCODE_CONFIG_CONTENT`. It supports JSONC, `{env:VAR}` and `{file:path}` substitution, project-config disable flags, and deep merges of server objects; arrays are replaced. Plugin options take final precedence. This is a local config reader, not access to OpenCode's merged configuration; remote or externally supplied config is not automatically discovered.

Optional settings use OpenCode's object-form plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "/home/you/opencode-v2-lsp-support",
      "options": {
        "diagnostics": true,
        "diagnosticsTimeoutMs": 5000,
        "initializeTimeoutMs": 45000,
        "requestTimeoutMs": 15000,
        "debug": false,
        "discover": true,
        "download": false,
        "binDir": "~/.cache/opencode-lsp-bin"
      }
    }
  ]
}
```

The values shown are the defaults. `diagnostics: false` disables post-edit reporting but leaves navigation available. `discover: false` turns off implicit activation of installed OpenCode 1 servers. `experimentalTy: true` swaps `ty` in for `pyright` for Python (OpenCode 1 kept `ty` behind its experimental flag; by default only `pyright` auto-activates). `download: true` additionally mirrors OpenCode 1's on-demand installs: a fetchable built-in server not on `PATH` is fetched lazily on first use (npm, GitHub release, hashicorp, `dotnet tool install`, and go-install flows ported from OpenCode 1) into `binDir` (default `~/.cache/opencode-lsp-bin`), then reused on later loads. npm installs run with `--ignore-scripts`, as OpenCode 1's did; asset names are selected per platform, and the fetch flows are POSIX-only (Windows is not supported). Skipped: elixir-ls's mix build, jdtls/Eclipse, kotlin-ls, eslint's compiled server, macOS-only sourcekit-lsp, the clangd and tinymist fetches, and language-toolchain installs (deno, dart, julia, opam/ocaml, gem/ruby); extraction assumes `tar`/`unzip` exist. `options.lsp` overrides server settings; `lsp: false` disables all servers, discovery and download included. Without any enabled, configured servers, the plugin registers neither the tool nor the diagnostic hook. Reload the plugin after changing its settings.

## Limitations and trust

- Targets the OpenCode V2 plugin API (`ctx.tool.transform`, `ctx.tool.hook("execute.after", ...)`, and `ctx.rpc.register`), not V1. The source was extracted from a plugin used with OpenCode **v2.0.23**; other versions need verification.
- Language servers run with stdio; without `download`, they must already be installed. With it, installs run external commands (`npm`, `dotnet`, `go`, `tar`, `unzip`) and fetch from network mirrors like OpenCode 1 did — the trust boundary below applies. No TCP transport or full editor functionality is provided.
- Only errors are appended to tool results; warnings and hints are omitted. Missing diagnostic severity is treated as an error. Reports are capped at 20 errors per file and five other files; workspace symbol results are capped at 20.
- Diagnostics are best-effort. A silent or failed server leaves the edit result unchanged; a navigation request explains the failure when every server for the file failed — while some server answers, its results are used and failing co-servers are ignored, as OpenCode 1 did. A server that fails to start stays disabled for that plugin instance until it reloads.
- The typescript and astro servers require the project to resolve `typescript/lib/tsserver.js`, as OpenCode 1 required: the resolved tsserver is passed to the server as an initialization option, and without it the servers do not start and leave no sidebar row.
- Deliberate simplifications versus OpenCode 1: biome and oxlint use the `PATH` executable rather than the project's local `node_modules` copy; the Python venv probe is project-level rather than per detected root; an extension missing from the language-id map gets a guess derived from the extension instead of OpenCode 1's `plaintext`; navigation requests go only to servers that advertised the capability, while OpenCode 1 asked every server for the file (a server implementing a method without declaring it is therefore not asked); `workspaceSymbol` asks only the given file's servers rather than every running server; call hierarchy follows every item prepared at the position, not OpenCode 1's first item only.
- Cold-start initialization and navigation warm-up can take longer than the configured diagnostics wait.
- Save notifications require an explicit `textDocumentSync.save` capability. Legacy numeric-only sync capabilities do not receive them; servers that rely on save-only checks must advertise save support.
- The plugin checks which document contents it sends; it does **not** sandbox the server process or stop a server from scanning dependencies outside the project. Servers run with the OpenCode service's OS privileges and inherited environment. Only load trusted code and configure trusted commands; debug output may include server messages and paths.

## Test

With Node.js 22.18 or newer (type stripping on by default):

```sh
node test-opencode-lsp.js
```

No dependencies or real language servers are needed. The suite uses a fake stdio LSP server and a stand-in for the OpenCode plugin context to exercise navigation, diagnostics, config precedence, roots, failure handling, and project-boundary checks. It does not substitute for testing against the real OpenCode runtime and your chosen language servers.

## Update or remove

Run `git pull --ff-only` in your clone and reload the plugin to update. To uninstall, remove its `plugins` entry (or its automatically discovered project-local clone) and reload. Language-server installations and your `lsp` configuration remain yours to manage.

OpenCode's [V2 plugin documentation](https://opencode.ai/v2/docs/build/plugins) describes local directory loading and the plugin API.
