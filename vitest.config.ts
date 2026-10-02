import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.{ts,tsx}"],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/domain/**/*.ts", "src/services/invoiceChecks.ts", "src/utils/csv.ts", "src/state/**/*.tsx", "src/screens/**/*.tsx", "src/components/**/*.tsx"],
      exclude: ["src/domain/types.ts", "src/domain/api.ts"],
      reporter: ["text", "html", "lcov"],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 75 },
    },
  },
});
