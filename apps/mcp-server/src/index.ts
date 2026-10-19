import { loadMcpEnv } from "@serp/contracts";
import { PgClarityQuotaStore, PgReportCache, PgRepository } from "@serp/db";
import { createPgExecutor, readDatabaseUrl } from "@serp/db/pg";
import { createLogger } from "@serp/observability";
import { createReportService } from "@serp/reporting";
import { createHttpServer } from "./http.js";
import { buildLiveReporting } from "./live.js";
import { ConcurrencyLimiter } from "./limiter.js";
import { buildVerifier } from "./verifier.js";

const logger = createLogger({ level: process.env.LOG_LEVEL === "debug" ? "debug" : "info", bindings: { service: "mcp-server" } });

process.on("unhandledRejection", (reason) => logger.error("process.unhandled_rejection", { err: reason }));
process.on("uncaughtException", (err) => {
  logger.error("process.uncaught_exception", { err });
  process.exit(1);
});

function main(): void {
  const env = loadMcpEnv();
  // Postgres access is a direct server connection (bypasses RLS); PgRepository scopes every query by user.
  let service;
  if (env.DATA_MODE === "live") {
    service = createReportService(env, buildLiveReporting(env, logger));
  } else {
    // With a database the cache is durable and shared between server instances; otherwise it is per process.
    const db = env.DB_MODE === "postgres" ? createPgExecutor(readDatabaseUrl()) : undefined;
    service = createReportService(env, db ? { repo: new PgRepository(db), cache: new PgReportCache(db), clarityQuota: new PgClarityQuotaStore(db, env.CLARITY_LOCAL_DAILY_BUDGET) } : {});
  }
  const verifier = buildVerifier(env);
  const server = createHttpServer({
    env,
    verifier,
    logger,
    tools: {
      service,
      logger,
      limiter: new ConcurrencyLimiter(env.MAX_MCP_CONCURRENT_REPORTS_PER_USER),
      providers: { gsc: env.PROVIDER_GSC_ENABLED, ga4: env.PROVIDER_GA4_ENABLED, clarity: env.PROVIDER_CLARITY_ENABLED, bing: env.PROVIDER_BING_ENABLED },
    },
  });

  server.listen(env.PORT, () => {
    logger.info("mcp.listening", { port: env.PORT, dataMode: env.DATA_MODE, authMode: env.MCP_AUTH_MODE });
    if (env.MCP_AUTH_MODE === "mock") {
      logger.warn("mcp.mock_auth", { hint: "Development only: use a token of the form mock:<userId> as the bearer token." });
    }
  });

  const shutdown = (signal: string) => {
    logger.info("mcp.shutdown", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  main();
} catch (err) {
  logger.error("mcp.startup_failed", { err });
  process.exit(1);
}
