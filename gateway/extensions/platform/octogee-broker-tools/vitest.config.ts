import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({ root: fileURLToPath(new URL(".", import.meta.url)), resolve: { alias: {
  "openclaw/plugin-sdk/agent-runtime": fileURLToPath(new URL("./__tests__/agent-sdk.ts", import.meta.url)),
  "openclaw/plugin-sdk/provider-auth-runtime": fileURLToPath(new URL("./__tests__/auth-sdk.ts", import.meta.url)),
} }, test: { include: ["__tests__/**/*.spec.ts"] } });
