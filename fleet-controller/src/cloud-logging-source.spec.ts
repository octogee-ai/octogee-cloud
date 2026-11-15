import { describe, expect, it, vi } from "vitest";
import { createCloudLoggingSource } from "./cloud-logging-source.js";

describe("Cloud Logging log source", () => {
  it("lists entries from the configured resource and passes the page token through", async () => {
    const postJson = vi.fn(async () => ({ entries: [{ insertId: "a" }], nextPageToken: "p2" }));
    const signal = new AbortController().signal;
    const page = await createCloudLoggingSource("projects/central", postJson).list(
      { filter: "severity>=INFO", orderBy: "timestamp asc", pageSize: 1000, pageToken: "p1" },
      signal,
    );
    expect(postJson).toHaveBeenCalledWith(
      "https://logging.googleapis.com/v2/entries:list",
      { resourceNames: ["projects/central"], filter: "severity>=INFO", orderBy: "timestamp asc", pageSize: 1000, pageToken: "p1" },
      signal,
    );
    expect(page).toEqual({ entries: [{ insertId: "a" }], nextPageToken: "p2" });
  });

  it("treats a missing entry list and an empty page token as the end", async () => {
    const page = await createCloudLoggingSource("projects/central", async () => ({ nextPageToken: "" })).list(
      { filter: "x", orderBy: "timestamp desc", pageSize: 10 },
      new AbortController().signal,
    );
    expect(page).toEqual({ entries: [] });
  });
});
