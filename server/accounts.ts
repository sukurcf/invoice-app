import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { z } from "zod";
import { hashPassword, issueSession, publicUser, verifyPassword, type UserRow } from "./auth.js";
import { transaction, workflow } from "./database.js";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import { appendAudit } from "./repository.js";
import type { User } from "../src/domain/types.js";
import type { PageResult } from "../src/domain/api.js";
import type { changePasswordSchema, createUserSchema, updateUserSchema } from "../src/domain/validation.js";

export async function listUsers(pool: pg.Pool, page: number, limit: number): Promise<PageResult<User>> {
  const [count, result] = await Promise.all([
    pool.query<{ total: number }>("SELECT count(*)::int AS total FROM users"),
    pool.query<UserRow>("SELECT * FROM users ORDER BY created_at, id LIMIT $1 OFFSET $2", [limit, (page - 1) * limit]),
  ]);
  return { items: result.rows.map(publicUser), total: count.rows[0].total, page, limit };
}
export async function createUser(pool: pg.Pool, actor: User, input: z.infer<typeof createUserSchema>): Promise<User> {
  const hash = await hashPassword(input.password);
  return workflow(pool, actor, async (db) => {
    const { rows } = await db.query<UserRow>("INSERT INTO users(id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING *", [randomUUID(), input.email, input.name, hash, input.role]);
    const user = publicUser(rows[0]);
    await appendAudit(db, actor, "user_created", user.id, `Created ${user.role} account ${user.email}; password change required at first sign-in.`);
    return user;
  }, true);
}
export async function updateUser(pool: pg.Pool, actor: User, id: string, input: z.infer<typeof updateUserSchema>): Promise<User> {
  return workflow(pool, actor, async (db) => {
    if (actor.id === id) throw new HttpError(409, "SELF_MANAGEMENT_BLOCKED", "Ask another administrator to change your role or disable your account.");
    const existing = await db.query<UserRow>("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id]);
    if (!existing.rows[0]) throw new HttpError(404, "NOT_FOUND", "User not found.");
    const admins = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM users WHERE active AND role='admin' AND id<>$1", [id]);
    if ((!input.active || input.role !== "admin") && admins.rows[0].count === 0) throw new HttpError(409, "LAST_ADMIN", "At least one active administrator must remain.");
    const { rows } = await db.query<UserRow>("UPDATE users SET active=$2, role=$3 WHERE id=$1 RETURNING *", [id, input.active, input.role]);
    await db.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    await appendAudit(db, actor, "user_updated", id, `Account ${rows[0].email}: role=${input.role}, active=${input.active}. Existing sessions revoked.`);
    return publicUser(rows[0]);
  }, true);
}
export async function resetUserPassword(pool: pg.Pool, actor: User, id: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await workflow(pool, actor, async (db) => {
    if (actor.id === id) throw new HttpError(409, "SELF_MANAGEMENT_BLOCKED", "Use your account page to change your own password.");
    const result = await db.query("UPDATE users SET password_hash=$2, must_change_password=true WHERE id=$1 RETURNING id", [id, hash]);
    if (!result.rowCount) throw new HttpError(404, "NOT_FOUND", "User not found.");
    await db.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    await appendAudit(db, actor, "password_reset", id, "Temporary password set by an administrator. Existing sessions revoked.");
  }, true);
}
export async function changePassword(pool: pg.Pool, actor: User, config: Config, input: z.infer<typeof changePasswordSchema>) {
  return transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(20261002, 1)");
    const { rows } = await db.query<UserRow>("SELECT * FROM users WHERE id=$1 FOR UPDATE", [actor.id]);
    const current = rows[0];
    if (!current?.active) throw new HttpError(401, "SESSION_EXPIRED", "Your account is no longer active.");
    if (!await verifyPassword(input.currentPassword, current.password_hash)) throw new HttpError(400, "INCORRECT_PASSWORD", "The current password is incorrect.");
    if (input.currentPassword === input.newPassword) throw new HttpError(400, "PASSWORD_REUSE", "Choose a different password.");
    const hash = await hashPassword(input.newPassword);
    await db.query("UPDATE users SET password_hash=$2, must_change_password=false WHERE id=$1", [actor.id, hash]);
    await db.query("DELETE FROM sessions WHERE user_id=$1", [actor.id]);
    await appendAudit(db, actor, "password_changed", actor.id, "Password changed. All previous sessions revoked.");
    return issueSession(db, publicUser({ ...current, must_change_password: false }), config);
  });
}
