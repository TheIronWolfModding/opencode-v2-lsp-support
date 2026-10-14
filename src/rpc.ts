/**
 * OpenCode 2 keeps plugin state on the server, but the terminal sidebar needs
 * it on the client. This RPC carries the server rows across: the TUI side calls
 * `status` for the initial list and subscribes to the lifecycle events, so the
 * sidebar can show what OpenCode 1's built-in sidebar showed.
 *
 * Shaped like `@opencode/schema/rpc`'s `Rpc.PortableDefinition`. The package's
 * `Rpc.define` only checks reserved error names and returns the definition, so
 * the plain object is exported directly and the test harness needs no imports.
 */
export const LspWorkaround = {
  id: "lsp-opencode-v2-workaround",
  methods: {
    status: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          configured: { type: "boolean" },
          servers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                root: { type: "string" },
                status: { enum: ["connected", "starting", "broken"] },
              },
              required: ["id", "root", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["configured", "servers"],
        additionalProperties: false,
      },
    },
  },
  events: {
    connected: {
      schema: {
        type: "object",
        properties: { id: { type: "string" }, root: { type: "string" } },
        required: ["id", "root"],
        additionalProperties: false,
      },
    },
    failed: {
      schema: {
        type: "object",
        properties: { id: { type: "string" }, root: { type: "string" } },
        required: ["id", "root"],
        additionalProperties: false,
      },
    },
    shutdown: {
      schema: {
        type: "object",
        properties: { id: { type: "string" }, root: { type: "string" } },
        required: ["id", "root"],
        additionalProperties: false,
      },
    },
  },
}
