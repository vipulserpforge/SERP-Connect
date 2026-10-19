// Starts the built MCP server (apps/mcp-server/dist) from the repository root. Used as the "entry file" on hosts that
// run one root directory per app (Hostinger Node.js Web Apps). Local equivalent: `pnpm start:mcp`.
//
// Production safeguards (no mock data, no mock auth) key off NODE_ENV, so never run without it.
process.env.NODE_ENV ??= "production";
await import("../apps/mcp-server/dist/index.js");
