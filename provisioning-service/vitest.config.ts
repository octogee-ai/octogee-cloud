import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    server: { deps: { inline: [/@octogee\/core\/dist\/mattermost\/provision\.js/] } },
  },
});
