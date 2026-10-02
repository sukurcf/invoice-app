import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../server/auth.js";
import { loadConfig } from "../server/config.js";

describe("startup configuration and password storage", () => {
  const database = "postgresql://app:example@localhost/invoices";
  it("requires a database connection and an exact trusted origin", () => {
    expect(() => loadConfig({})).toThrow("DATABASE_URL");
    expect(() => loadConfig({ DATABASE_URL: "https://example.com" })).toThrow("PostgreSQL");
    for (const origin of ["https://example.com/", "https://example.com/path", "ftp://example.com", "https://user:pass@example.com"]) {
      expect(() => loadConfig({ DATABASE_URL: database, APP_ORIGIN: origin })).toThrow("APP_ORIGIN");
    }
  });
  it("refuses insecure production configuration and enables Secure cookies", () => {
    expect(() => loadConfig({ NODE_ENV: "production", DATABASE_URL: database, APP_ORIGIN: "http://localhost:3000" })).toThrow("HTTPS");
    const config = loadConfig({ NODE_ENV: "production", DATABASE_URL: database, APP_ORIGIN: "https://invoices.example.test", TRUST_PROXY: "1" });
    expect(config.secureCookies).toBe(true);
    expect(config.trustProxy).toBe(1);
    expect(config.sessionHours).toBe(8);
    expect(() => loadConfig({ DATABASE_URL: database, TRUST_PROXY: "2" })).toThrow("TRUST_PROXY");
    expect(() => loadConfig({ DATABASE_URL: database, SESSION_HOURS: "48" })).toThrow("SESSION_HOURS");
  });
  it("salts passwords independently and never accepts corrupt password records", async () => {
    const first = await hashPassword("unique-test-passphrase");
    const second = await hashPassword("unique-test-passphrase");
    expect(first).not.toBe(second);
    expect(first).not.toContain("unique-test-passphrase");
    expect(await verifyPassword("unique-test-passphrase", first)).toBe(true);
    expect(await verifyPassword("incorrect", first)).toBe(false);
    await expect(verifyPassword("password", "corrupt-hash")).rejects.toThrow("Unsupported or corrupt");
  });
});
