import { defineConfig } from "vitest/config";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", assetsInlineLimit: 0, reportCompressedSize: true },
  worker: { format: "es" },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 120000 },
});
