import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "path";
import { buildProvisioningContext } from "@octogee/core/provisionSteps";
import { staticUserEntitlements } from "@octogee/shared/types/user-entitlements";
import { CUSTOMERS_DIR } from "../lib/config.js";
import { installUserEntitlementsForTest, planUserEntitlements } from "./helpers/user-entitlements.js";

describe("buildProvisioningContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();

vi.setSystemTime(new Date("2026-03-14T08:30:00Z"));
    installUserEntitlementsForTest(planUserEntitlements);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("populates every field from a minimal user doc", () => {
    const ctx = buildProvisioningContext("uid-1", { username: "acme" });

    expect(ctx).toEqual({
      uid: "uid-1",
      slug: "acme",
      contextTemplateKey: "house",
      provisionedProductFields: { plan: "house" },
      ownerName: "acme",
      customerDir: path.join(CUSTOMERS_DIR, "acme"),
      today: "2026-03-14",
      username: "acme",
      templateVars: {
        uid: "uid-1",
        ownerName: "acme",
        username: "acme",
        createdAt: "2026-03-14",
        slug: "acme",
        timeZone: "unknown",
      },
      userData: { username: "acme" },
    });
  });

  it("takes the seed template and the provisioned product fields from the plan inputs the installed entitlements pick", () => {
    const ctx = buildProvisioningContext("uid-1", {
      username: "acme",
      plan: "pro",
      tier: "free",
    });

    expect(ctx.contextTemplateKey).toBe("pro");
    expect(ctx.provisionedProductFields).toEqual({ plan: "pro" });
  });

  it("seeds the default template with no product fields under the default entitlements", () => {
    installUserEntitlementsForTest(staticUserEntitlements);

    const ctx = buildProvisioningContext("uid-1", { username: "acme", plan: "pro" });

    expect(ctx.contextTemplateKey).toBe("default");
    expect(ctx.provisionedProductFields).toEqual({});
  });

  it("carries no tier of its own on the context or in the template variables", () => {
    const ctx = buildProvisioningContext("uid-1", { username: "acme", tier: "pro" });

    expect("tier" in ctx).toBe(false);
    expect("tier" in ctx.templateVars).toBe(false);
  });

  it("slug, ownerName, and username all derive from userData.username (DATA-MODEL-REVIEW v3 §2)", () => {
    const ctx = buildProvisioningContext("uid-1", { username: "bendecho" });

    expect(ctx.slug).toBe("bendecho");
    expect(ctx.ownerName).toBe("bendecho");
    expect(ctx.username).toBe("bendecho");
  });

  it("customerDir composes from CUSTOMERS_DIR + slug — not from any user-controlled field", () => {
    const ctx = buildProvisioningContext("uid-1", {
      username: "acme",
      customerDir: "/attacker/controlled",
    });

    expect(ctx.customerDir).toBe(path.join(CUSTOMERS_DIR, "acme"));
  });

  it("templateVars contains the six substitution keys consumed by readTierTemplateFile", () => {
    const ctx = buildProvisioningContext("uid-1", { username: "acme", tier: "pro" });

    expect(Object.keys(ctx.templateVars).sort()).toEqual([
      "createdAt",
      "ownerName",
      "slug",
      "timeZone",
      "uid",
      "username",
    ]);
  });

  it("seeds USER.md with the user's captured time zone and 'unknown' until one is captured or when it is malformed", () => {
    expect(buildProvisioningContext("uid-1", { username: "acme", preferences: { timeZone: "America/Chicago" } }).templateVars.timeZone).toBe("America/Chicago");
    expect(buildProvisioningContext("uid-1", { username: "acme", preferences: { timeZone: "../etc" } }).templateVars.timeZone).toBe("unknown");
    expect(buildProvisioningContext("uid-1", { username: "acme" }).templateVars.timeZone).toBe("unknown");
  });

  it("today is the current UTC date as YYYY-MM-DD (ISO date slice, time-of-day irrelevant)", () => {
    vi.setSystemTime(new Date("2026-12-31T23:59:59Z"));
    const ctx = buildProvisioningContext("uid-1", { username: "acme" });

    expect(ctx.today).toBe("2026-12-31");
    expect(ctx.templateVars.createdAt).toBe("2026-12-31");
  });

  it("passes userData through unchanged on the returned ctx (steps read auxiliary fields off it)", () => {
    const userData = {
      username: "acme",
      email: "a@example.test",
      onboarding: { vibe: "calm" },
      displayName: "First Last",
      photoURL: "https://example.com/a.png",
    };
    const ctx = buildProvisioningContext("uid-1", userData);

    expect(ctx.userData).toBe(userData);
  });

  it("throws when userData.username is missing — onboarding must run first", () => {
    expect(() => buildProvisioningContext("uid-1", {})).toThrow(
      /Cannot provision uid=uid-1: missing users\/\{uid\}\.username/,
    );
  });

  it("throws when userData.username is an empty string", () => {
    expect(() => buildProvisioningContext("uid-1", { username: "" })).toThrow(
      /missing users\/\{uid\}\.username/,
    );
  });

  it("throws when userData.username is not a string (number, object, null)", () => {
    expect(() => buildProvisioningContext("uid-1", { username: 42 })).toThrow(
      /missing users\/\{uid\}\.username/,
    );
    expect(() => buildProvisioningContext("uid-1", { username: null })).toThrow(
      /missing users\/\{uid\}\.username/,
    );
    expect(() =>
      buildProvisioningContext("uid-1", { username: { v: "acme" } }),
    ).toThrow(/missing users\/\{uid\}\.username/);
  });

  it("error message carries the uid so log readers can trace which user failed", () => {
    expect(() => buildProvisioningContext("user-abc-123", {})).toThrow(
      /uid=user-abc-123/,
    );
  });

  it("rejects path-traversal slugs (defends against fs path injection via username)", () => {
    expect(() =>
      buildProvisioningContext("uid-1", { username: "../etc/passwd" }),
    ).toThrow(/not a valid slug/);
    expect(() =>
      buildProvisioningContext("uid-1", { username: "foo/bar" }),
    ).toThrow(/not a valid slug/);
    expect(() =>
      buildProvisioningContext("uid-1", { username: "foo\0bar" }),
    ).toThrow(/not a valid slug/);
  });

  it("rejects reserved usernames (general, defaultAgent, admin, town-square, etc.)", () => {
    for (const reserved of ["general", "coach", "admin", "town-square", "proj"]) {
      expect(() =>
        buildProvisioningContext("uid-1", { username: reserved }),
      ).toThrow(/not a valid slug/);
    }
  });

  it("rejects uppercase / whitespace / leading-hyphen slugs", () => {
    for (const bad of ["Acme", "acme co", "-acme", "acme-", "acme--co"]) {
      expect(() =>
        buildProvisioningContext("uid-1", { username: bad }),
      ).toThrow(/not a valid slug/);
    }
  });
});
