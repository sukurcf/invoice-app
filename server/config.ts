import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url().refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol), "Use a PostgreSQL connection URL."),
  APP_ORIGIN: z.url().default("http://localhost:5173").refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value && !url.username && !url.password;
  }, "APP_ORIGIN must be an exact HTTP(S) origin with no trailing slash."),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  TRUST_PROXY: z.coerce.number().int().min(0).max(1).default(0),
  SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "silent"]).default("info"),
}).refine((value) => value.NODE_ENV !== "production" || value.APP_ORIGIN.startsWith("https://"), { message: "Production requires an HTTPS APP_ORIGIN.", path: ["APP_ORIGIN"] });

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const env = parsed.data;
  return {
    environment: env.NODE_ENV, databaseUrl: env.DATABASE_URL, origin: env.APP_ORIGIN,
    port: env.PORT, host: env.HOST, trustProxy: env.TRUST_PROXY,
    sessionHours: env.SESSION_HOURS, logLevel: env.LOG_LEVEL, secureCookies: env.NODE_ENV === "production",
  };
}
export type Config = ReturnType<typeof loadConfig>;
