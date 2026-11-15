import { describe, it, expect, vi, type Mock } from "vitest";
import {
  buildUpgradeArgs,
  createHelmSubprocessRunner,
  isRetryableUninstallFailure,
  readPersonalKnobs,
  spawnHelm,
  type HelmSubprocess,
} from "../helm-runner";

function mockSubprocess(
  responses: Array<{ stdout?: string; stderr?: string; code?: number }>,
): { runHelm: Mock<HelmSubprocess>; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const runHelm = vi.fn<HelmSubprocess>(async (args) => {
    calls.push(args);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      code: r.code ?? 0,
    };
  });
  return { runHelm, calls };
}

function withPreflightStatusNotFound(inner: HelmSubprocess): HelmSubprocess {
  return async (args: string[]) => {
    if (args[0] === "status") {
      return { stdout: "", stderr: "Error: release: not found", code: 1 };
    }
    return inner(args);
  };
}

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

describe("helm-runner helpers", () => {
  it("reads supported personal knobs while dropping invalid values from helm values", () => {
    expect(readPersonalKnobs({
      serviceAccountName: "octogee-gateway-walter",
      serviceAccount: { annotations: { "iam.gke.io/gcp-service-account": "gw@example.iam.gserviceaccount.com" } },
      gatewayContainerSecurityContext: { allowPrivilegeEscalation: false },
      builderAccess: { enabled: true, audiences: ["octogee-api"] },
      profile: "isolated",
      gatewayClass: "isolated",
      imageProfile: "isolated",
      sizingTier: "l",
      replicas: 0,
    })).toEqual({
      serviceAccountName: "octogee-gateway-walter",
      serviceAccount: { annotations: { "iam.gke.io/gcp-service-account": "gw@example.iam.gserviceaccount.com" } },
      gatewayContainerSecurityContext: { allowPrivilegeEscalation: false },
      builderAccess: { enabled: true, audiences: ["octogee-api"] },
      profile: "isolated",
      gatewayClass: "isolated",
      imageProfile: "isolated",
      sizingTier: "l",
      replicas: 0,
    });

    expect(readPersonalKnobs({
      serviceAccountName: "",
      serviceAccount: [],
      gatewayContainerSecurityContext: null,
      profile: "admin",
      gatewayClass: "unknown",
      imageProfile: "debug",
      sizingTier: "tiny",
      replicas: 1.5,
    })).toEqual({});
  });

  it("reads isolated class and profile knobs from deployed values the same as builder", () => {
    const knobs = (value: string) => readPersonalKnobs({ profile: value, gatewayClass: value, imageProfile: value });
    expect(knobs("isolated")).toEqual(knobs("builder"));
    expect(knobs("isolated")).toEqual({ profile: "isolated", gatewayClass: "isolated", imageProfile: "isolated" });
  });

  it("drops a residual computeClassOverride left in a deployed release's values", () => {
    const residue = { gatewayId: "walter", computeClassOverride: "octogee-gateway-spot" };
    expect(readPersonalKnobs(residue)).toEqual({});
  });

  it("builds upgrade args with string, numeric, JSON, and values-file knobs", () => {
    const args = buildUpgradeArgs({
      release: "octogee-gw-walter",
      chartPath: "/charts/octogee-gateway",
      namespace: "octogee",
      gatewayId: "walter",
      imageTag: "3280519",
      imageRepository: REPO,
      upgradeTimeout: "10m",
      chartFingerprint: "f".repeat(64),
      deploymentIntentFingerprint: "d".repeat(64),
      rollStrategy: "surge",
      profile: "isolated",
      gatewayClass: "isolated",
      imageProfile: "isolated",
      sizingTier: "l",
      replicas: 0,
      serviceAccountName: "octogee-gateway-walter",
      serviceAccount: { annotations: { "iam.gke.io/gcp-service-account": "gw@example.iam.gserviceaccount.com" } },
      gatewayContainerSecurityContext: { allowPrivilegeEscalation: false },
      builderAccess: { controlUiEnabled: true },
      gcpProject: "builder-walter",
      kmsKeyName: "projects/octogee/locations/us-central1/keyRings/octogee-creds/cryptoKeys/integrations-at-rest",
      deploymentTargetId: "prod-central",
      deploymentProjectId: "octogee",
      gatewayServiceAccount: "octogee-gateway@octogee.iam.gserviceaccount.com",
      valuesFile: "/charts/octogee-gateway/values.prod.yaml",
    });

    const stringPair = (key: string): string | undefined => {
      const idx = args.findIndex((arg, index) => arg === "--set-string" && args[index + 1]?.startsWith(`${key}=`));
      return idx === -1 ? undefined : args[idx + 1];
    };
    expect(stringPair("gatewayId")).toBe("gatewayId=walter");
    expect(stringPair("imageTag")).toBe("imageTag=3280519");
    expect(stringPair("serviceAccountName")).toBe("serviceAccountName=octogee-gateway-walter");
    expect(stringPair("deploymentIntentFingerprint")).toBe(
      `deploymentIntentFingerprint=${"d".repeat(64)}`,
    );
    expect(stringPair("rollStrategy")).toBe("rollStrategy=surge");
    expect(stringPair("gatewayEdge.env.OCTOGEE_KMS_KEY_NAME")).toBe(
      "gatewayEdge.env.OCTOGEE_KMS_KEY_NAME=projects/octogee/locations/us-central1/keyRings/octogee-creds/cryptoKeys/integrations-at-rest",
    );
    expect(stringPair("env.firebaseProjectId")).toBe("env.firebaseProjectId=octogee");
    expect(stringPair("gatewayEdge.env.FIREBASE_PROJECT_ID")).toBe(
      "gatewayEdge.env.FIREBASE_PROJECT_ID=octogee",
    );
    expect(stringPair("gatewayEdge.env.DEPLOYMENT_TARGET_ID")).toBe(
      "gatewayEdge.env.DEPLOYMENT_TARGET_ID=prod-central",
    );
    expect(stringPair("gatewayEdge.env.GATEWAY_SERVICE_ACCOUNT")).toBe(
      "gatewayEdge.env.GATEWAY_SERVICE_ACCOUNT=octogee-gateway@octogee.iam.gserviceaccount.com",
    );
    expect(args).toContain("--set");
    expect(args).toContain("replicas=0");
    expect(args).toContain(
      'serviceAccount={"annotations":{"iam.gke.io/gcp-service-account":"gw@example.iam.gserviceaccount.com"}}',
    );
    expect(args).toContain('builderAccess={"controlUiEnabled":true}');
    expect(args).toContain("-f");
    expect(args).toContain("/charts/octogee-gateway/values.prod.yaml");
    expect(args).toContain("--take-ownership");
    expect(args).toContain("--server-side=true");
    expect(args).toContain("--force-conflicts");
    expect(args).toContain("--wait");
    expect(args).toContain("--timeout=10m");
  });

  it("overrides inherited Mattermost DNS with the exact release namespace", () => {
    const args = buildUpgradeArgs({
      release: "octogee-gw-default",
      chartPath: "/charts/octogee-gateway",
      namespace: "octogee-test",
      gatewayId: "default",
      imageTag: "abc1234",
      imageRepository: REPO,
      upgradeTimeout: "10m",
      valuesFile: "/charts/octogee-gateway/values.test.yaml",
    });

    expect(args).toContain(
      "env.mmInternalUrl=http://mattermost.octogee-test.svc.cluster.local:8065",
    );
    expect(args).not.toContain("env.mmInternalUrl=http://mattermost.octogee.svc.cluster.local:8065");
  });

  it("never passes user owner identity to the chart", () => {
    const args = buildUpgradeArgs({
      release: "octogee-gw-trial-op-000001",
      chartPath: "/charts/octogee-gateway",
      namespace: "octogee-test",
      gatewayId: "trial-op-000001",
      imageTag: "abc1234",
      imageRepository: REPO,
      upgradeTimeout: "10m",
      gatewayClass: "isolated",
    });

    expect(args.some((arg) => arg.startsWith("ownerUid="))).toBe(false);
    expect(args.some((arg) => arg.startsWith("builderSlug="))).toBe(false);
  });

  // Regression: a leftover resource (e.g. a hand-created operator WI SA) without
  // Helm ownership metadata wedged a walter blue/green roll forever. The fleet controller owns
  // every gateway resource, so the upgrade must ALWAYS --take-ownership, with no
  // opt-in knob to forget.
  it("always passes --take-ownership so a leftover unowned resource can't wedge the roll", () => {
    const args = buildUpgradeArgs({
      release: "octogee-gw-walter-green",
      chartPath: "/charts/octogee-gateway",
      namespace: "octogee",
      gatewayId: "walter-green",
      imageTag: "abc1234",
      imageRepository: REPO,
      upgradeTimeout: "10m",
    });
    expect(args).toContain("--take-ownership");
  });

  it("can apply a surge upgrade without waiting for the controller-owned readiness gate", () => {
    const args = buildUpgradeArgs({
      release: "octogee-gw-walter",
      chartPath: "/charts/octogee-gateway",
      namespace: "octogee-test",
      gatewayId: "walter",
      imageTag: "def5678",
      imageRepository: REPO,
      upgradeTimeout: "10m",
      waitForReady: false,
    });
    expect(args).not.toContain("--wait");
    expect(args).toContain("--timeout=10m");
  });

  it("renders a digest-bound gateway and gateway-edge release", () => {
    const gatewayTag = `a408f2f-oc2026.7.1@sha256:${"a".repeat(64)}`;
    const gatewayEdgeTag = `a408f2f-oc2026.7.1@sha256:${"b".repeat(64)}`;

    const args = buildUpgradeArgs({
      release: "octogee-gw-default",
      chartPath: "/charts/octogee-gateway",
      namespace: "octogee-test",
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: gatewayTag,
      gatewayEdgeImageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge",
      gatewayEdgeImageTag: gatewayEdgeTag,
      upgradeTimeout: "10m",
    });

    expect(args).toContain(`imageTag=${gatewayTag}`);
    expect(args).toContain(`gatewayEdge.image.tag=${gatewayEdgeTag}`);
  });

});

describe("createHelmSubprocessRunner — readDeployedInstances", () => {
  it.each(["deployed", "failed", "pending-install", "pending-upgrade", "pending-rollback", "uninstalling"])("reads a %s gateway release without listing the fleet", async (status) => {
    const { runHelm, calls } = mockSubprocess([
      { stdout: JSON.stringify({ info: { status } }) },
      {
        stdout: JSON.stringify({
          gatewayId: "default",
          imageTag: "abc1234",
          image: { repository: REPO },
        }),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    const instance = await runner.readDeployedInstance({
      namespace: "octogee-test",
      gatewayId: "default",
    });

    expect(calls).toEqual([[
      "status", "octogee-gw-default", "-n", "octogee-test", "-o", "json",
    ], [
      "get",
      "values",
      "octogee-gw-default",
      "-n",
      "octogee-test",
      "-o",
      "json",
    ]]);
    expect(instance).toEqual({
      enabled: true,
      image: { repository: REPO, tag: "abc1234" },
      gatewayId: "default",
    });
  });

  it.each([
    { name: "missing", stdout: "", stderr: "Error: release: not found", code: 1 },
    { name: "uninstalled", stdout: JSON.stringify({ info: { status: "uninstalled" } }), stderr: "", code: 0 },
  ])("does not read retained values for a $name gateway release", async (status) => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = async (args) => {
      calls.push(args);
      return args[0] === "status" ? status : {
        stdout: JSON.stringify({ gatewayId: "default", imageTag: "abc1234", image: { repository: REPO } }),
        stderr: "", code: 0,
      };
    };
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.readDeployedInstance({ namespace: "octogee-test", gatewayId: "default" })).resolves.toBeNull();
    expect(calls).toEqual([["status", "octogee-gw-default", "-n", "octogee-test", "-o", "json"]]);
  });

  it.each([
    { name: "invalid JSON", stdout: "not-json", stderr: "", code: 0, error: /could not parse JSON/ },
    { name: "missing status", stdout: "{}", stderr: "", code: 0, error: /info.status missing/ },
    { name: "permission denied", stdout: "", stderr: "Error: forbidden", code: 1, error: /forbidden/ },
  ])("rejects $name without treating the gateway release as absent", async ({ error, ...status }) => {
    const { runHelm, calls } = mockSubprocess([status]);
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.readDeployedInstance({ namespace: "octogee-test", gatewayId: "default" })).rejects.toThrow(error);
    expect(calls).toEqual([["status", "octogee-gw-default", "-n", "octogee-test", "-o", "json"]]);
  });

  it("filters helm list to octogee-gw-* releases and pulls each release's values", async () => {
    const { runHelm, calls } = mockSubprocess([
      
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-default", namespace: "octogee-test", status: "deployed" },
          { name: "octogee-gw-canary",  namespace: "octogee-test", status: "deployed" },
        ]),
      },
      
      {
        stdout: JSON.stringify({
          gatewayId: "default",
          imageTag: "abc1234",
          image: { repository: REPO },
        }),
      },

      {
        stdout: JSON.stringify({
          gatewayId: "canary",
          imageTag: "def5678",
          image: { repository: REPO },
          computeClassOverride: "octogee-gateway-spot",
        }),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });

    expect(calls[0]).toEqual([
      "list",
      "-n",
      "octogee-test",
      "--filter",
      "^octogee-gw-",
      "-o",
      "json",
    ]);
    expect(calls[1].slice(0, 4)).toEqual(["get", "values", "octogee-gw-default", "-n"]);
    expect(map.default).toEqual({
      enabled: true,
      image: { repository: REPO, tag: "abc1234" },
      gatewayId: "default",
    });
    expect(map.canary).toEqual({
      enabled: true,
      image: { repository: REPO, tag: "def5678" },
      gatewayId: "canary",
    });
  });

  it("round-trips chartFingerprint from `helm get values` into the deployed map", async () => {
    const fp = "a".repeat(64);
    const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-default", namespace: "octogee-test", status: "deployed" },
        ]),
      },
      {
        stdout: JSON.stringify({
          gatewayId: "default",
          imageTag: "abc1234",
          image: { repository: REPO },
          chartFingerprint: fp,
        }),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });
    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });
    expect(map.default.chartFingerprint).toBe(fp);
  });

  it("round-trips personal gateway helm knobs from `helm get values`", async () => {
    const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-walter", namespace: "octogee", status: "deployed" },
        ]),
      },
      {
        stdout: JSON.stringify({
          gatewayId: "walter",
          ownerUid: "uid-ceckert",
          builderSlug: "ceckert",
          imageTag: "abc1234",
          image: { repository: REPO },
          serviceAccountName: "octogee-gateway-walter",
          gatewayContainerSecurityContext: {
            allowPrivilegeEscalation: true,
            capabilities: { drop: ["ALL"] },
          },
        }),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });
    const map = await runner.readDeployedInstances({ namespace: "octogee" });
    expect(map.walter).not.toHaveProperty("ownerUid");
    expect(map.walter).not.toHaveProperty("builderSlug");
    expect(map.walter).toMatchObject({
      serviceAccountName: "octogee-gateway-walter",
      gatewayContainerSecurityContext: {
        allowPrivilegeEscalation: true,
      },
    });
  });

  it("leaves chartFingerprint undefined when the helm release predates the field (transition case)", async () => {
    const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-default", namespace: "octogee-test", status: "deployed" },
        ]),
      },
      {
        stdout: JSON.stringify({
          gatewayId: "default",
          imageTag: "abc1234",
          image: { repository: REPO },
        }),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });
    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });
    expect(map.default.chartFingerprint).toBeUndefined();
  });

  it("returns an empty map when no octogee-gw-* releases exist (fresh cluster)", async () => {
    const { runHelm } = mockSubprocess([{ stdout: "[]" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });
    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });
    expect(map).toEqual({});
  });

  it("skips releases whose values are missing gatewayId/imageTag/image.repository (incomplete adoption)", async () => {
    const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-broken", namespace: "octogee-test", status: "deployed" },
        ]),
      },
      
      { stdout: JSON.stringify({}) },
    ]);
    const log = vi.fn();
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log });
    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });
    expect(map).toEqual({});
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("missing gatewayId/imageTag/imageRepository"),
    );
  });

  it("accepts numeric imageTag values (helm --set parses unquoted numerics as YAML numbers)", async () => {

const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-smoke", namespace: "octogee-test", status: "deployed" },
        ]),
      },
      
      {
        stdout: JSON.stringify({
          gatewayId: "smoke",
          imageTag: 9778420,
          image: { repository: REPO },
        }),
      },
    ]);
    const log = vi.fn();
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log });
    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });
    expect(map.smoke).toEqual({
      enabled: true,
      image: { repository: REPO, tag: "9778420" },
      gatewayId: "smoke",
    });
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining("missing"),
    );
  });

  it("coerces numeric gatewayId to string too (consistent narrowing)", async () => {
    const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-numeric", namespace: "octogee-test", status: "deployed" },
        ]),
      },
      {
        stdout: JSON.stringify({
          gatewayId: 12345,
          imageTag: "abc1234",
          image: { repository: REPO },
        }),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });
    const map = await runner.readDeployedInstances({ namespace: "octogee-test" });
    expect(map.numeric).toEqual({
      enabled: true,
      image: { repository: REPO, tag: "abc1234" },
      gatewayId: "12345",
    });
  });

  it("throws when helm list fails for a non-not-found reason", async () => {
    const { runHelm } = mockSubprocess([
      { code: 1, stderr: "Error: connection refused" },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });
    await expect(
      runner.readDeployedInstances({ namespace: "octogee-test" }),
    ).rejects.toThrow(/connection refused/);
  });
});

describe("createHelmSubprocessRunner — upsertInstance", () => {
  it("runs `helm upgrade --install octogee-gw-<name> <chart> -n <ns> --set ... --wait`", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
    });

    expect(calls).toHaveLength(1);
    const args = calls[0];
    expect(args[0]).toBe("upgrade");
    expect(args).toContain("--install");
    expect(args).toContain("octogee-gw-default");
    expect(args).toContain("/charts/octogee-gateway");
    expect(args).toContain("-n");
    expect(args).toContain("octogee-test");
    // String-typed fields use --set-string so digit-only values (e.g.
    // imageTag="3280519") don't get coerced to a number and rejected
    // by the chart schema. Numeric fields (replicas) still use --set.
    expect(args).toContain("--set-string");
    expect(args).toContain("gatewayId=default");
    expect(args).toContain("imageTag=abc1234");
    expect(args).toContain(`image.repository=${REPO}`);
    expect(args).toContain("--wait");
    expect(args.some((a) => a.startsWith("--timeout="))).toBe(true);
  });

  it("uses server-side apply with --force-conflicts so kubectl-set / other field-manager ownership doesn't poison helm upgrades (matches umbrella path bumped in #913 / pinned in #1056)", async () => {
    // A `kubectl-set`-owned env entry with `value:` for OPENCLAW_GATEWAY_TOKEN
    // strategic-merges with helm's `valueFrom:` on the same name into a
    // single entry with BOTH fields, which K8s schema validation rejects. Server-side apply with --force-conflicts lets helm
    // unconditionally reclaim ownership of fields it manages, preventing
    // any future kubectl-set / kubectl-patch / kubectl-rollout side-channel
    // from poisoning the next upgrade.
    //
    // Syntax matters: helm 4 treats --server-side as a STRING flag taking
    // "true"/"false"/"auto", not boolean. `--server-side --force-conflicts`
    // (no `=true`) parses as `--server-side="--force-conflicts"` — invalid
    // value silently defaulting to "auto", and the literal `--force-conflicts`
    // flag is never applied (commit 10f30573 post-mortem on the umbrella path).
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({
      runHelm: withPreflightStatusNotFound(runHelm),
      log: vi.fn(),
    });

    await runner.upsertInstance({
      namespace: "octogee-test",
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
    });

    const upgrade = calls.find((c) => c[0] === "upgrade") ?? [];
    expect(upgrade).toContain("--server-side=true");
    expect(upgrade).toContain("--force-conflicts");
    // Defensive: catch a regression where someone "simplifies" to the
    // boolean-style `--server-side` (which v4 silently misparses).
    expect(upgrade).not.toContain("--server-side");
  });

  it("always passes --take-ownership (the fleet controller owns every gateway resource; adopt leftovers, never wedge)", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
    });

    expect(calls[0]).toContain("--take-ownership");
  });

  it("threads -f <valuesFile> when provided so per-namespace defaults follow", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
      valuesFile: "/charts/octogee-gateway/values.test.yaml",
    });

    const args = calls[0];
    const fIdx = args.indexOf("-f");
    expect(fIdx).toBeGreaterThan(-1);
    expect(args[fIdx + 1]).toBe("/charts/octogee-gateway/values.test.yaml");
  });

  it("passes --set chartFingerprint=<hex> when chartFingerprint is provided", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
      chartFingerprint: "f".repeat(64),
    });

    expect(calls[0]).toContain(`chartFingerprint=${"f".repeat(64)}`);
  });

  it("passes personal gateway knobs as helm values", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee",
      gatewayId: "walter",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
      serviceAccountName: "octogee-gateway-walter",
      gatewayContainerSecurityContext: {
        allowPrivilegeEscalation: true,
        capabilities: { drop: ["ALL"] },
      },
    });

    const args = calls[0];
    expect(args).toContain("serviceAccountName=octogee-gateway-walter");
    expect(args).toContain("--set-json");
    expect(args).toContain(
      'gatewayContainerSecurityContext={"allowPrivilegeEscalation":true,"capabilities":{"drop":["ALL"]}}',
    );
  });

  it("passes --set profile=<profile> when the user profile is provided", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee",
      gatewayId: "walter",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
      profile: "isolated",
    });

    expect(calls[0]).toContain("profile=isolated");
  });

  // eslint-disable-next-line sonarjs/parameterized-tests -- The adjacent profile, string-typing, and sizing cases assert different Helm flag invariants with incompatible setup and assertions.
  it("omits --set profile when profile is undefined (cattle/standard default = chart's profile=\"\")", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
    });

    expect(calls[0].some((a) => a.startsWith("profile="))).toBe(false);
  });

  it("passes string-typed fields via --set-string so a digit-only imageTag isn't coerced to a number", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee",
      gatewayId: "walter",
      builderIdentity: { ownerUid: "uid-ceckert", builderSlug: "ceckert" },
      imageRepository: REPO,
      imageTag: "3280519", // digits only — would be coerced to number by plain --set
      chartPath: "/charts/octogee-gateway",
      profile: "isolated",
      sizingTier: "l",
      replicas: 1,
    });

    const args = calls[0];
    // Locate each string-typed --set-string pair and confirm value follows.
    const stringPair = (key: string): string | undefined => {
      const idx = args.findIndex((a, i) => a === "--set-string" && args[i + 1]?.startsWith(`${key}=`));
      return idx === -1 ? undefined : args[idx + 1];
    };
    expect(stringPair("imageTag")).toBe("imageTag=3280519");
    expect(stringPair("gatewayId")).toBe("gatewayId=walter");
    expect(args.join(" ")).not.toMatch(/ceckert/);
    expect(stringPair("profile")).toBe("profile=isolated");
    expect(stringPair("sizingTier")).toBe("sizingTier=l");
    // replicas stays on --set because it's number-typed.
    const replicasIdx = args.findIndex((a, i) => a === "--set" && args[i + 1] === "replicas=1");
    expect(replicasIdx).toBeGreaterThanOrEqual(0);
    // And string-typed fields MUST NOT appear under plain --set.
    expect(args.some((a, i) => a === "--set" && args[i + 1]?.startsWith("imageTag="))).toBe(false);
  });

  it("passes --set sizingTier=<tier> when provided", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee",
      gatewayId: "walter",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
      sizingTier: "m",
    });

    expect(calls[0]).toContain("sizingTier=m");
  });

  it("never emits a compute-class override to the chart", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee",
      gatewayId: "walter-green",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
    });

    expect(calls[0].some((a: string) => a.includes("computeClass"))).toBe(false);
  });

  it("omits --set sizingTier when undefined (chart falls back to profile default)", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
    });

    expect(calls[0].some((a) => a.startsWith("sizingTier="))).toBe(false);
  });

  it("omits chartFingerprint --set when not provided (operator-driven helm calls)", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.upsertInstance({
      namespace: "octogee-test",
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
    });

    expect(calls[0].some((a) => a.startsWith("chartFingerprint="))).toBe(false);
  });

  it("propagates helm failures with stderr in the error message", async () => {
    const { runHelm } = mockSubprocess([
      { code: 1, stderr: "Error: timed out" },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.upsertInstance({
        namespace: "octogee-test",
        gatewayId: "default",
        imageRepository: REPO,
        imageTag: "abc1234",
        chartPath: "/charts/octogee-gateway",
      }),
    ).rejects.toThrow(/timed out/);
  });

  it("calls ensureAuthSecret({namespace, gatewayId}) BEFORE helm upgrade (auth secret must exist when the chart's secretKeyRef resolves)", async () => {
    // Capture invocation order in a shared events[] array so a regression that
    // reorders ensureAuthSecret to AFTER upgrade actually fails the test
    // (Copilot C2 on PR #1160 — the prior version only asserted both happened).
    const events: string[] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      events.push(args[0]); // "status" then "upgrade"
      return { stdout: "ok", stderr: "", code: 0 };
    });
    const ensureAuthSecret = vi.fn(async () => {
      events.push("ensure");
    });
    const runner = createHelmSubprocessRunner({
      runHelm: withPreflightStatusNotFound(runHelm),
      log: vi.fn(),
      ensureAuthSecret,
    });

    await runner.upsertInstance({
      namespace: "octogee",
      gatewayId: "walter",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
    });

    expect(ensureAuthSecret).toHaveBeenCalledWith({
      namespace: "octogee",
      gatewayId: "walter",
    });
    const ensureIdx = events.indexOf("ensure");
    const upgradeIdx = events.indexOf("upgrade");
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(upgradeIdx).toBeGreaterThanOrEqual(0);
    expect(ensureIdx).toBeLessThan(upgradeIdx);
  });

  it("propagates ensureAuthSecret failures and does NOT call helm upgrade (fail-loud: don't apply a chart that can't resolve its token secret)", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const ensureAuthSecret = vi
      .fn()
      .mockRejectedValue(new Error("kubectl create secret failed: permission denied"));
    const runner = createHelmSubprocessRunner({
      runHelm: withPreflightStatusNotFound(runHelm),
      log: vi.fn(),
      ensureAuthSecret,
    });

    await expect(
      runner.upsertInstance({
        namespace: "octogee",
        gatewayId: "walter",
        imageRepository: REPO,
        imageTag: "abc1234",
        chartPath: "/charts/octogee-gateway",
      }),
    ).rejects.toThrow(/permission denied/);
    expect(calls.find((c) => c[0] === "upgrade")).toBeUndefined();
  });

  it("does NOT pass --set gatewayEdge.env.GCP_PROJECT_ID by default (chart values.yaml + values.{prod,test}.yaml are SSOT — no kubectl-set field-manager collision)", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({
      runHelm: withPreflightStatusNotFound(runHelm),
      log: vi.fn(),
    });

    await runner.upsertInstance({
      namespace: "octogee-test",
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
    });

    const upgrade = calls.find((c) => c[0] === "upgrade") ?? [];
    expect(upgrade.some((a) => a.startsWith("gatewayEdge.env.GCP_PROJECT_ID="))).toBe(
      false,
    );
  });

  it("DOES pass --set gatewayEdge.env.GCP_PROJECT_ID=<value> when gcpProject is explicitly set (BYO-GCP escape hatch)", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({
      runHelm: withPreflightStatusNotFound(runHelm),
      log: vi.fn(),
    });

    await runner.upsertInstance({
      namespace: "octogee",
      gatewayId: "acme",
      imageRepository: REPO,
      imageTag: "abc1234",
      chartPath: "/charts/octogee-gateway",
      gcpProject: "user-acme-prod",
    });

    const upgrade = calls.find((c) => c[0] === "upgrade") ?? [];
    expect(upgrade).toContain("gatewayEdge.env.GCP_PROJECT_ID=user-acme-prod");
  });
});

describe("createHelmSubprocessRunner — upsertInstance self-heal for a stuck pending release", () => {
  const upsertArgs = {
    namespace: "octogee-test",
    gatewayId: "default",
    imageRepository: REPO,
    imageTag: "newtag",
    chartPath: "/charts/octogee-gateway",
  } as const;

  const IN_PROGRESS =
    "Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress";

  it("rolls back to the last deployed revision then retries the upgrade", async () => {
    let upgrades = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      switch (args[0]) {
        case "upgrade":
          upgrades++;
          return upgrades === 1
            ? { stdout: "", stderr: IN_PROGRESS, code: 1 }
            : { stdout: "ok", stderr: "", code: 0 };
        case "history":
          return {
            stdout: JSON.stringify([
              { revision: 2, status: "superseded" },
              { revision: 3, status: "deployed" },
              { revision: 4, status: "pending-upgrade" },
            ]),
            stderr: "",
            code: 0,
          };
        case "rollback":
          return { stdout: "Rollback was a success", stderr: "", code: 0 };
        default:
          throw new Error(`unexpected helm ${args[0]}`);
      }
    });
    const log = vi.fn();
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "upgrade",
      "history",
      "rollback",
      "upgrade",
    ]);
    const rollback = calls.find((c) => c[0] === "rollback");
    expect(rollback).toBeDefined();

    expect(rollback).toContain("octogee-gw-default");
    expect(rollback).toContain("3");
    expect(rollback).toContain("-n");
    expect(rollback).toContain("octogee-test");
    // The recovery rollback mirrors the upgrade's server-side-apply flags so it
    // can reclaim fields a kubectl side-channel grabbed instead of dying on the
    // conflict (matches buildUpgradeArgs).
    expect(rollback).toContain("--server-side=true");
    expect(rollback).toContain("--force-conflicts");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("stuck"));
  });

  it("targets the last `superseded` revision when no `deployed` revision remains", async () => {
    let upgrades = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") {
        upgrades++;
        return upgrades === 1
          ? { stdout: "", stderr: IN_PROGRESS, code: 1 }
          : { stdout: "ok", stderr: "", code: 0 };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([
            { revision: 1, status: "superseded" },
            { revision: 2, status: "pending-upgrade" },
          ]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

    const rollback = calls.find((c) => c[0] === "rollback");
    expect(rollback).toContain("1");
  });

  it("uninstalls a stuck first-install (pending-install, no good revision) then retries", async () => {
    let upgrades = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") {
        upgrades++;
        return upgrades === 1
          ? { stdout: "", stderr: IN_PROGRESS, code: 1 }
          : { stdout: "ok", stderr: "", code: 0 };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ revision: 1, status: "pending-install" }]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "uninstall") return { stdout: "uninstalled", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "upgrade",
      "history",
      "uninstall",
      "upgrade",
    ]);
    expect(calls.find((c) => c[0] === "uninstall")).toContain("octogee-gw-default");
  });

  it("does NOT attempt recovery for a non-pending helm failure (real errors still surface)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      return {
        stdout: "",
        stderr: "Error: UPGRADE FAILED: timed out waiting for the condition",
        code: 1,
      };
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /timed out/,
    );
    
    expect(calls.map((c) => c[0])).toEqual(["upgrade"]);
  });

  it("surfaces a clear error when the recovery rollback itself fails (no infinite silent loop)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") return { stdout: "", stderr: IN_PROGRESS, code: 1 };
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ revision: 2, status: "deployed" }]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") {
        return { stdout: "", stderr: "Error: rollback failed: tiller lock", code: 1 };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /rollback/i,
    );
    
    expect(calls.map((c) => c[0])).toEqual(["upgrade", "history", "rollback"]);
  });

  it("retries the upgrade only once after recovery — a second failure throws", async () => {
    let upgrades = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") {
        upgrades++;
        return upgrades === 1
          ? { stdout: "", stderr: IN_PROGRESS, code: 1 }
          : { stdout: "", stderr: "Error: UPGRADE FAILED: timed out", code: 1 };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ revision: 2, status: "deployed" }]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /timed out/,
    );
    expect(upgrades).toBe(2);
  });

  it("re-wedge: recovers a release stuck in pending-rollback (the fleet controller killed during a prior recovery)", async () => {
    let upgrades = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") {
        upgrades++;
        return upgrades === 1
          ? { stdout: "", stderr: IN_PROGRESS, code: 1 }
          : { stdout: "ok", stderr: "", code: 0 };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([
            { revision: 2, status: "deployed" },
            { revision: 3, status: "pending-rollback" },
          ]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

expect(calls.find((c) => c[0] === "rollback")).toContain("2");
  });

  it("rolls back to an old good revision even when many later revisions failed (never destructively uninstalls; no --max cap)", async () => {
    let upgrades = 0;
    const calls: string[][] = [];
    const history = [
      { revision: 1, status: "superseded" },
      { revision: 2, status: "deployed" },
      ...Array.from({ length: 25 }, (_, i) => ({
        revision: 3 + i,
        status: i % 2 === 0 ? "pending-upgrade" : "failed",
      })),
    ];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") {
        upgrades++;
        return upgrades === 1
          ? { stdout: "", stderr: IN_PROGRESS, code: 1 }
          : { stdout: "ok", stderr: "", code: 0 };
      }
      if (args[0] === "history") {
        return { stdout: JSON.stringify(history), stderr: "", code: 0 };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "upgrade",
      "history",
      "rollback",
      "upgrade",
    ]);
    expect(calls.find((c) => c[0] === "rollback")).toContain("2");
    expect(calls.some((c) => c[0] === "uninstall")).toBe(false);
    expect(calls.find((c) => c[0] === "history")).not.toContain("--max");
  });

  it("surfaces a clear error when helm history returns unparseable output (no raw SyntaxError loop)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") return { stdout: "", stderr: IN_PROGRESS, code: 1 };
      if (args[0] === "history") {
        return {
          stdout: "WARNING: couldn't read kubeconfig\nnot-json-at-all",
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /unparseable output during recovery/,
    );
    
    expect(calls.map((c) => c[0])).toEqual(["upgrade", "history"]);
  });

  it("fails closed on empty helm history (existing stuck release must have revisions) — no destructive uninstall", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") return { stdout: "", stderr: IN_PROGRESS, code: 1 };
      if (args[0] === "history") return { stdout: "[]", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /no usable revision history during recovery/,
    );
    expect(calls.map((c) => c[0])).toEqual(["upgrade", "history"]);
  });

  it("fails closed when helm history is valid JSON but not an array", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") return { stdout: "", stderr: IN_PROGRESS, code: 1 };
      if (args[0] === "history") {
        return { stdout: JSON.stringify({ error: "boom" }), stderr: "", code: 0 };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /no usable revision history during recovery/,
    );
    expect(calls.map((c) => c[0])).toEqual(["upgrade", "history"]);
  });

  it("fails closed when helm history is an array but no item has the {revision,status} shape", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "upgrade") return { stdout: "", stderr: IN_PROGRESS, code: 1 };
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ foo: 1 }, { revision: "not-a-number" }]),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /no usable revision history during recovery/,
    );
    expect(calls.map((c) => c[0])).toEqual(["upgrade", "history"]);
  });

it("pre-flight detects pending-upgrade and rolls back BEFORE attempting upgrade", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({ info: { status: "pending-upgrade" } }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([
            { revision: 3, status: "deployed" },
            { revision: 4, status: "pending-upgrade" },
          ]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      if (args[0] === "upgrade") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const log = vi.fn();
    const runner = createHelmSubprocessRunner({ runHelm, log });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

expect(calls.map((c) => c[0])).toEqual([
      "status",
      "history",
      "rollback",
      "upgrade",
    ]);
    
    const rollback = calls.find((c) => c[0] === "rollback")!;
    expect(rollback).toContain("3");
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/pre-flight.*pending-upgrade/),
    );
  });

  it("pre-flight detects pending-rollback (the fleet controller killed mid-recovery) — same shape, recovers + upgrades", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({ info: { status: "pending-rollback" } }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ revision: 2, status: "deployed" }]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      if (args[0] === "upgrade") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "status",
      "history",
      "rollback",
      "upgrade",
    ]);
  });

  it("pre-flight detects pending-install (failed first-install) — uninstalls then upgrades", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({ info: { status: "pending-install" } }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "history") {
        return {

stdout: JSON.stringify([{ revision: 1, status: "pending-install" }]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "uninstall") return { stdout: "ok", stderr: "", code: 0 };
      if (args[0] === "upgrade") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "status",
      "history",
      "uninstall",
      "upgrade",
    ]);
  });

  it("pre-flight on a healthy 'deployed' release skips recovery (no extra helm calls)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({ info: { status: "deployed" } }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "upgrade") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();

expect(calls.map((c) => c[0])).toEqual(["status", "upgrade"]);
  });

  it("pre-flight on a 'failed' (non-pending) release skips recovery (helm upgrade can override a failed state)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({ info: { status: "failed" } }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "upgrade") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();
    expect(calls.map((c) => c[0])).toEqual(["status", "upgrade"]);
  });

  it("pre-flight on a non-existent release (fresh install) proceeds directly to upgrade", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: "",
          stderr: "Error: release: not found",
          code: 1,
        };
      }
      if (args[0] === "upgrade") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).resolves.toBeUndefined();
    
    expect(calls.map((c) => c[0])).toEqual(["status", "upgrade"]);
  });

  it("pre-flight surfaces a non-not-found helm status error (no silent swallow)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          stdout: "",
          stderr: "Error: Kubernetes cluster unreachable: context deadline exceeded",
          code: 1,
        };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });

    await expect(runner.upsertInstance({ ...upsertArgs })).rejects.toThrow(
      /helm status.*Kubernetes cluster unreachable/,
    );

expect(calls.map((c) => c[0])).toEqual(["status"]);
  });
});

describe("createHelmSubprocessRunner — gateway ServiceAccount ownership", () => {
  it("leaves a static platform ServiceAccount solely Helm-owned", async () => {
    const ensureServiceAccount = vi.fn(async () => undefined);
    const { runHelm } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({
      runHelm: withPreflightStatusNotFound(runHelm),
      ensureServiceAccount,
      log: vi.fn(),
    });

    await runner.upsertInstance({
      namespace: "octogee-test",
      gatewayId: "builder-a",
      imageRepository: REPO,
      imageTag: "newtag",
      chartPath: "/charts/octogee-gateway",
      serviceAccountName: "octogee-api",
    });

    expect(ensureServiceAccount).not.toHaveBeenCalled();
  });

  it("leaves a prefixed but non-generated ServiceAccount outside fleet controller ownership", async () => {
    const ensureServiceAccount = vi.fn(async () => undefined);
    const { runHelm } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({
      runHelm: withPreflightStatusNotFound(runHelm),
      ensureServiceAccount,
      log: vi.fn(),
    });

    await runner.upsertInstance({
      namespace: "octogee-test",
      gatewayId: "builder-a",
      imageRepository: REPO,
      imageTag: "newtag",
      chartPath: "/charts/octogee-gateway",
      serviceAccountName: "octogee-gw-other-gateway",
    });

    expect(ensureServiceAccount).not.toHaveBeenCalled();
  });

  it("falls back to the exact active deployment target for the namespace", async () => {
    const ensureServiceAccount = vi.fn(async () => undefined);
    const { runHelm } = mockSubprocess([{ stdout: "ok" }]);
    const runner = createHelmSubprocessRunner({
      runHelm: withPreflightStatusNotFound(runHelm),
      ensureServiceAccount,
      log: vi.fn(),
    });

    await runner.upsertInstance({
      namespace: "octogee-test",
      gatewayId: "builder-a",
      imageRepository: REPO,
      imageTag: "newtag",
      chartPath: "/charts/octogee-gateway",
    });

    expect(ensureServiceAccount).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ deploymentTargetId: "test-central" }),
    }));
  });

  it("re-ensures the KSA after a failed Helm apply that pruned it", async () => {
    const order: string[] = [];
    const ensureServiceAccount = vi.fn(async () => {
      order.push("ensure-ksa");
    });
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      if (args[0] === "status") {
        return { stdout: "", stderr: "Error: release: not found", code: 1 };
      }
      if (args[0] === "upgrade") {
        order.push("helm-upgrade");
        return { stdout: "", stderr: "Deployment not ready", code: 1 };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({
      runHelm,
      ensureServiceAccount,
      log: vi.fn(),
    });

    await expect(
      runner.upsertInstance({
        namespace: "octogee-test",
        gatewayId: "default-green",
        imageRepository: REPO,
        imageTag: "newtag",
        chartPath: "/charts/octogee-gateway",
        deploymentTargetId: "test-central",
      }),
    ).rejects.toThrow(/Deployment not ready/);

    expect(order).toEqual(["ensure-ksa", "helm-upgrade", "ensure-ksa"]);
    expect(ensureServiceAccount).toHaveBeenLastCalledWith({
      namespace: "octogee-test",
      serviceAccountName: "octogee-gw-default-green",
      identity: {
        gatewayId: "default-green",
        deploymentTargetId: "test-central",
        lifecycleIdentity: "gateway-default-green",
        releaseName: "octogee-gw-default-green",
      },
      annotations: undefined,
    });
  });
});

describe("createHelmSubprocessRunner — removeInstance", () => {
  it("runs `helm uninstall octogee-gw-<name> -n <ns> --wait --cascade=foreground` so it returns only after the pods (and their preStop) are gone", async () => {
    const { runHelm, calls } = mockSubprocess([{ stdout: "release \"octogee-gw-default\" uninstalled" }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await runner.removeInstance({
      namespace: "octogee-test",
      gatewayId: "default",
    });

    const args = calls[0];
    expect(args[0]).toBe("uninstall");
    expect(args).toContain("octogee-gw-default");
    expect(args).toContain("-n");
    expect(args).toContain("octogee-test");
    expect(args).toContain("--wait");
    expect(args).toContain("--cascade=foreground");
  });

  it("treats 'release not found' as a successful no-op (idempotent retire)", async () => {
    const { runHelm } = mockSubprocess([
      { code: 1, stderr: "Error: uninstall: Release not loaded: release: not found" },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee-test", gatewayId: "ghost" }),
    ).resolves.toBeUndefined();
  });

  it("throws on other non-zero exits (operator notices real failures)", async () => {
    const { runHelm } = mockSubprocess([
      { code: 1, stderr: "Error: pre-delete hook failed" },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee-test", gatewayId: "broken" }),
    ).rejects.toThrow(/pre-delete hook failed/);
  });

  const TERMINATING_ONLY =
    "Error: uninstallation completed with 2 error(s): resource Deployment/octogee/octogee-gateway-shared-28b140d9fb3c still exists. status: Terminating, message: Resource scheduled for deletion\n" +
    "resource Pod/octogee/octogee-gateway-shared-28b140d9fb3c-7d9f-x2x still exists. status: Terminating, message: Resource scheduled for deletion";

  function drainingWorkload(podPolls: number) {
    let clock = 0;
    const kubectlCalls: string[][] = [];
    let podReads = 0;
    const runKubectl = vi.fn(async (args: string[]) => {
      kubectlCalls.push(args);
      if (args.includes("pods")) {
        podReads++;
        return { code: 0, stderr: "", stdout: podReads <= podPolls ? "pod/octogee-gateway-shared-28b140d9fb3c-7d9f-x2x\n" : "" };
      }
      return { code: 0, stderr: "No resources found in octogee namespace.", stdout: "" };
    });
    return {
      runKubectl,
      kubectlCalls,
      now: () => clock,
      wait: vi.fn(async (ms: number) => { clock += ms; }),
    };
  }

  it("completes a terminating-only uninstall only once the gateway's pods and Deployment are gone", async () => {
    const log = vi.fn();
    const { runHelm } = mockSubprocess([{ code: 1, stderr: TERMINATING_ONLY }]);
    const workload = drainingWorkload(2);
    const runner = createHelmSubprocessRunner({
      runHelm: withPreflightStatusNotFound(runHelm), log, ...workload,
      workloadDrainTimeoutMs: 60_000, workloadDrainPollMs: 5_000,
    });

    await expect(
      runner.removeInstance({ namespace: "octogee", gatewayId: "shared-28b140d9fb3c" }),
    ).resolves.toBeUndefined();
    expect(workload.wait).toHaveBeenCalledTimes(2);
    expect(workload.kubectlCalls).toContainEqual(
      ["-n", "octogee", "get", "pods", "-l", "app=octogee-gateway,gateway-id=shared-28b140d9fb3c", "-o", "name"],
    );
    expect(workload.kubectlCalls).toContainEqual(
      ["-n", "octogee", "get", "deployments", "-l", "app.kubernetes.io/instance=octogee-gw-shared-28b140d9fb3c", "-o", "name"],
    );
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/octogee-gw-shared-28b140d9fb3c.*workload gone/));
  });

  it("fails a terminating-only uninstall whose pods outlive the drain bound, retryably", async () => {
    const { runHelm } = mockSubprocess([{ code: 1, stderr: TERMINATING_ONLY }]);
    const workload = drainingWorkload(Number.POSITIVE_INFINITY);
    const runner = createHelmSubprocessRunner({
      runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn(), ...workload,
      workloadDrainTimeoutMs: 60_000, workloadDrainPollMs: 5_000,
    });

    const failure = await runner
      .removeInstance({ namespace: "octogee", gatewayId: "shared-28b140d9fb3c" })
      .then(() => null, (error: Error) => error);

    expect(failure?.message).toMatch(/gateway workload still terminating.*pod\/octogee-gateway-shared-28b140d9fb3c-7d9f-x2x.*60000ms/);
    expect(isRetryableUninstallFailure(`helm uninstall failed: ${failure?.message}`)).toBe(true);
  });

  it("fails a terminating-only uninstall closed when it cannot observe the workload", async () => {
    const { runHelm } = mockSubprocess([{ code: 1, stderr: TERMINATING_ONLY }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee", gatewayId: "shared-28b140d9fb3c" }),
    ).rejects.toThrow(/helm uninstall octogee-gw-shared-28b140d9fb3c failed \(code=1\): Error: uninstallation completed/);
  });

  it("waits out pods a prior uninstall left terminating before treating an absent release as removed", async () => {
    const { runHelm } = mockSubprocess([
      { code: 1, stderr: "Error: uninstall: Release not loaded: release: not found" },
    ]);
    const workload = drainingWorkload(1);
    const runner = createHelmSubprocessRunner({
      runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn(), ...workload,
      workloadDrainTimeoutMs: 60_000, workloadDrainPollMs: 5_000,
    });

    await expect(
      runner.removeInstance({ namespace: "octogee", gatewayId: "shared-28b140d9fb3c" }),
    ).resolves.toBeUndefined();
    expect(workload.wait).toHaveBeenCalledTimes(1);
  });

  it("recognizes the legacy terminating-only helm failure as retryable, and nothing else", () => {
    expect(isRetryableUninstallFailure(`helm uninstall failed: helm uninstall octogee-gw-x failed (code=1): ${TERMINATING_ONLY}`)).toBe(true);
    expect(isRetryableUninstallFailure("helm uninstall failed: Error: pre-delete hook failed")).toBe(false);
  });

  const PURGED_RECORD_MISSING =
    "Error: uninstallation completed with 1 error(s): uninstall: Failed to purge the release: " +
    "secrets \"sh.helm.release.v1.octogee-gw-shared-7d83139c3814.v1\" not found";

  it("treats a purge whose release record is already gone as uninstalled, once the workload is gone", async () => {
    const log = vi.fn();
    const { runHelm } = mockSubprocess([{ code: 1, stderr: PURGED_RECORD_MISSING }]);
    const workload = drainingWorkload(1);
    const runner = createHelmSubprocessRunner({
      runHelm: withPreflightStatusNotFound(runHelm), log, ...workload,
      workloadDrainTimeoutMs: 60_000, workloadDrainPollMs: 5_000,
    });

    await expect(
      runner.removeInstance({ namespace: "octogee", gatewayId: "shared-7d83139c3814" }),
    ).resolves.toBeUndefined();
    expect(workload.wait).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/octogee-gw-shared-7d83139c3814.*already gone/));
  });

  it("fails a purge-record-missing uninstall retryably while the workload outlives the drain bound", async () => {
    const { runHelm } = mockSubprocess([{ code: 1, stderr: PURGED_RECORD_MISSING }]);
    const workload = drainingWorkload(Number.POSITIVE_INFINITY);
    const runner = createHelmSubprocessRunner({
      runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn(), ...workload,
      workloadDrainTimeoutMs: 60_000, workloadDrainPollMs: 5_000,
    });

    await expect(
      runner.removeInstance({ namespace: "octogee", gatewayId: "shared-7d83139c3814" }),
    ).rejects.toThrow(/gateway workload still terminating/);
  });

  it("recognizes the PROD purge-record-missing retire failure as retryable", () => {
    expect(isRetryableUninstallFailure(
      `helm uninstall failed: helm uninstall octogee-gw-shared-7d83139c3814 failed (code=1): ${PURGED_RECORD_MISSING}`,
    )).toBe(true);
  });

  it.each([
    [
      "a purge failure for a missing record alongside a real error",
      "Error: uninstallation completed with 2 error(s): uninstall: Failed to purge the release: secrets \"sh.helm.release.v1.octogee-gw-x.v1\" not found; failed to delete Secret/octogee/x: forbidden",
    ],
    [
      "a purge failure for another release's record",
      "Error: uninstallation completed with 1 error(s): uninstall: Failed to purge the release: secrets \"sh.helm.release.v1.octogee-gw-other.v1\" not found",
    ],
    [
      "a purge failure other than a missing record",
      "Error: uninstallation completed with 1 error(s): uninstall: Failed to purge the release: secrets \"sh.helm.release.v1.octogee-gw-x.v1\" is forbidden",
    ],
  ])("still throws for %s", async (_label, stderr) => {
    const { runHelm } = mockSubprocess([{ code: 1, stderr }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn(), ...drainingWorkload(0) });

    await expect(
      runner.removeInstance({ namespace: "octogee", gatewayId: "x" }),
    ).rejects.toThrow(/helm uninstall octogee-gw-x failed/);
    expect(isRetryableUninstallFailure(`helm uninstall failed: ${stderr}`)).toBe(false);
  });

  it.each([
    [
      "a terminating resource alongside a real error",
      "Error: uninstallation completed with 2 error(s): resource Deployment/octogee/octogee-gateway-x still exists. status: Terminating, message: Resource scheduled for deletion; failed to delete Secret/octogee/x: forbidden",
    ],
    [
      "a resource still present but not terminating",
      "Error: uninstallation completed with 1 error(s): resource Deployment/octogee/octogee-gateway-x still exists. status: InProgress, message: Replicas: 1/1",
    ],
    [
      "a terminating resource after the wait deadline",
      "Error: uninstallation completed with 1 error(s): resource Deployment/octogee/octogee-gateway-x still exists. status: Terminating, message: Resource scheduled for deletion\ncontext deadline exceeded",
    ],
  ])("still throws for %s", async (_label, stderr) => {
    const { runHelm } = mockSubprocess([{ code: 1, stderr }]);
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee", gatewayId: "x" }),
    ).rejects.toThrow(/helm uninstall octogee-gw-x failed/);
  });

  it("self-heals a release stuck in pending-* before uninstalling (rolls back to last good, then uninstalls)", async () => {
    let uninstalls = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "uninstall") {
        uninstalls++;
        return uninstalls === 1
          ? {
              stdout: "",
              stderr:
                "Error: uninstall failed: another operation (install/upgrade/rollback) is in progress",
              code: 1,
            }
          : { stdout: "release \"octogee-gw-default\" uninstalled", stderr: "", code: 0 };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([
            { revision: 2, status: "deployed" },
            { revision: 3, status: "pending-upgrade" },
          ]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") return { stdout: "ok", stderr: "", code: 0 };
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee-test", gatewayId: "default" }),
    ).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "uninstall",
      "history",
      "rollback",
      "uninstall",
    ]);
    expect(calls.find((c) => c[0] === "rollback")).toContain("2");
  });

  it("self-heals a wedged first-install: recovery uninstalls it, retried uninstall is a not-found no-op", async () => {
    let uninstalls = 0;
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "uninstall") {
        uninstalls++;
        if (uninstalls === 1) {
          return {
            stdout: "",
            stderr:
              "Error: uninstall failed: another operation (install/upgrade/rollback) is in progress",
            code: 1,
          };
        }
        if (uninstalls === 2) {
          
          return { stdout: "uninstalled", stderr: "", code: 0 };
        }
        
        return { stdout: "", stderr: "Error: release: not found", code: 1 };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ revision: 1, status: "pending-install" }]),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee-test", gatewayId: "default" }),
    ).resolves.toBeUndefined();

    expect(calls.map((c) => c[0])).toEqual([
      "uninstall",
      "history",
      "uninstall",
      "uninstall",
    ]);
  });

  it("does not attempt recovery when uninstall fails 'release not found' (idempotent, no history probing)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "Error: release: not found", code: 1 };
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee-test", gatewayId: "ghost" }),
    ).resolves.toBeUndefined();
    expect(calls.map((c) => c[0])).toEqual(["uninstall"]);
  });

  it("surfaces a clear error when recovery before uninstall fails (no retry against a still-stuck release)", async () => {
    const calls: string[][] = [];
    const runHelm: HelmSubprocess = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "uninstall") {
        return {
          stdout: "",
          stderr:
            "Error: uninstall failed: another operation (install/upgrade/rollback) is in progress",
          code: 1,
        };
      }
      if (args[0] === "history") {
        return {
          stdout: JSON.stringify([{ revision: 2, status: "deployed" }]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "rollback") {
        return { stdout: "", stderr: "Error: rollback failed", code: 1 };
      }
      throw new Error(`unexpected helm ${args[0]}`);
    });
    const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn() });

    await expect(
      runner.removeInstance({ namespace: "octogee-test", gatewayId: "default" }),
    ).rejects.toThrow(/rollback/i);
    expect(calls.map((c) => c[0])).toEqual(["uninstall", "history", "rollback"]);
  });
});

describe("spawnHelm — real subprocess wrapper", () => {
  function withHelmBin<T>(bin: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.HELM_BIN;
    process.env.HELM_BIN = bin;
    return fn().finally(() => {
      if (prev === undefined) delete process.env.HELM_BIN;
      else process.env.HELM_BIN = prev;
    });
  }

  it("returns {stdout, code:0} for a successful exit", () =>
    withHelmBin("/bin/sh", async () => {
      const result = await spawnHelm(["-c", "printf hello"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("hello");
    }));

  it("rejects when the binary path does not exist (ENOENT)", () =>
    withHelmBin("/nonexistent/path/to/helm-binary", async () => {
      await expect(spawnHelm(["version"])).rejects.toThrow();
    }));

  it("preserves a non-zero exit code rather than coercing to 0", () =>
    withHelmBin("/bin/sh", async () => {
      const result = await spawnHelm(["-c", "exit 7"]);
      expect(result.code).toBe(7);
    }));

  it("encodes signal-terminated runs as code !== 0 (no silent success on SIGKILL)", () =>
    withHelmBin("/bin/sh", async () => {
      const result = await spawnHelm(["-c", "kill -TERM $$"]);
      expect(result.code).not.toBe(0);
    }));
});

describe("createHelmSubprocessRunner — listPendingReleases", () => {
  it("returns gatewayIds of releases stuck in any pending-* state, skipping deployed", async () => {
    const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-default-green", namespace: "octogee", status: "deployed" },
          { name: "octogee-gw-default-blue", namespace: "octogee", status: "pending-upgrade" },
          { name: "octogee-gw-walter", namespace: "octogee", status: "pending-install" },
        ]),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });
    const pending = await runner.listPendingReleases({ namespace: "octogee" });
    expect(pending.sort()).toEqual(["default-blue", "walter"]);
  });

  it("returns empty when every release is deployed", async () => {
    const { runHelm } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { name: "octogee-gw-default-blue", namespace: "octogee", status: "deployed" },
        ]),
      },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });
    expect(await runner.listPendingReleases({ namespace: "octogee" })).toEqual([]);
  });
});

describe("createHelmSubprocessRunner — recoverRelease", () => {
  it("rolls a stuck release back to its last good revision", async () => {
    const { runHelm, calls } = mockSubprocess([
      {
        stdout: JSON.stringify([
          { revision: 1, status: "deployed" },
          { revision: 2, status: "pending-upgrade" },
        ]),
      },
      { stdout: "Rollback was a success" },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });
    const result = await runner.recoverRelease({ namespace: "octogee", gatewayId: "default-green" });
    expect(result).toMatch(/rolled back .*default-green.* revision 1/);
    expect(calls.some((c) => c[0] === "rollback" && c.includes("1"))).toBe(true);
  });

  it("uninstalls a stuck first-install when there is no good revision to roll back to", async () => {
    const { runHelm, calls } = mockSubprocess([
      { stdout: JSON.stringify([{ revision: 1, status: "pending-install" }]) },
      { stdout: "release uninstalled" },
    ]);
    const runner = createHelmSubprocessRunner({ runHelm, log: vi.fn() });
    const result = await runner.recoverRelease({ namespace: "octogee", gatewayId: "default-blue" });
    expect(result).toMatch(/uninstalled stuck first-install/);
    expect(calls.some((c) => c[0] === "uninstall")).toBe(true);
  });
});

 it("renders a cluster user without creating or selecting a home claim", async () => {
   const runKubectl = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
   const { runHelm } = mockSubprocess([{ stdout: "ok" }, { stdout: "ok" }]);
   const runner = createHelmSubprocessRunner({ runHelm: withPreflightStatusNotFound(runHelm), log: vi.fn(), runKubectl });
   await runner.upsertInstance({ namespace: "octogee", gatewayId: "b-hobby", gatewayClass: "isolated", sizingTier: "s", imageRepository: REPO, imageTag: "abc", chartPath: "/charts/octogee-gateway" });
   expect(runKubectl.mock.calls.flat(2)).not.toContain("pvc");
   const upgrade = runHelm.mock.calls.map(([args]) => args).find(args => args.includes("upgrade"))!;
   expect(upgrade.filter(arg => arg.startsWith("userHome"))).toEqual([]);
 });
 it("leaves the user home size to the chart for shared gateways", async () => {
   const args = buildUpgradeArgs({ release: "octogee-gw-shared-0", chartPath: "/c", namespace: "octogee", gatewayId: "shared-0", gatewayClass: "shared", imageRepository: REPO, imageTag: "abc", upgradeTimeout: "10m" });
   expect(args.some(arg => arg.startsWith("userHome"))).toBe(false);
 });
