import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";
import express, { type ErrorRequestHandler, type Request } from "express";
import helmet from "helmet";
import multer from "multer";
import type pg from "pg";
import type { Logger } from "pino";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import { transaction } from "./database.js";
import { clearSessionCookie, enforceLimit, hashPassword, issueSession, publicUser, requireAdmin, requireCsrf, requireSession, setSessionCookie, tokenHash, verifyPassword, type UserRow } from "./auth.js";
import { changePassword, createUser, listUsers, resetUserPassword, updateUser } from "./accounts.js";
import { createDelivery, createPurchaseOrder, createSupplier } from "./catalog.js";
import { createExport, createInvoice, reviewInvoice, updateInvoice } from "./invoices.js";
import { auditPage, dashboard, exportPage, findInvoice, invoiceDetail, invoiceHistory, listInvoices, referenceById, referencePage } from "./repository.js";
import { changePasswordSchema, createInvoiceSchema, createUserSchema, deliverySchema, exportSchema, identifierSchema, invoiceQuerySchema, loginSchema, MAX_DOCUMENT_BYTES, pageQuerySchema, purchaseOrderSchema, referenceQuerySchema, resetPasswordSchema, reviewSchema, supplierSchema, updateInvoiceSchema, updateUserSchema } from "../src/domain/validation.js";

const identifier = (request: Request): string => identifierSchema.parse(request.params.id);

export async function createApp({ pool, config, logger, serveStatic = true }: { pool: pg.Pool; config: Config; logger: Logger; serveStatic?: boolean }) {
  const app = express();
  const dummyHash = await hashPassword(randomBytes(32).toString("hex"));
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy === 1 ? 1 : false);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", "blob:"],
      fontSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"],
      upgradeInsecureRequests: config.secureCookies ? [] : null,
    } },
    strictTransportSecurity: config.secureCookies ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: "no-referrer" },
  }));
  app.use((request, response, next) => {
    const started = performance.now();
    response.locals.requestId = randomUUID();
    response.set("X-Request-Id", response.locals.requestId);
    response.on("finish", () => logger.info({
      requestId: response.locals.requestId, method: request.method, path: request.path,
      status: response.statusCode, durationMs: Math.round(performance.now() - started),
      userId: response.locals.auth?.user.id,
    }, "request"));
    next();
  });

  const api = express.Router();
  api.use((_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  api.use((request, _response, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.get("Origin") !== config.origin) {
      throw new HttpError(403, "ORIGIN_REJECTED", "Requests must come from the configured application origin.");
    }
    next();
  });
  api.use(express.json({ limit: "128kb", strict: true }));
  api.get("/health/live", (_request, response) => { response.json({ status: "ok" }); });
  api.get("/health/ready", async (_request, response) => {
    try {
      await pool.query("SELECT 1");
      response.json({ status: "ok" });
    } catch (error) {
      logger.warn({ requestId: response.locals.requestId, message: error instanceof Error ? error.message : "Database unavailable" }, "Readiness check failed");
      throw new HttpError(503, "NOT_READY", "Database is unavailable.");
    }
  });
  api.post("/auth/login", async (request, response) => {
    const input = loginSchema.parse(request.body);
    await enforceLimit(pool, `login-ip:${request.ip}`, 30, 900, response);
    await enforceLimit(pool, `login-account:${input.email}`, 10, 900, response);
    const result = await pool.query<UserRow>("SELECT * FROM users WHERE email=$1", [input.email]);
    const candidate = result.rows[0];
    const valid = await verifyPassword(input.password, candidate?.password_hash ?? dummyHash);
    if (!candidate?.active || !valid) throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    const issued = await transaction(pool, async (db) => {
      const current = await db.query<UserRow>("SELECT * FROM users WHERE id=$1 FOR SHARE", [candidate.id]);
      if (!current.rows[0]?.active || current.rows[0].password_hash !== candidate.password_hash) throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
      await db.query("DELETE FROM rate_limits WHERE key=$1", [tokenHash(`login-account:${input.email}`)]);
      return issueSession(db, publicUser(current.rows[0]), config);
    });
    setSessionCookie(response, issued.token, config);
    response.json(issued.session);
  });
  api.use(requireSession(pool, config), requireCsrf);
  api.get("/auth/me", (_request, response) => {
    const { user, csrfToken } = response.locals.auth;
    response.json({ user, csrfToken });
  });
  api.post("/auth/logout", async (_request, response) => {
    await pool.query("DELETE FROM sessions WHERE token_hash=$1", [response.locals.auth.tokenHash]);
    clearSessionCookie(response, config);
    response.json({ ok: true });
  });
  api.post("/auth/change-password", async (request, response) => {
    await enforceLimit(pool, `password:${response.locals.auth.user.id}`, 10, 900, response);
    const issued = await changePassword(pool, response.locals.auth.user, config, changePasswordSchema.parse(request.body));
    setSessionCookie(response, issued.token, config);
    response.json(issued.session);
  });
  api.use(async (request, response, next) => {
    if (response.locals.auth.user.mustChangePassword) throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "Change your temporary password before continuing.");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) await enforceLimit(pool, `mutation:${response.locals.auth.user.id}`, 120, 60, response);
    next();
  });

  api.get("/dashboard", async (_request, response) => { response.json(await dashboard(pool)); });
  api.get("/invoices", async (request, response) => { response.json(await listInvoices(pool, invoiceQuerySchema.parse(request.query))); });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 1, parts: 2, fieldSize: 128 * 1024 } });
  api.post("/invoices", async (_request, response, next) => {
    await enforceLimit(pool, `intake:${response.locals.auth.user.id}`, 60, 3600, response);
    next();
  }, upload.single("document"), async (request, response) => {
    let payload: unknown = request.body;
    if (request.is("multipart/form-data")) {
      if (typeof request.body?.data !== "string") throw new HttpError(400, "INVALID_JSON", "Include the invoice metadata in the data field.");
      try { payload = JSON.parse(request.body.data); }
      catch (error) {
        if (error instanceof SyntaxError) throw new HttpError(400, "INVALID_JSON", "Invoice metadata must be valid JSON.");
        throw error;
      }
    }
    const invoice = await createInvoice(pool, response.locals.auth.user, createInvoiceSchema.parse(payload), request.file);
    response.status(201).json({ id: invoice.id });
  });
  api.get("/invoices/:id", async (request, response) => { response.json(await invoiceDetail(pool, identifier(request))); });
  api.get("/invoices/:id/history", async (request, response) => {
    const id = identifier(request);
    await findInvoice(pool, id);
    const query = pageQuerySchema.strict().parse(request.query);
    response.json(await invoiceHistory(pool, id, query.page, query.limit));
  });
  api.put("/invoices/:id", async (request, response) => {
    response.json(await updateInvoice(pool, response.locals.auth.user, identifier(request), updateInvoiceSchema.parse(request.body)));
  });
  api.post("/invoices/:id/review", async (request, response) => {
    response.json(await reviewInvoice(pool, response.locals.auth.user, identifier(request), reviewSchema.parse(request.body)));
  });
  api.get("/invoices/:id/document", async (request, response) => {
    const { rows } = await pool.query<{ document: Buffer | null; source_name: string; source_type: string }>("SELECT document, source_name, source_type FROM invoices WHERE id=$1", [identifier(request)]);
    if (!rows[0]?.document) throw new HttpError(404, "NOT_FOUND", "No source document is attached to this invoice.");
    response.attachment(rows[0].source_name).type(rows[0].source_type);
    response.set("Content-Security-Policy", "sandbox; default-src 'none'");
    response.send(rows[0].document);
  });
  api.get("/exports", async (request, response) => {
    const query = pageQuerySchema.strict().parse(request.query);
    response.json(await exportPage(pool, query.page, query.limit));
  });
  api.post("/exports", async (request, response) => {
    response.status(201).json(await createExport(pool, response.locals.auth.user, exportSchema.parse(request.body)));
  });
  api.get("/exports/:id/download", async (request, response) => {
    const id = identifier(request);
    const { rows } = await pool.query<{ csv: string }>("SELECT csv FROM export_batches WHERE id=$1", [id]);
    if (!rows[0]) throw new HttpError(404, "NOT_FOUND", "Export batch not found.");
    response.attachment(`invoices-${id}.csv`).type("text/csv");
    response.set("Content-Security-Policy", "sandbox; default-src 'none'");
    response.send(`\uFEFF${rows[0].csv}`);
  });

  for (const kind of ["suppliers", "purchase-orders", "deliveries"] as const) {
    api.get(`/${kind}`, async (request, response) => { response.json(await referencePage(pool, kind, referenceQuerySchema.parse(request.query))); });
    api.get(`/${kind}/:id`, async (request, response) => { response.json(await referenceById(pool, kind, identifier(request))); });
  }
  api.post("/suppliers", requireAdmin, async (request, response) => { response.status(201).json(await createSupplier(pool, response.locals.auth.user, supplierSchema.parse(request.body))); });
  api.post("/purchase-orders", requireAdmin, async (request, response) => { response.status(201).json(await createPurchaseOrder(pool, response.locals.auth.user, purchaseOrderSchema.parse(request.body))); });
  api.post("/deliveries", requireAdmin, async (request, response) => { response.status(201).json(await createDelivery(pool, response.locals.auth.user, deliverySchema.parse(request.body))); });
  api.get("/admin/users", requireAdmin, async (request, response) => {
    const query = pageQuerySchema.strict().parse(request.query);
    response.json(await listUsers(pool, query.page, query.limit));
  });
  api.post("/admin/users", requireAdmin, async (request, response) => { response.status(201).json(await createUser(pool, response.locals.auth.user, createUserSchema.parse(request.body))); });
  api.patch("/admin/users/:id", requireAdmin, async (request, response) => { response.json(await updateUser(pool, response.locals.auth.user, identifier(request), updateUserSchema.parse(request.body))); });
  api.post("/admin/users/:id/reset-password", requireAdmin, async (request, response) => {
    await resetUserPassword(pool, response.locals.auth.user, identifier(request), resetPasswordSchema.parse(request.body).password);
    response.json({ ok: true });
  });
  api.get("/admin/audit", requireAdmin, async (request, response) => {
    const query = pageQuerySchema.strict().parse(request.query);
    response.json(await auditPage(pool, query.page, query.limit));
  });
  api.use(() => { throw new HttpError(404, "NOT_FOUND", "API endpoint not found."); });
  app.use("/api", api);

  if (serveStatic) {
    const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
    app.use("/assets", express.static(`${dist}/assets`, { immutable: true, maxAge: "1y", fallthrough: false }));
    app.use(express.static(dist, { index: false, maxAge: 0, dotfiles: "deny" }));
    app.get("/{*path}", (request, response) => {
      if (extname(request.path)) throw new HttpError(404, "NOT_FOUND", "File not found.");
      response.set("Cache-Control", "no-cache");
      response.sendFile(`${dist}/index.html`);
    });
  }
  const errors: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (response.headersSent) return next(error);
    let failure: HttpError;
    if (error instanceof HttpError) failure = error;
    else if (error instanceof ZodError) failure = new HttpError(400, "VALIDATION_ERROR", "Check the submitted fields.", error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
    else if (error instanceof multer.MulterError) failure = new HttpError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, "INVALID_UPLOAD", error.code === "LIMIT_FILE_SIZE" ? "The document must be 10 MiB or smaller." : "Upload one document and one metadata field only.");
    else if (error instanceof Error && "code" in error && error.code === "23505") failure = new HttpError(409, "ALREADY_EXISTS", "A record with that email, code, or reference number already exists.");
    else if (error instanceof Error && "status" in error && error.status === 413) failure = new HttpError(413, "PAYLOAD_TOO_LARGE", "The request exceeds the allowed size.");
    else if (error instanceof SyntaxError && "status" in error && error.status === 400) failure = new HttpError(400, "INVALID_JSON", "The request body must be valid JSON.");
    else if (error instanceof Error && "status" in error && error.status === 404) failure = new HttpError(404, "NOT_FOUND", "File not found.");
    else failure = new HttpError(500, "INTERNAL_ERROR", "The request could not be completed. Try again or contact your administrator with the request ID.");
    if (failure.status >= 500) logger.error({ requestId: response.locals.requestId, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : "Unknown error" }, "Request failed");
    response.status(failure.status).json({ error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) }, requestId: response.locals.requestId });
  };
  app.use(errors);
  return app;
}
