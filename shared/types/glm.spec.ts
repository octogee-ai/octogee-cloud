import { describe, it, expect } from "vitest";
import {
  GATEWAY_CLASSES,
  dualReadGatewayClassValue,
  isIsolatedGatewayClassValue,
  readSchedulerMigrationIdentity,
  defaultIsolatedGatewayAccess,
  deriveGatewayIdentity,
  ISOLATED_GATEWAY_LOCKED_ACCESS,
  isValidGatewayId,
  isValidNewGatewayId,
  isolatedGatewayServiceAccountName,
  gatewayVmInstanceName,
  isGatewayRuntime,
  resolveGatewayRuntime,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  resolveUserGatewayControlState,
  isGatewayClassControlUiAccessEnabled,
  isGatewayControlIdentity,
  resolveGatewayControlIdentity,
  resolveOperationOrigin,
  isOperationAuditRecord,
  isOperationAuditRow,
  OPERATION_AUDIT_RECORD_TYPE,
  OPERATION_AUDIT_SCHEMA_VERSION,
  homeCheckpointOutstanding,
  isGatewayVmHomeCheckpoint,
  isDisposableHomeCheckpoint,
  readUserParkedVm,
  isGatewayVmImageObservation,
} from "./glm";

describe("operation origin", () => {
  it("treats operations without an origin as manual", () => {
    expect(resolveOperationOrigin(undefined)).toBe("operator");
    expect(resolveOperationOrigin("operator")).toBe("operator");
    expect(resolveOperationOrigin("automatic")).toBe("automatic");
  });
});

describe("deriveGatewayIdentity", () => {
  it("uses the explicit gateway field when present", () => {
    expect(deriveGatewayIdentity("default-blue", "default")).toBe("default");
    expect(deriveGatewayIdentity("walter", "walter")).toBe("walter");
  });

  it("ignores a non-string explicit value and falls back to convention-parse", () => {
    expect(deriveGatewayIdentity("default-blue", undefined)).toBe("default");
    expect(deriveGatewayIdentity("default-blue", null)).toBe("default");
    expect(deriveGatewayIdentity("default-blue", 42)).toBe("default");
  });

  it("strips a trailing -blue or -green roll-role suffix by convention", () => {
    expect(deriveGatewayIdentity("default-blue")).toBe("default");
    expect(deriveGatewayIdentity("default-green")).toBe("default");
  });

  it("treats an id without a roll-role suffix as its own bare identity", () => {
    expect(deriveGatewayIdentity("walter")).toBe("walter");
    expect(deriveGatewayIdentity("jack")).toBe("jack");
  });

  it("does not strip -blue/-green from the middle of an id, only a trailing suffix", () => {
    expect(deriveGatewayIdentity("blue-team")).toBe("blue-team");
    expect(deriveGatewayIdentity("green-house")).toBe("green-house");
  });
});

describe("isolatedGatewayServiceAccountName", () => {
  it("prefixes the bare gateway id with the user KSA prefix", () => {
    expect(isolatedGatewayServiceAccountName("walter")).toBe("octogee-gw-walter");
    expect(isolatedGatewayServiceAccountName("default")).toBe("octogee-gw-default");
  });

  it("uses the gateway id verbatim — ids are bare, no prefix manipulation", () => {
    expect(isolatedGatewayServiceAccountName("mountain-mama")).toBe(
      "octogee-gw-mountain-mama",
    );
  });
});

describe("isValidGatewayId", () => {
  it("accepts bare gateway identities that fit rendered Kubernetes resource names", () => {
    expect(isValidGatewayId("default")).toBe(true);
    expect(isValidGatewayId("walter")).toBe(true);
    expect(isValidGatewayId("mountain-mama")).toBe(true);
    expect(isValidGatewayId("g")).toBe(true);
    expect(isValidGatewayId("a".repeat(32))).toBe(true);
  });

  it("rejects values that would break routing, secrets, or Kubernetes names", () => {
    for (const bad of [
      "",
      "Walter",
      "gw_test",
      "-walter",
      "walter-",
      "has space",
      "gw/evil",
      "../x",
      "a".repeat(33),
      undefined,
      123,
    ]) {
      expect(isValidGatewayId(bad)).toBe(false);
    }
  });
});

describe("isValidNewGatewayId", () => {
  it("accepts ordinary bare identities", () => {
    expect(isValidNewGatewayId("default")).toBe(true);
    expect(isValidNewGatewayId("walter")).toBe(true);
    expect(isValidNewGatewayId("mountain-mama")).toBe(true);
  });

  it("rejects ids ending in the reserved -blue/-green roll-role suffixes — they would mis-group under the convention fallback", () => {
    expect(isValidNewGatewayId("team-blue")).toBe(false);
    expect(isValidNewGatewayId("team-green")).toBe(false);
    expect(isValidNewGatewayId("default-blue")).toBe(false);
  });

  it("still allows the words blue/green anywhere but as a trailing roll-role suffix", () => {
    expect(isValidNewGatewayId("blue-team")).toBe(true);
    expect(isValidNewGatewayId("bluegreen")).toBe(true);
    expect(isValidNewGatewayId("blue")).toBe(true);
    expect(isValidNewGatewayId("green")).toBe(true);
  });

  it("keeps every base isValidGatewayId rejection", () => {
    for (const bad of ["", "Walter", "-walter", "a".repeat(33), undefined, 123]) {
      expect(isValidNewGatewayId(bad)).toBe(false);
    }
  });

  it("existing suffixed INSTANCE ids stay valid for routing/rollout — only new-gateway creation reserves the suffix", () => {
    expect(isValidGatewayId("default-blue")).toBe(true);
    expect(isValidGatewayId("default-green")).toBe(true);
  });
});

describe("isolated class dual read", () => {
  it("reads the previous release's builder value as isolated for class, profile and image profile", () => {
    expect(dualReadGatewayClassValue("builder")).toBe("isolated");
    expect(dualReadGatewayClassValue("isolated")).toBe("isolated");
    expect(isIsolatedGatewayClassValue("builder")).toBe(true);
    expect(isIsolatedGatewayClassValue("isolated")).toBe(true);
  });

  it("passes every other value through so validators still reject unknown classes", () => {
    for (const value of ["shared", "standard", "operator", "Isolated", " isolated", "", undefined, null]) {
      expect(dualReadGatewayClassValue(value)).toBe(value);
      expect(isIsolatedGatewayClassValue(value)).toBe(false);
    }
  });

  it("resolves the previous release's builder class and image profile as isolated", () => {
    for (const value of ["builder", "isolated"]) {
      const stored = { gatewayClass: value, imageProfile: value };
      expect(resolveUserGatewayControlState({ ...stored, ownerUid: "u1", builderAccess: { controlUiEnabled: true } as never }, "u1"))
        .toEqual({ gatewayProfile: "isolated", controlUiEnabled: true });
    }
  });
});

describe("gateway class/profile resolution", () => {
  it("exposes exactly the shared and disposable isolated user classes", () => {
    expect(GATEWAY_CLASSES).toEqual(["shared", "isolated"]);
  });

  it("does not infer a user class from a legacy runtime profile", () => {
    expect(resolveGatewayClass({ profile: "operator" as never })).toBe("shared");
  });

  it("fails stale user class and image values closed at runtime", () => {
    expect(resolveGatewayClass({ gatewayClass: "operator" as never })).toBe("shared");
    expect(resolveGatewayImageProfile({ imageProfile: "operator" as never })).toBe("standard");
  });

  it("defaults missing legacy profile to shared class + standard image", () => {
    expect(resolveGatewayClass({})).toBe("shared");
    expect(resolveGatewayImageProfile({})).toBe("standard");
  });

  it("maps the isolated class to its isolated image profile", () => {
    expect(resolveGatewayClass({ gatewayClass: "isolated", profile: "standard" })).toBe("isolated");
    expect(resolveGatewayImageProfile({ gatewayClass: "isolated", profile: "standard" })).toBe("isolated");
  });

  it("lets explicit imageProfile override the class-derived image", () => {
    expect(resolveGatewayImageProfile({ gatewayClass: "isolated", imageProfile: "isolated" })).toBe("isolated");
    expect(resolveGatewayImageProfile({ gatewayClass: "shared", imageProfile: "standard" })).toBe("standard");
  });
});

describe("defaultIsolatedGatewayAccess", () => {
  it("grants Control UI to an owned runtime gateway and locks an un-owned one", () => {
    expect(defaultIsolatedGatewayAccess("uid-chris")).toEqual({
      controlUiEnabled: true,
      reason: "owned-runtime-gateway",
    });
    expect(defaultIsolatedGatewayAccess(null)).toEqual(ISOLATED_GATEWAY_LOCKED_ACCESS);
    expect(defaultIsolatedGatewayAccess(undefined)).toEqual(ISOLATED_GATEWAY_LOCKED_ACCESS);
  });
});

describe("isGatewayClassControlUiAccessEnabled", () => {
  it("requires explicitly enabled Control UI on isolated classes", () => {
    expect(isGatewayClassControlUiAccessEnabled("isolated", {
      controlUiEnabled: true,
    })).toBe(true);
    expect(isGatewayClassControlUiAccessEnabled("shared", {
      controlUiEnabled: true,
    })).toBe(false);
    expect(isGatewayClassControlUiAccessEnabled("isolated", {
      controlUiEnabled: true,
    })).toBe(true);
    expect(isGatewayClassControlUiAccessEnabled("isolated", {})).toBe(false);
    expect(isGatewayClassControlUiAccessEnabled("isolated", {
      controlUiEnabled: false,
    })).toBe(false);
  });
});

describe("resolveUserGatewayControlState", () => {
  it("does not infer Control UI from the retired operator image profile", () => {
    expect(
      resolveUserGatewayControlState(
        {
          gatewayClass: "shared",
          imageProfile: "operator",
          ownerUid: "uid-chris",
          builderAccess: { controlUiEnabled: true },
        },
        "uid-chris",
      ),
    ).toEqual({ gatewayProfile: "standard", controlUiEnabled: false });
  });

  it("enables Control UI for the owner of an explicitly enabled isolated gateway", () => {
    expect(
      resolveUserGatewayControlState(
        {
          gatewayClass: "isolated",
          imageProfile: "standard",
          ownerUid: "uid-chris",
          builderAccess: { controlUiEnabled: true },
        },
        "uid-chris",
      ),
    ).toEqual({ gatewayProfile: "isolated", controlUiEnabled: true });
  });

  it("does not grant Control UI to a non-owner", () => {
    expect(
      resolveUserGatewayControlState(
        { gatewayClass: "isolated", ownerUid: "uid-walter", builderAccess: { controlUiEnabled: true } },
        "uid-jack",
      ).controlUiEnabled,
    ).toBe(false);
  });

  it("denies Control UI to a guest migrated onto someone else's isolated gateway", () => {
    expect(
      resolveUserGatewayControlState(
        { gatewayClass: "isolated", ownerUid: "uid-walter", builderAccess: { controlUiEnabled: true } },
        "uid-jack",
      ),
    ).toEqual({ gatewayProfile: "isolated", controlUiEnabled: false });
  });

  it("never enables Control UI on a shared gateway", () => {
    expect(
      resolveUserGatewayControlState({ gatewayClass: "shared", ownerUid: "uid-chris" }, "uid-chris"),
    ).toEqual({ gatewayProfile: "standard", controlUiEnabled: false });
  });

  it("respects explicitly locked user access even for the owner", () => {
    expect(
      resolveUserGatewayControlState(
        { gatewayClass: "isolated", ownerUid: "uid-chris", builderAccess: { controlUiEnabled: false } },
        "uid-chris",
      ).controlUiEnabled,
    ).toBe(false);
  });
});

describe("operation audit record discriminator", () => {
  const valid = {
      recordType: OPERATION_AUDIT_RECORD_TYPE,
      schemaVersion: OPERATION_AUDIT_SCHEMA_VERSION,
      status: "recorded",
      lifecycleStage: "intent-recorded",
      idempotencyKey: "release-v1",
      mutationFingerprint: "abc123",
      mutation: { action: "move-alias" },
      actor: "fleet-cli:operator",
      forced: true,
      what: "move alias",
      why: "TEST verified",
      target: { alias: "stable" },
      preActionStatus: { target: "old" },
      aliasPlan: [],
      createdAt: 1,
      completedAt: null,
    };

  it("recognizes a complete current-schema audit without treating commands as audits", () => {
    expect(isOperationAuditRecord(valid)).toBe(true);
    expect(isOperationAuditRecord({ kind: "rollout", status: "pending" })).toBe(false);
    expect(isOperationAuditRecord(null)).toBe(false);
  });

  it("quarantines malformed and future audit rows by discriminator while rejecting their schema", () => {
    for (const row of [
      { ...valid, schemaVersion: 2 },
      { ...valid, actor: undefined },
      { ...valid, mutation: [] },
      { ...valid, status: "completed", lifecycleStage: "intent-recorded" },
    ]) {
      expect(isOperationAuditRow(row)).toBe(true);
      expect(isOperationAuditRecord(row)).toBe(false);
    }
  });

  it("accepts only legal status and lifecycle pairs with their required claim and outcome fields", () => {
    expect(isOperationAuditRecord({
      ...valid,
      status: "in-progress",
      lifecycleStage: "action-started",
      actionClaimId: "runner-1",
      actionStartedAt: 2,
      actionRecoveryCount: 0,
    })).toBe(true);
    expect(isOperationAuditRecord({
      ...valid,
      status: "completed",
      lifecycleStage: "action-completed",
      actionClaimId: "runner-1",
      actionStartedAt: 2,
      actionRecoveryCount: 0,
      outcome: "completed",
      completedAt: 3,
    })).toBe(true);
    expect(isOperationAuditRecord({
      ...valid,
      status: "completed",
      lifecycleStage: "action-completed",
      outcome: "completed",
      completedAt: 3,
    })).toBe(false);
  });
});

describe("gateway control identity", () => {
  it("defaults every absent or unknown value to the shared operator identity", () => {
    expect(resolveGatewayControlIdentity(undefined)).toBe("shared-operator");
    expect(resolveGatewayControlIdentity(null)).toBe("shared-operator");
    expect(resolveGatewayControlIdentity("trusted-proxy")).toBe("shared-operator");
    expect(resolveGatewayControlIdentity("per-user")).toBe("per-user");
  });

  it("recognizes only the two declared modes", () => {
    expect(isGatewayControlIdentity("shared-operator")).toBe(true);
    expect(isGatewayControlIdentity("per-user")).toBe(true);
    expect(isGatewayControlIdentity("Per-User")).toBe(false);
    expect(isGatewayControlIdentity(true)).toBe(false);
  });
});

describe("gateway runtime + VM naming", () => {
  it("defaults an unknown runtime to cluster and accepts gce-vm", () => {
    expect(resolveGatewayRuntime(undefined)).toBe("cluster");
    expect(resolveGatewayRuntime("nope")).toBe("cluster");
    expect(resolveGatewayRuntime("gce-vm")).toBe("gce-vm");
    expect(isGatewayRuntime("cluster")).toBe(true);
    expect(isGatewayRuntime("local")).toBe(false);
  });

  it("names the user's VM by environment and owner, not by the per-lease gateway id", () => {
    expect(gatewayVmInstanceName("test", "UidAbc123")).toBe("octogee-computer-test-uidabc123");
    expect(gatewayVmInstanceName("prod", "UidAbc123")).toBe("octogee-computer-prod-uidabc123");
    expect(gatewayVmInstanceName("test", "  x_y  ")).toBe("octogee-computer-test-x-y");
    expect(() => gatewayVmInstanceName("octogee-test", "uid")).toThrow(/not a name segment/);
  });

  it("keeps long owner ids within the 63-character GCE limit with a stable hash suffix", () => {
    const longUid = `${"mountain-mama-".repeat(6)}7-lease-pro`;
    const name = gatewayVmInstanceName("prod", longUid);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^octogee-computer-prod-[a-z0-9-]+-[0-9a-f]{8}$/);
    expect(gatewayVmInstanceName("prod", longUid)).toBe(name);
    expect(gatewayVmInstanceName("prod", `${longUid}-x`)).not.toBe(name);
  });

  it("refuses an id with nothing to name", () => {
    expect(() => gatewayVmInstanceName("test", "")).toThrow(/empty/);
    expect(() => gatewayVmInstanceName("test", "___")).toThrow(/no usable characters/);
  });
});

describe("homeCheckpointOutstanding", () => {
  it("does not acknowledge a request with a periodic snapshot uploaded after that request", () => {
    expect(homeCheckpointOutstanding({ checkpointRequestedAt: 1_000, checkpointAcknowledgedAt: null, lastCheckpoint: { completedAt: 5_000 } as never } as never)).toBe(true);
    expect(homeCheckpointOutstanding({ checkpointRequestedAt: 1_000, checkpointAcknowledgedAt: 900, lastCheckpoint: { completedAt: 5_000 } as never } as never)).toBe(true);
  });

  it("requires the completed snapshot to acknowledge the request", () => {
    expect(homeCheckpointOutstanding(undefined)).toBe(false);
    expect(homeCheckpointOutstanding({ checkpointRequestedAt: null, lastCheckpoint: null })).toBe(false);
    expect(homeCheckpointOutstanding({ checkpointRequestedAt: 1_000, lastCheckpoint: null })).toBe(true);
    expect(homeCheckpointOutstanding({ checkpointRequestedAt: 1_000, lastCheckpoint: { completedAt: 999 } as never })).toBe(true);
    expect(homeCheckpointOutstanding({ checkpointRequestedAt: 1_000, checkpointAcknowledgedAt: 1_000, lastCheckpoint: { completedAt: 1_000 } as never })).toBe(false);
    expect(homeCheckpointOutstanding({ checkpointRequestedAt: 1_000, checkpointAcknowledgedAt: 1_000, lastCheckpoint: { completedAt: 5_000 } as never })).toBe(false);
  });
});

describe("readUserParkedVm", () => {
  const parked = {
    instanceName: "octogee-computer-test-uida",
    zone: "us-west1-b",
    instanceId: "4242",
    gatewayId: "b-x",
    parkedAt: 2_000,
    checkpoint: { outcome: "fresh", requestedAt: 1_000, completedAt: 1_500 },
  };

  it("reads a well-formed parked VM from the user's provisioning record", () => {
    expect(readUserParkedVm({ provisioning: { computer: parked } })).toEqual(parked);
    expect(readUserParkedVm({ provisioning: { computer: { ...parked, instanceId: null, checkpoint: { outcome: "stale", requestedAt: null, completedAt: null } } } }))
      .toMatchObject({ instanceId: null, checkpoint: { outcome: "stale" } });
  });

  it("returns null for a missing or malformed record instead of a partial one", () => {
    expect(readUserParkedVm(undefined)).toBeNull();
    expect(readUserParkedVm({})).toBeNull();
    expect(readUserParkedVm({ provisioning: { openclaw: { gatewayId: "b-x" } } })).toBeNull();
    expect(readUserParkedVm({ provisioning: { computer: { ...parked, zone: "" } } })).toBeNull();
    expect(readUserParkedVm({ provisioning: { computer: { ...parked, checkpoint: { outcome: "fresh" } } } })).toBeNull();
    expect(readUserParkedVm({ provisioning: { computer: { ...parked, checkpoint: { ...parked.checkpoint, outcome: "unknown" } } } })).toBeNull();
  });
});

describe("VM image observations", () => {
  const containers = ["gateway", "gateway-edge"].map(name => ({ name, imageReference: "", digests: [], running: false }));
  it("requires a bounded complete sample with server time and instance identity", () => {
    const observation = { containers, observedAt: 1000, instanceId: "4242" };
    expect(isGatewayVmImageObservation(observation)).toBe(true);
    for (const invalid of [null, { containers }, { ...observation, instanceId: "" }, { ...observation, observedAt: Infinity }, { ...observation, observedAt: -1 }]) {
      expect(isGatewayVmImageObservation(invalid)).toBe(false);
    }
  });
});


describe("VM recovery checkpoint validation", () => {
  const saved = { name: "20260905T101500Z.tar.gz", size: 2048, sha256: "a".repeat(64), instanceId: "4242", generation: "9007199254740995", completedAt: 1000, coverage: "builder-home-v2", writerProtocol: 2 };
  it("preserves exact generation strings and refuses malformed protocol/coverage", () => {
    expect(isDisposableHomeCheckpoint(saved)).toBe(true);
    expect(isGatewayVmHomeCheckpoint({ ...saved, generation: Number("9007199254740995") })).toBe(false);
    expect(isGatewayVmHomeCheckpoint({ ...saved, coverage: "unknown" })).toBe(false);
    expect(isGatewayVmHomeCheckpoint({ ...saved, writerProtocol: 1 })).toBe(false);
    expect(isDisposableHomeCheckpoint({ ...saved, instanceId: null })).toBe(false);
  });
});


describe("scheduler migration identity", () => {
  it("requires claim-qualified scheduler custody", () => {
    expect(readSchedulerMigrationIdentity("op-1", "mig-op-1:scheduler:2")).toBeNull();
    expect(readSchedulerMigrationIdentity("op-1", "mig-op-1:scheduler:2:claim:1000")).toEqual({ attempt: 2, claimStartedAt: 1000 });
  });
  it.each([null, "mig-other:scheduler:2:claim:1000", "mig-op-1:scheduler:02", "mig-op-1:scheduler:0", "mig-op-1:scheduler:2:claim:0",
    "mig-op-1:scheduler:2:claim:01000", "mig-op-1:scheduler:2:claim:1000:extra", "mig-op-1:scheduler:2:claim:9007199254740992"])("rejects malformed or foreign custody %s", id => {
    expect(readSchedulerMigrationIdentity("op-1", id)).toBeNull();
  });
});
