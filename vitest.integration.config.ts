import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "postgres-api",
    environment: "node",
    include: ["tests/**/*.integration.test.ts"],
    globalSetup: "./tests/global-setup.ts",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    maxWorkers: 1,
    coverage: {
      provider: "v8",
      include: ["server/{accounts,app,auth,catalog,config,database,invoices,repository,seed}.ts"],
      reportsDirectory: "coverage/api",
      reporter: ["text", "html", "lcov"],
      thresholds: { lines: 85, statements: 85, functions: 90, branches: 80 },
    },
  },
});
