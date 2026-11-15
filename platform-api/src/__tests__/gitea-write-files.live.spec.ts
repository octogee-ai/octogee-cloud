import { afterAll, describe, expect, it } from "vitest";

import { gitHost } from "../lib/git-host.js";
import { createProjectGiteaRepo, giteaWriteFiles } from "@octogee/core/git-host/gitea-client";

// giteaWriteFiles drives Gitea's batch ChangeFiles endpoint (POST /repos/{org}/{repo}/contents),
// which every unit spec mocks away — so its wire contract is only ever exercised here. No Gitea
// emulator exists; run against live TEST Gitea and self-clean. Catches real-Gitea contract drift
// (operation/base64/branch) that the mocked specs structurally cannot. RUN_LIVE=1 + GITEA_TOKEN:
//
//   RUN_LIVE=1 GITEA_TOKEN=$(…admin secret…) GITEA_URL=http://localhost:3000 \
//     npx vitest run src/__tests__/gitea-write-files.live.spec.ts

const RUN_LIVE = process.env.RUN_LIVE === "1" && !!process.env.GITEA_TOKEN;
const BASE = (process.env.GITEA_URL ?? "http://localhost:3000").replace(/\/$/, "") + "/api/v1";
const RID = (process.env.LIVE_TEST_RUN_ID ?? "x").toLowerCase().replace(/[^a-z0-9]/g, "").slice(-6) || "x";
const SLUG = `seedlive${RID}`;
const REPO = "playbook";

const SEEDS = [
  { path: "DECISIONS.md", content: "# Decisions — Live\n" },
  { path: "runbook/how-we-build.md", content: "# How we build Live\n" },
  { path: "notes/welcome.md", content: "# Welcome to notes\n" },
];

function adminHeaders(): Record<string, string> {
  return { Authorization: `token ${process.env.GITEA_TOKEN}`, Accept: "application/json" };
}

async function commitMessages(): Promise<string[]> {
  const resp = await fetch(`${BASE}/repos/${SLUG}/${REPO}/commits?sha=main&limit=50`, {
    headers: adminHeaders(),
  });
  const commits = (await resp.json()) as Array<{ commit: { message: string } }>;
  return commits.map((c) => c.commit.message.trim());
}

async function fileContent(filePath: string): Promise<string | null> {
  const resp = await fetch(`${BASE}/repos/${SLUG}/${REPO}/contents/${filePath}`, {
    headers: adminHeaders(),
  });
  if (!resp.ok) return null;
  const body = (await resp.json()) as { content?: string };
  return body.content ? Buffer.from(body.content, "base64").toString("utf-8") : null;
}

describe.skipIf(!RUN_LIVE)("giteaWriteFiles — live batch ChangeFiles against real Gitea", () => {
  afterAll(async () => {
    await fetch(`${BASE}/repos/${SLUG}/${REPO}`, { method: "DELETE", headers: adminHeaders() }).catch(() => {});
    await fetch(`${BASE}/orgs/${SLUG}`, { method: "DELETE", headers: adminHeaders() }).catch(() => {});
  });

  it("writes every seed — including nested paths — in a single commit, then no-ops on re-entry", async () => {
    await gitHost().ensureOwner(SLUG);
    await createProjectGiteaRepo(SLUG, REPO, "live seed test", true);

    const before = await commitMessages();

    await giteaWriteFiles(SLUG, REPO, SEEDS, "auto: seed project playbook");

    for (const seed of SEEDS) {
      expect(await fileContent(seed.path), `${seed.path} should be written`).toBe(seed.content);
    }

    const after = await commitMessages();
    expect(after.length).toBe(before.length + 1);
    expect(after[0]).toBe("auto: seed project playbook");

    // Re-entry (a retried provision) must add no commit and must not throw.
    await giteaWriteFiles(SLUG, REPO, SEEDS, "auto: seed project playbook");
    expect(await commitMessages()).toEqual(after);
  }, 60_000);
});
