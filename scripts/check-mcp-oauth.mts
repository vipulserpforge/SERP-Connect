import { checkAuthorizationServer, checkMcpOAuthReadiness, formatChecks } from "../apps/mcp-server/src/readiness.js";

// Usage:
//   pnpm mcp:check https://mcp.example.com/mcp          full check of a deployed server and its authorization server
//   pnpm mcp:check --issuer https://<ref>.supabase.co/auth/v1   authorization server only (before the MCP server is deployed)
const args = process.argv.slice(2);
const issuerIndex = args.indexOf("--issuer");
const checks =
  issuerIndex >= 0
    ? await checkAuthorizationServer(args[issuerIndex + 1] ?? "")
    : args[0]
      ? await checkMcpOAuthReadiness(args[0])
      : null;

if (!checks) {
  console.error("Usage: pnpm mcp:check <https://host/mcp>  |  pnpm mcp:check --issuer <issuer-url>");
  process.exit(2);
}
console.log(formatChecks(checks));
const failures = checks.filter((c) => c.level === "fail").length;
console.log(`\n${failures === 0 ? "No blocking problems found." : `${failures} blocking problem(s).`}`);
process.exit(failures === 0 ? 0 : 1);
