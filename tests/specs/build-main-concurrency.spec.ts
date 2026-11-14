import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

type Job = { concurrency?: { group: string; "cancel-in-progress"?: boolean } };
const workflow = parse(readFileSync(new URL("../../.github/workflows/build-main.yml", import.meta.url), "utf8"));
const jobs = workflow.jobs as Record<string, Job>;
const queue = "${{ github.event_name == 'push' && 'automatic' || github.run_id }}";

it("holds a waiting push only behind the jobs that build and publish images, not the checks after them", () => {
  expect(workflow.concurrency).toBeUndefined();
  expect(Object.keys(jobs).filter(name => jobs[name].concurrency)).toEqual(["images", "publish"]);
});

it("lets a running image build or publish finish while only the newest push waits behind it", () => {
  for (const name of ["images", "publish"]) expect(jobs[name].concurrency?.["cancel-in-progress"] ?? false).toBe(false);
});

it("queues each platform's image build apart, and gives every dispatched build its own groups", () => {
  expect(jobs.images.concurrency?.group).toBe(`build-main-images-\${{ matrix.arch }}-${queue}`);
  expect(jobs.publish.concurrency?.group).toBe(`build-main-publish-${queue}`);
});
