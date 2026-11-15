import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

const CORE = "@octogee/core/";
const coreExports = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).exports as Record<string, { default: string }>;

function coreFromSource(): Plugin {
  return {
    name: "core-from-source",
    enforce: "pre",
    resolveId(id) {
      if (!id.startsWith(CORE)) return null;
      const target = coreExports[`./${id.slice(CORE.length)}`];
      if (!target) throw new Error(`@octogee/core does not export ${id}`);
      return fileURLToPath(new URL(target.default.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts"), import.meta.url));
    },
  };
}

export default defineConfig({
  plugins: [coreFromSource()],
  test: {
    include: ["src/**/*.spec.ts"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    server: { deps: { inline: ["@octogee/core-testing"] } },
  },
});
