import dotenv from "dotenv";
import pino from "pino";
import { loadConfig } from "./config.js";
import { createPool, requireCurrentSchema } from "./database.js";
import { createApp } from "./app.js";

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  const pool = createPool(config.databaseUrl, logger);
  try {
    await requireCurrentSchema(pool);
    const app = await createApp({ pool, config, logger, serveStatic: config.environment !== "development" });
    const server = app.listen(config.port, config.host, () => logger.info({ host: config.host, port: config.port }, "Invoice service ready"));
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5000;
    server.on("error", (error) => {
      logger.fatal({ message: error.message }, "HTTP server failed");
      void pool.end().finally(() => { process.exitCode = 1; });
    });
    const cleanup = setInterval(() => {
      void pool.query("DELETE FROM sessions WHERE expires_at <= now(); DELETE FROM rate_limits WHERE reset_at <= now()").catch((error: unknown) => {
        logger.error({ message: error instanceof Error ? error.message : "Database cleanup failed" }, "Expired session cleanup failed");
      });
    }, 3600_000).unref();
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(cleanup);
      logger.info("Shutting down");
      const deadline = setTimeout(() => { logger.error("Graceful shutdown timed out"); process.exit(1); }, 10_000).unref();
      server.close(() => {
        void pool.end().then(() => { clearTimeout(deadline); }).catch((error: unknown) => {
          logger.error({ message: error instanceof Error ? error.message : "Database shutdown failed" }, "Shutdown failed");
          process.exitCode = 1;
        });
      });
      server.closeIdleConnections();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch (error) {
    await pool.end();
    throw error;
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Server startup failed.");
  process.exitCode = 1;
});
