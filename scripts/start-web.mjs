// Starts the already-built Next.js dashboard (apps/web) from the repository root.
//
// Why this exists: some hosts (Hostinger Node.js Web Apps) build and run one "root directory" per app and only let you
// choose an entry file, while this app lives in a monorepo (apps/web depends on packages/*). Setting the host's root
// directory to the repository root and the entry file to this script avoids copying anything around.
// Local equivalent: `pnpm start:web`.
// Production safeguards (no mock data, no mock auth) key off NODE_ENV, so never run without it.
process.env.NODE_ENV ??= "production";

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("../apps/web/", import.meta.url));
const requireFromWeb = createRequire(`${webDir}package.json`);
const next = requireFromWeb("next");

const port = Number(process.env.PORT) || 3000;
const app = next({ dev: false, dir: webDir, port });
const handle = app.getRequestHandler();

await app.prepare();
const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("web.request_failed", err instanceof Error ? err.message : "unknown");
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal Server Error");
  });
});
server.listen(port, () => console.log(`web listening on ${port}`));

const stop = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
