import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../../.github/workflows/build-main.yml", import.meta.url), "utf8"));

it("lets a running automatic main build finish while a newer push waits behind it", () => {
  expect(workflow.concurrency["cancel-in-progress"] ?? false).toBe(false);
});

it("queues pushes in one shared group and gives every dispatched build its own", () => {
  expect(workflow.concurrency.group).toBe("build-main-${{ github.event_name == 'push' && 'automatic' || github.run_id }}");
});
