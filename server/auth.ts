import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { parse } from "cookie";
import type { Request, Response, NextFunction } from "express";
import type pg from "pg";
import type { Config } from "./config.js";
import type { Database } from "./database.js";
import { HttpError } from "./errors.js";
import type { Session } from "../src/domain/api.js";
import type { User } from "../src/domain/types.js";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: User["role"];
  active: boolean;
  must_change_password: boolean;
}
export interface Authentication {
  user: User;
  tokenHash: string;
  csrfToken: string;
}
declare global {
  namespace Express {
    interface Locals {
      auth: Authentication;
      requestId: string;
    }
  }
}

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `scrypt-32768-8-3$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const match = /^scrypt-32768-8-3\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(hash);
  if (!match) throw new Error("Unsupported or corrupt stored password hash.");
  return timingSafeEqual(await derive(password, match[1]), Buffer.from(match[2], "hex"));
}
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
export const cookieName = (config: Config): string => config.secureCookies ? "__Host-invoice_session" : "invoice_session";

export function publicUser(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active, mustChangePassword: row.must_change_password };
}

export async function issueSession(db: Database, user: User, config: Config): Promise<{ session: Session; token: string }> {
  const token = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(32).toString("hex");
  await db.query("INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + $4 * interval '1 hour')", [tokenHash(token), user.id, csrfToken, config.sessionHours]);
  return { session: { user, csrfToken }, token };
}
export function setSessionCookie(response: Response, token: string, config: Config): void {
  response.cookie(cookieName(config), token, { httpOnly: true, secure: config.secureCookies, sameSite: "strict", path: "/", maxAge: config.sessionHours * 3600_000 });
}
export function clearSessionCookie(response: Response, config: Config): void {
  response.clearCookie(cookieName(config), { httpOnly: true, secure: config.secureCookies, sameSite: "strict", path: "/" });
}
export function requireSession(pool: pg.Pool, config: Config) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const token = parse(request.headers.cookie ?? "")[cookieName(config)];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
    const { rows } = await pool.query<UserRow & { csrf_token: string }>(
      "SELECT u.*, s.csrf_token FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true",
      [tokenHash(token)],
    );
    if (!rows[0]) {
      clearSessionCookie(response, config);
      throw new HttpError(401, "SESSION_EXPIRED", "Your session expired. Sign in again.");
    }
    response.locals.auth = { user: publicUser(rows[0]), csrfToken: rows[0].csrf_token, tokenHash: tokenHash(token) };
    next();
  };
}
export function requireCsrf(request: Request, response: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
  const supplied = request.get("X-CSRF-Token");
  const expected = response.locals.auth.csrfToken;
  if (!supplied || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw new HttpError(403, "CSRF_REJECTED", "The request could not be verified. Refresh the page and try again.");
  }
  next();
}
export function requireAdmin(_request: Request, response: Response, next: NextFunction): void {
  if (response.locals.auth.user.role !== "admin") throw new HttpError(403, "FORBIDDEN", "Administrator access is required.");
  next();
}
export async function enforceLimit(db: Database, key: string, maximum: number, seconds: number, response: Response): Promise<void> {
  const { rows } = await db.query<{ attempts: number; retry_after: number }>(
    `INSERT INTO rate_limits(key, attempts, reset_at) VALUES ($1, 1, now() + $2 * interval '1 second')
     ON CONFLICT(key) DO UPDATE SET
       attempts = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.attempts + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= now() THEN now() + $2 * interval '1 second' ELSE rate_limits.reset_at END
     RETURNING attempts, greatest(1, ceil(extract(epoch FROM reset_at - now())))::int AS retry_after`,
    [tokenHash(key), seconds],
  );
  if (rows[0].attempts > maximum) {
    response.set("Retry-After", String(rows[0].retry_after));
    throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Wait before trying again.");
  }
}
