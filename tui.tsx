// Terminal half of the plugin: OpenCode 1's sidebar/lsp.tsx, ported to OpenCode
// 2's TUI plugin API. State lives on the server plugin; this half reads the
// initial rows through the RPC and follows them through its events, then draws
// the same rows in the `sidebar.content` slot.
//
// Like the server half, the default export is the plain `{ id, setup }` shape
// the TUI loader duck-types (`isPlugin`), so nothing from `@opencode/plugin`
// needs to resolve from this directory. Solid JSX compiles through Bun using
// the `jsxImportSource` in this repository's tsconfig.json, as the TUI's own
// feature plugins do.
import { LspWorkaround } from "./src/rpc.ts"
import { createSignal, For, Show } from "solid-js"

export default {
  id: "lsp-opencode-v2-workaround-sidebar",
  async setup(context: any) {
    const lsp = context.client.rpc(LspWorkaround)
    const [open, setOpen] = createSignal(true)
    // Until the first status read lands, the RPC may be unreachable; do not claim the config was read.
    const [snapshot, setSnapshot] = createSignal<Record<string, any>>({ configured: false, servers: [] })

    const merge = (kind: string, item: { id: string; root: string }) =>
      setSnapshot((current) => {
        const without = current.servers.filter((row: any) => !(row.id === item.id && row.root === item.root))
        if (kind === "shutdown") return { configured: current.configured, servers: without }
        return { configured: current.configured, servers: [...without, { id: item.id, root: item.root, status: kind === "connected" ? "connected" : "broken" }] }
      })

    const stopListening: (() => void)[] = []
    for (const kind of ["connected", "failed", "shutdown"]) {
      stopListening.push(lsp.events.on(kind, (event: any) => {
        const data = event.data
        if (data && typeof data.id === "string" && typeof data.root === "string") merge(kind, { id: data.id, root: data.root })
      }))
    }

    // The server plugin may still be loading when this setup runs, so a failed
    // first read waits once; without a definition the call throws immediately.
    let retry: any = undefined
    const refresh = async (retryMs: number) => {
      try {
        const rows = await lsp.status({})
        if (rows) setSnapshot({ configured: rows.configured === true, servers: Array.isArray(rows.servers) ? rows.servers : [] })
      } catch {
        if (retryMs > 0) retry = setTimeout(() => refresh(0), retryMs)
      }
    }
    await refresh(2_000)

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const theme = context.theme
        const current = snapshot()
        const servers = current.servers
        return (
          <box>
            <box flexDirection="row" gap={1} onMouseDown={() => servers.length > 2 && setOpen((x) => !x)}>
              <Show when={servers.length > 2}>
                <text fg={theme.text.base}>{open() ? "▼" : "▶"}</text>
              </Show>
              <text fg={theme.text.base}>
                <b>LSP</b>
              </text>
            </box>
            <Show when={servers.length <= 2 || open()}>
              <Show when={servers.length === 0}>
                <text fg={theme.text.muted}>{current.configured ? "LSPs will activate as files are read" : "LSPs are disabled"}</text>
              </Show>
              <For each={servers}>
                {(item) => (
                  <box flexDirection="row" gap={1}>
                    <text
                      flexShrink={0}
                      style={{
                        fg: item.status === "connected" ? theme.text.feedback.success.base : theme.text.feedback.error.base,
                      }}
                    >
                      •
                    </text>
                    <text fg={theme.text.muted}>{item.id}</text>
                  </box>
                )}
              </For>
            </Show>
          </box>
        )
      },
    })

    return () => {
      unregister()
      for (const stop of stopListening) stop()
      if (retry) clearTimeout(retry)
    }
  },
}
