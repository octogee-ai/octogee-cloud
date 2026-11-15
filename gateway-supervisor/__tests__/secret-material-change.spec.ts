import { describe, expect, it } from "vitest";

import {
  collectSecretRefs,
  configSecretMaterialChangeReasons,
  createSecretMaterialLedger,
} from "../lib/secret-material-change.js";

const defaultAgentRef = { source: "file", provider: "octogee-mattermost", id: "/alice-coach" };
const projectRef = { source: "file", provider: "octogee-mattermost", id: "/alice-proj-orbit" };

function config(overrides: Record<string, unknown> = {}) {
  return {
    secrets: { providers: { "octogee-mattermost": { source: "file", path: "/secrets/mm.json" } } },
    agents: { list: [{ id: "octogee-alice-coach", model: "anthropic/claude" }] },
    channels: { mattermost: { accounts: { "alice-coach": { botToken: defaultAgentRef, url: "https://mm" } } } },
    ...overrides,
  };
}

describe("collectSecretRefs", () => {
  it("indexes every SecretRef by its config path", () => {
    expect([...collectSecretRefs(config()).entries()]).toEqual([
      ["channels.mattermost.accounts.alice-coach.botToken", "file:octogee-mattermost:/alice-coach"],
    ]);
  });

  it("ignores objects that only resemble a SecretRef", () => {
    const refs = collectSecretRefs({
      a: { source: "file", provider: "p" },
      b: { source: "file", provider: "p", id: "/x", extra: true },
      c: { source: "sqlite", provider: "p", id: "/x" },
      d: [{ source: "env", provider: "default", id: "TOKEN" }],
    });
    expect([...refs.entries()]).toEqual([["d.0", "env:default:TOKEN"]]);
  });

  it("indexes nothing for a non-object config", () => {
    expect(collectSecretRefs(undefined).size).toBe(0);
    expect(collectSecretRefs("nope").size).toBe(0);
  });
});

describe("configSecretMaterialChangeReasons", () => {
  it("reports nothing when the SecretRefs and provider config are identical", () => {
    expect(configSecretMaterialChangeReasons(config(), config())).toEqual([]);
  });

  it("reports nothing when only non-secret config changed", () => {
    const after = config({
      agents: { list: [{ id: "octogee-alice-coach", model: "anthropic/other" }] },
      bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost" } }],
    });
    expect(configSecretMaterialChangeReasons(config(), after)).toEqual([]);
  });

  it("reports an added SecretRef", () => {
    const after = config({
      channels: { mattermost: { accounts: {
        "alice-coach": { botToken: defaultAgentRef },
        "alice-proj-orbit": { botToken: projectRef },
      } } },
    });
    expect(configSecretMaterialChangeReasons(config(), after)).toEqual([
      "SecretRef added at channels.mattermost.accounts.alice-proj-orbit.botToken",
    ]);
  });

  it("reports a removed SecretRef", () => {
    const after = config({ channels: { mattermost: { accounts: {} } } });
    expect(configSecretMaterialChangeReasons(config(), after)).toEqual([
      "SecretRef removed at channels.mattermost.accounts.alice-coach.botToken",
    ]);
  });

  it("reports a SecretRef whose target changed in place", () => {
    const after = config({
      channels: { mattermost: { accounts: {
        "alice-coach": { botToken: { ...defaultAgentRef, id: "/alice-coach-rotated" } },
      } } },
    });
    expect(configSecretMaterialChangeReasons(config(), after)).toEqual([
      "SecretRef changed at channels.mattermost.accounts.alice-coach.botToken",
    ]);
  });

  it("reports a literal replaced by a SecretRef and a SecretRef replaced by a literal", () => {
    const literal = config({
      channels: { mattermost: { accounts: { "alice-coach": { botToken: "pat-literal" } } } },
    });
    expect(configSecretMaterialChangeReasons(literal, config())).toEqual([
      "SecretRef added at channels.mattermost.accounts.alice-coach.botToken",
    ]);
    expect(configSecretMaterialChangeReasons(config(), literal)).toEqual([
      "SecretRef removed at channels.mattermost.accounts.alice-coach.botToken",
    ]);
  });

  it("reports a secret provider configuration change", () => {
    const after = config({
      secrets: { providers: { "octogee-mattermost": { source: "file", path: "/secrets/moved.json" } } },
    });
    expect(configSecretMaterialChangeReasons(config(), after)).toEqual([
      "secret provider config changed",
    ]);
  });

  it("treats an unknown before-config as every SecretRef being added", () => {
    expect(configSecretMaterialChangeReasons(undefined, config())).toEqual([
      "secret provider config changed",
      "SecretRef added at channels.mattermost.accounts.alice-coach.botToken",
    ]);
  });
});

describe("createSecretMaterialLedger", () => {
  it("starts unchanged and records every non-empty reason in order", () => {
    const ledger = createSecretMaterialLedger();
    expect(ledger.changed).toBe(false);
    expect(ledger.reasons).toEqual([]);

    ledger.note(null);
    ledger.note(undefined);
    ledger.note([]);
    expect(ledger.changed).toBe(false);

    ledger.note("Mattermost account secrets file changed");
    ledger.note(["SecretRef added at a", "SecretRef removed at b"]);
    expect(ledger.changed).toBe(true);
    expect(ledger.reasons).toEqual([
      "Mattermost account secrets file changed",
      "SecretRef added at a",
      "SecretRef removed at b",
    ]);
  });

  it("records a boolean flag under its label only when set", () => {
    const ledger = createSecretMaterialLedger();
    ledger.noteIf(false, "OAuth store restored");
    expect(ledger.changed).toBe(false);
    ledger.noteIf(true, "OAuth store restored");
    expect(ledger.reasons).toEqual(["OAuth store restored"]);
  });
});
