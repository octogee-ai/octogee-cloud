import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { gitHost } from "../lib/git-host.js";

// Live gate for PLATFORM-CREDENTIAL-BROKERING PR2: the provisioner's Gitea ADMIN ops
// moved off the OpenClaw gateway container into this gateway-edge lib (the sidecar
// the in-pod provisioner now brokers through). No Gitea emulator exists, so exercise the
// real admin API — create user + register SSH key + create org/team/member + create repo —
// against live TEST Gitea, and self-clean. Catches real-Gitea contract drift the mocked
// unit tests can't. Runs only with RUN_LIVE=1 + GITEA_TOKEN (admin) + GITEA_URL set:
//
//   RUN_LIVE=1 GITEA_TOKEN=$(…admin secret…) GITEA_URL=http://localhost:3000 \
//     npx vitest run src/__tests__/gitea-admin.live.spec.ts
//
// (git-host.ts reads GITEA_URL/GITEA_TOKEN from env; GITEA_URL is the origin — the lib
// appends /api/v1.)

const RUN_LIVE = process.env.RUN_LIVE === "1" && !!process.env.GITEA_TOKEN;
const BASE = (process.env.GITEA_URL ?? "http://localhost:3000").replace(/\/$/, "") + "/api/v1";
const RID = (process.env.LIVE_TEST_RUN_ID ?? "x").toLowerCase().replace(/[^a-z0-9]/g, "").slice(-6) || "x";
const SLUG = `admlive${RID}`;
const USER = `ws-${SLUG}`;

function adminHeaders(): Record<string, string> {
  return { Authorization: `token ${process.env.GITEA_TOKEN}`, Accept: "application/json" };
}

function freshPubKey(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitea-admin-live-"));
  const keyPath = path.join(dir, "id_ed25519");
  try {
    execFileSync("/usr/bin/ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", `${USER}@live`, "-q"], { stdio: "pipe" });
    return fs.readFileSync(`${keyPath}.pub`, "utf-8").trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!RUN_LIVE)("gitea-admin — live against real Gitea (relocated provisioner ops)", () => {
  afterAll(async () => {
    await fetch(`${BASE}/repos/${SLUG}/workspace`, { method: "DELETE", headers: adminHeaders() }).catch(() => {});
    await fetch(`${BASE}/orgs/${SLUG}`, { method: "DELETE", headers: adminHeaders() }).catch(() => {});
    await fetch(`${BASE}/admin/users/${USER}?purge=true`, { method: "DELETE", headers: adminHeaders() }).catch(() => {});
  });

  it("keeps predecessor and successor pod keys readable back (idempotent)", async () => {
    const predecessor = freshPubKey();
    const successor = freshPubKey();
    await gitHost().registerKey(SLUG, predecessor);
    await gitHost().registerKey(SLUG, successor);
    expect(await gitHost().listKeys(SLUG)).toEqual(
      expect.arrayContaining([predecessor, successor]),
    );
    await gitHost().registerKey(SLUG, successor);
    expect(await gitHost().listKeys(SLUG)).toEqual(
      expect.arrayContaining([predecessor, successor]),
    );
    await gitHost().releaseKey(SLUG, predecessor);
    expect(await gitHost().listKeys(SLUG)).toEqual([successor]);
  }, 30_000);

  it("ensures org + users team + member, then creates the workspace repo (idempotent)", async () => {
    await gitHost().ensureOwner(SLUG);
    await gitHost().ensureOwner(SLUG); // 422-tolerant re-ensure

    expect(await gitHost().repoExists({ owner: SLUG, repo: "workspace" })).toBe(false);
    await gitHost().ensureRepo(SLUG, { kind: "workspace" });
    await gitHost().ensureRepo(SLUG, { kind: "workspace" }); // 409-tolerant re-ensure
    expect(await gitHost().repoExists({ owner: SLUG, repo: "workspace" })).toBe(true);
    expect(await gitHost().repoExists({ owner: SLUG, repo: "no-such-repo" })).toBe(false);
  }, 30_000);
});
