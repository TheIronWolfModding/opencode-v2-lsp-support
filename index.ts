// OpenCode 2 accepts an `lsp` config block but has no LSP runtime. This plugin
// supplies OpenCode 1's two LSP features from that same block: the `lsp` tool
// and error diagnostics appended to write, edit, and patch results. It also
// publishes the servers' lifecycle through an RPC so a TUI plugin can draw
// OpenCode 1's sidebar rows.
//
// The default export is the plain `{ id, setup }` shape OpenCode 2 loads, so
// the plugin needs no `@opencode/plugin` install.
import { resolveSettings } from "./src/config.ts"
import { afterTool } from "./src/diagnostics.ts"
import { ensureServer } from "./src/download.ts"
import { LspManager } from "./src/manager.ts"
import { lspTool } from "./src/tool.ts"
import { LspWorkaround } from "./src/rpc.ts"

export default {
  id: "opencode-v2-lsp-support",
  async setup(ctx: any) {
    const root: string = ctx.location.directory
    const settings = resolveSettings(root, ctx.options ?? {})
    if (settings.debug) console.error(`[lsp] servers: ${settings.servers.map((server) => server.id).join(", ") || "none"}`)

    let rpc: any = undefined
    const notify = async (kind: string, id: string, dir: string) => {
      if (!rpc) return
      try {
        await rpc.events.emit(kind, { id, root: dir })
      } catch {
        // The sidebar is cosmetic; a lost event only leaves a stale row.
      }
    }
    // Download markers (`download: true`) only exist when the option is on;
    // the resolver installs them on first use and passes other servers through.
    const manager = new LspManager(settings, root, notify, (server) => ensureServer(server, settings.binDir, process.env))
    // Registered even without servers so the sidebar can say "LSPs are disabled".
    rpc = await ctx.rpc.register(LspWorkaround, {
      status: async () => ({ configured: settings.servers.length > 0, servers: manager.snapshot() }),
    })

    if (settings.servers.length === 0) return async () => {
      await rpc.dispose()
    }

    const tools = await ctx.tool.transform((editor: any) => editor.add(lspTool(manager, root)))
    const hook = await ctx.tool.hook("execute.after", afterTool(manager, root, settings.diagnostics))
    return async () => {
      await hook.dispose()
      await tools.dispose()
      await manager.shutdown()
      await rpc.dispose()
    }
  },
}
