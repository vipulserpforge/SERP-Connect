import { checkGoogleConfig, formatChecks, probeGoogle } from "../packages/provider-google/src/index.js";

// Usage:
//   pnpm google:check             offline: validates configuration and prints the exact redirect URI to register
//   pnpm google:check --probe     also asks Google whether the client id and redirect URI are accepted
//   pnpm google:check --probe --secret   also verifies the client secret against Google's token endpoint
// Reads .env.local (or the process environment). The client secret is never printed.
const args = new Set(process.argv.slice(2));
const env = process.env;
const checks = checkGoogleConfig(env);
if (args.has("--probe") || args.has("--secret")) checks.push(...(await probeGoogle(env, { checkSecret: args.has("--secret") })));
console.log(formatChecks(checks));
const failures = checks.filter((c) => c.level === "fail").length;
console.log(`\n${failures === 0 ? "No blocking problems found." : `${failures} blocking problem(s).`} A passing check is not proof: finish by connecting an account from the dashboard.`);
process.exit(failures === 0 ? 0 : 1);
