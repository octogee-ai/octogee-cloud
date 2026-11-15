import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  desiredUsers,
  snapshotConfigFingerprint,
} from "../lib/snapshot-fingerprint.js";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import { staticUserEntitlements } from "@octogee/shared/types/user-entitlements";
import { userSnapshot as snap } from "./fixtures/user-snapshot.js";
import { installUserEntitlementsForTest, planUserEntitlements } from "./helpers/user-entitlements.js";

const PAID = { plan: "pro" };
const PLAN_ENDS_AT = Date.parse("2026-07-01T00:00:00Z");
const BEFORE_PLAN_ENDS = new Date(PLAN_ENDS_AT - 86_400_000);
const AFTER_PLAN_ENDS = new Date(PLAN_ENDS_AT + 86_400_000);
const TIME_BOXED = { plan: "pro", planEndsAt: PLAN_ENDS_AT };

describe("snapshotConfigFingerprint", () => {
  beforeEach(() => installUserEntitlementsForTest(planUserEntitlements));

  it("is stable for the same config-affecting content", () => {
    expect(snapshotConfigFingerprint(snap())).toBe(snapshotConfigFingerprint(snap()));
  });

  it("reconciles a legacy GitHub-backed agent after import even when checkout stays disabled", () => {
    const snapshot = snap({
      projects: [{ projectSlug: "orbit", giteaRepoName: "orbit", checkoutEnabled: false, repoSource: { provider: "github", owner: "alice", repo: "orbit" } }],
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot", token: "pat" }],
    });
    const before = snapshotConfigFingerprint(snapshot);
    snapshot.projectAgents![0].githubBacked = true;
    expect(snapshotConfigFingerprint(snapshot)).not.toBe(before);
  });

  it("ignores fields that do not affect the generated gateway config", () => {
    const base = snapshotConfigFingerprint(snap());
    expect(snapshotConfigFingerprint(snap({ status: "provisioning" }))).toBe(base);
    expect(snapshotConfigFingerprint(snap({ repoUrl: "https://other" }))).toBe(base);
    expect(snapshotConfigFingerprint(snap({ email: "new@example.com" }))).toBe(base);
    expect(snapshotConfigFingerprint(snap({ ownerName: "Alicia" }))).toBe(base);
  });

  it("is order-independent for channels", () => {
    const a = snap({
      channels: [
        { scope: "workspace", kind: "general", channelId: "wsgen" },
        { scope: "project", kind: "general", channelId: "projgen", projectId: "camp" },
      ],
    });
    const b = snap({
      channels: [
        { scope: "project", kind: "general", channelId: "projgen", projectId: "camp" },
        { scope: "workspace", kind: "general", channelId: "wsgen" },
      ],
    });
    expect(snapshotConfigFingerprint(a)).toBe(snapshotConfigFingerprint(b));
  });

  it("changes when a project agent is enabled (the multi-agent toggle)", () => {
    const off = snap({ projectAgents: [] });
    const on = snap({
      projectAgents: [{ projectId: "camp", enabled: true, mmUserId: "mm-proj", token: "proj-pat" }],
    });
    expect(snapshotConfigFingerprint(on)).not.toBe(snapshotConfigFingerprint(off));
  });

  it("changes when a project agent's minted token changes", () => {
    const before = snap({
      projectAgents: [{ projectId: "camp", enabled: true, mmUserId: "mm-proj", token: "pat-1" }],
    });
    const after = snap({
      projectAgents: [{ projectId: "camp", enabled: true, mmUserId: "mm-proj", token: "pat-2" }],
    });
    expect(snapshotConfigFingerprint(before)).not.toBe(snapshotConfigFingerprint(after));
  });

  it("reconciles a newly minted project activation even if other configuration is unchanged", () => {
    const project = { projectId: "camp", enabled: true, mmUserId: "mm-proj", token: "pat-1" };
    expect(snapshotConfigFingerprint(snap({ projectAgents: [{ ...project, activationId: "activation-1" }] })))
      .not.toBe(snapshotConfigFingerprint(snap({ projectAgents: [{ ...project, activationId: "activation-2" }] })));
  });

  it("changes when a channel is added or removed", () => {
    const base = snapshotConfigFingerprint(snap());
    const extra = snap({
      channels: [
        { scope: "workspace", kind: "general", channelId: "wsgen" },
        { scope: "project", kind: "general", channelId: "projgen", projectId: "camp" },
        { scope: "project", kind: "general", channelId: "projgen2", projectId: "other" },
      ],
    });
    expect(snapshotConfigFingerprint(extra)).not.toBe(base);
  });

  it("changes when the user's time zone changes (USER.md is re-synced at reassert)", () => {
    expect(snapshotConfigFingerprint(snap({ timeZone: "America/Chicago" }))).not.toBe(snapshotConfigFingerprint(snap()));
    expect(snapshotConfigFingerprint(snap({ timeZone: null }))).toBe(snapshotConfigFingerprint(snap()));
  });

  it("changes when the plan the inputs resolve to changes (an upgrade must reconverge model picks)", () => {
    const base = snapshotConfigFingerprint(snap());
    expect(snapshotConfigFingerprint(snap({ planInputs: PAID }))).not.toBe(base);
    expect(snapshotConfigFingerprint(snap({ planInputs: { plan: "team" } })))
      .not.toBe(snapshotConfigFingerprint(snap({ planInputs: PAID })));
    expect(snapshotConfigFingerprint(snap({ planInputs: TIME_BOXED }), BEFORE_PLAN_ENDS))
      .not.toBe(snapshotConfigFingerprint(snap(), BEFORE_PLAN_ENDS));
  });

  it("changes when a plan ends — the inputs resolve to a different plan", () => {
    expect(snapshotConfigFingerprint(snap({ planInputs: TIME_BOXED }), AFTER_PLAN_ENDS))
      .not.toBe(snapshotConfigFingerprint(snap({ planInputs: PAID }), AFTER_PLAN_ENDS));
  });

  it("ignores billing renewal noise — inputs that resolve to the same plan fingerprint the same", () => {
    const base = snapshotConfigFingerprint(snap({ planInputs: PAID }));
    expect(snapshotConfigFingerprint(snap({ planInputs: { ...PAID, renewedAt: 1234 } }))).toBe(base);
    expect(snapshotConfigFingerprint(snap({ planInputs: { ...PAID, renewedAt: 5678, latestInvoiceId: "in_2" } })))
      .toBe(base);
  });

  it("re-ensures a mounted user when a time-boxed plan lapses with its inputs unchanged", () => {
    const timeBoxed = snap({ planInputs: TIME_BOXED });
    expect(snapshotConfigFingerprint(timeBoxed, AFTER_PLAN_ENDS))
      .not.toBe(snapshotConfigFingerprint(timeBoxed, BEFORE_PLAN_ENDS));
  });

  it("is stable over time while the plan the inputs resolve to stays the same", () => {
    const timeBoxed = snap({ planInputs: TIME_BOXED });
    const earlierBeforeEnd = new Date(BEFORE_PLAN_ENDS.getTime() - 2 * 86_400_000);
    const laterAfterEnd = new Date(AFTER_PLAN_ENDS.getTime() + 30 * 86_400_000);
    expect(snapshotConfigFingerprint(timeBoxed, earlierBeforeEnd))
      .toBe(snapshotConfigFingerprint(timeBoxed, BEFORE_PLAN_ENDS));
    expect(snapshotConfigFingerprint(timeBoxed, laterAfterEnd))
      .toBe(snapshotConfigFingerprint(timeBoxed, AFTER_PLAN_ENDS));
    expect(snapshotConfigFingerprint(snap({ planInputs: PAID }), laterAfterEnd))
      .toBe(snapshotConfigFingerprint(snap({ planInputs: PAID }), BEFORE_PLAN_ENDS));
  });

  it("asks the entitlement resolver what the inputs mean and never reads inside the bag", () => {
    installUserEntitlementsForTest(staticUserEntitlements);
    expect(snapshotConfigFingerprint(snap({ planInputs: PAID }))).toBe(snapshotConfigFingerprint(snap()));
  });

  it("ignores a plan field that sits beside the bag", () => {
    const beside = { ...snap(), ...PAID };
    expect(snapshotConfigFingerprint(beside as FleetBrokerUserSnapshot)).toBe(snapshotConfigFingerprint(snap()));
  });

  it("changes when the seed context template changes", () => {
    expect(snapshotConfigFingerprint(snap({ contextTemplateKey: "free" }))).not.toBe(snapshotConfigFingerprint(snap()));
  });

  it("changes when the operator flips the house model dial (fleet-wide re-pin within a tick)", () => {
    const base = snapshotConfigFingerprint(snap());
    expect(
      snapshotConfigFingerprint(
        snap({ freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro" }),
      ),
    ).not.toBe(base);
  });

  it("changes when the operator flips the user Agent default dial", () => {
    const base = snapshotConfigFingerprint(snap());
    expect(
      snapshotConfigFingerprint(
        snap({
          builderAgentDefault: {
            primary: "platform-openrouter/deepseek/deepseek-v4-pro",
            fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
          },
        }),
      ),
    ).not.toBe(base);
  });

  it("changes when a project flips provisioning→active — the clone only ever runs for active projects", () => {
    const provisioning = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "provisioning" }],
    });
    const active = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
    });
    expect(snapshotConfigFingerprint(active)).not.toBe(snapshotConfigFingerprint(provisioning));
  });

  it("changes when the owner turns a project's checkout off — the toggle must converge on the next tick, not only on remount", () => {
    const on = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
    });
    const off = snap({
      projects: [{
        projectSlug: "camp",
        giteaRepoName: "alice-camp",
        provisioningState: "active",
        checkoutEnabled: false,
      }],
    });
    expect(snapshotConfigFingerprint(off)).not.toBe(snapshotConfigFingerprint(on));
  });

  it("treats an absent checkoutEnabled as on — existing project docs carry no flag and must not re-converge", () => {
    const absent = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
    });
    const explicitlyOn = snap({
      projects: [{
        projectSlug: "camp",
        giteaRepoName: "alice-camp",
        provisioningState: "active",
        checkoutEnabled: true,
      }],
    });
    expect(snapshotConfigFingerprint(explicitlyOn)).toBe(snapshotConfigFingerprint(absent));
  });

  it("changes when a project appears — a new project must converge its pod checkout", () => {
    const base = snapshotConfigFingerprint(snap({ projects: [] }));
    expect(
      snapshotConfigFingerprint(
        snap({
          projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
        }),
      ),
    ).not.toBe(base);
  });

  it("ignores project checkout drift for workspace-only snapshots while retaining project config drift", () => {
    const withoutProject = snap({
      projectCheckoutScope: "workspace-only",
      projects: [],
    });
    const withProject = snap({
      projectCheckoutScope: "workspace-only",
      projects: [
        { projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" },
      ],
    });

    expect(snapshotConfigFingerprint(withProject)).toBe(
      snapshotConfigFingerprint(withoutProject),
    );
    expect(snapshotConfigFingerprint(withProject)).not.toBe(
      snapshotConfigFingerprint(snap({
        ...withProject,
        projectAgents: [
          { projectId: "camp", enabled: true, mmUserId: "mm-camp", token: "pat-camp" },
        ],
      })),
    );
  });

  it("changes when a project connects a GitHub repo — the pod must re-point its checkout", () => {
    const gitea = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
    });
    const github = snap({
      projects: [
        {
          projectSlug: "camp",
          giteaRepoName: "alice-camp",
          provisioningState: "active",
          repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
        },
      ],
    });
    expect(snapshotConfigFingerprint(github)).not.toBe(snapshotConfigFingerprint(gitea));
  });

  it("changes when the connected GitHub repo is swapped", () => {
    const project = (repo: string) => snap({
      projects: [
        {
          projectSlug: "camp",
          giteaRepoName: null,
          provisioningState: "active",
          repoSource: { provider: "github", owner: "octogee-ai", repo },
        },
      ],
    });
    expect(snapshotConfigFingerprint(project("demo"))).not.toBe(
      snapshotConfigFingerprint(project("other")),
    );
  });

  it("counts a GitHub-backed project with no Gitea repo as clone drift", () => {
    const base = snapshotConfigFingerprint(snap({ projects: [] }));
    expect(
      snapshotConfigFingerprint(
        snap({
          projects: [
            {
              projectSlug: "camp",
              giteaRepoName: null,
              provisioningState: "active",
              repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
            },
          ],
        }),
      ),
    ).not.toBe(base);
  });

  it("changes when a project's repo is first provisioned — no repo name means nothing to clone", () => {
    const noRepo = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: null, provisioningState: "active" }],
    });
    const withRepo = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
    });
    expect(snapshotConfigFingerprint(withRepo)).not.toBe(snapshotConfigFingerprint(noRepo));
  });

  it("does NOT change when a project fails — a failed project is never cloned, so it is not drift", () => {
    const provisioning = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "provisioning" }],
    });
    const failed = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "failed" }],
    });
    expect(snapshotConfigFingerprint(failed)).toBe(snapshotConfigFingerprint(provisioning));
  });

  it("does NOT change on a repo rename — cloneProjectRepo skips any path that already has .git, so calling it drift would only stamp a fresh fingerprint over a stale checkout", () => {
    const before = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" }],
    });
    const renamed = snap({
      projects: [{ projectSlug: "camp", giteaRepoName: "alice-camp-v2", provisioningState: "active" }],
    });
    expect(snapshotConfigFingerprint(renamed)).toBe(snapshotConfigFingerprint(before));
  });

  it("is order-independent for projects", () => {
    const p = (slug: string) => ({
      projectSlug: slug,
      giteaRepoName: `alice-${slug}`,
      provisioningState: "active",
    });
    const a = snap({ projects: [p("camp"), p("dune")] });
    const b = snap({ projects: [p("dune"), p("camp")] });
    expect(snapshotConfigFingerprint(a)).toBe(snapshotConfigFingerprint(b));
  });

  it("changes when the agent identity, token, or model config changes", () => {
    const base = snapshotConfigFingerprint(snap());
    expect(snapshotConfigFingerprint(snap({ coachIdentity: { name: "Buddy", emoji: "🐶" } }))).not.toBe(base);
    expect(snapshotConfigFingerprint(snap({ coachToken: "rotated-pat" }))).not.toBe(base);
    expect(
      snapshotConfigFingerprint(snap({ systemConfig: { byot: { provider: "anthropic", model: "claude" } } })),
    ).not.toBe(base);
  });
});

describe("desiredUsers", () => {
  it("returns slug→fingerprint for every snapshot AND seeds each snapshot into the adapter cache", () => {
    const seed = vi.fn();
    const users = [snap(), snap({ uid: "u2", slug: "bob" })];

    const map = desiredUsers(users, [
      { uid: "u1", state: "serving", epoch: 1 },
      { uid: "u2", state: "serving", epoch: 1 },
    ], seed);

    expect([...map.keys()].sort()).toEqual(["alice", "bob"]);
    expect(map.get("alice")?.fingerprint).toBe(snapshotConfigFingerprint(users[0]));
    // Every fingerprinted snapshot is seeded — the ensure that a drift triggers must
    // apply exactly the content the fingerprint described, not a stale cache entry.
    expect(seed).toHaveBeenCalledTimes(2);
    expect(seed).toHaveBeenCalledWith(users[0]);
    expect(seed).toHaveBeenCalledWith(users[1]);
  });

  it("tolerates an absent seeder (operator-style callers without a cache)", () => {
    const map = desiredUsers([snap()], [{ uid: "u1", state: "serving", epoch: 1 }]);
    expect(map.size).toBe(1);
  });

  it("lanes a user that has completed provisioning as a move and an unprovisioned one as a create", () => {
    const map = desiredUsers([
      snap({ status: "complete" }),
      snap({ uid: "u2", slug: "bob", status: "provisioning" }),
      snap({ uid: "u3", slug: "cara", status: "" }),
    ], [
      { uid: "u1", state: "serving", epoch: 1 },
      { uid: "u2", state: "serving", epoch: 1 },
      { uid: "u3", state: "migrating", epoch: 1 },
    ]);
    expect(map.get("alice")?.lane).toBe("move");
    expect(map.get("bob")?.lane).toBe("create");
    expect(map.get("cara")?.lane).toBe("create");
  });
});

it('refreshes runtime identity and retries delivery when project onboarding changes', () => {
  const p = { projectId: 'camp', enabled: true, mmUserId: 'mm', token: 'pat' };
  const original = snapshotConfigFingerprint(snap({ projectAgents: [p] }));
  expect(snapshotConfigFingerprint(snap({ projectAgents: [{ ...p, identity: { name: 'Chip', emoji: '⛳', persona: 'Caddie' } }] }))).not.toBe(original);
  expect(snapshotConfigFingerprint(snap({ projectAgents: [{ ...p, deliveryPending: true }] }))).not.toBe(original);
});
