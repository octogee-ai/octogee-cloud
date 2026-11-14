import { isDeepStrictEqual } from "node:util";
import { Router, type Request } from "express";

import { admitAdminDryRunMarker } from "./admin-dry-run.js";
import {
  ADMIN_FLEET_REQUEST_REASON,
  createAdminFleetMutationRunner,
  respondToAdminFleetMutationError,
} from "./admin-fleet-router.js";
import { hasComputerShape } from "./operator-isolated-gateway.js";
import type { GatewayComputerProfile, GatewaySizingProfile } from "./platform-state/config.js";
import { isGatewaySizingProfile } from "./platform-state/config.js";
import type { PlatformStateStore } from "./platform-state/store.js";

const SIZING_PROFILE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SET_SIZING_PROFILE_TRANSACTION = "admin.sizing-profiles.set";

type Profiles = Readonly<Record<string, GatewaySizingProfile>>;

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

export interface AdminSizingProfileRouterDeps {
  store: PlatformStateStore;
}

function refusal(status: number, code: string, error: string, extra: Record<string, unknown> = {}): { refusal: Answer } {
  return { refusal: { status, body: { code, error, ...extra } } };
}

function own(profiles: Profiles, name: string): GatewaySizingProfile | null {
  return Object.hasOwn(profiles, name) ? profiles[name]! : null;
}

async function storedProfiles(store: Pick<PlatformStateStore, "config">): Promise<Profiles> {
  return (await store.config.orchestrator.get())?.sizingProfiles ?? {};
}

function isPositiveWhole(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function computerReadFields(computer: GatewayComputerProfile): GatewayComputerProfile {
  if (computer.runtime === "cluster") return { runtime: computer.runtime, homeSizeGiB: computer.homeSizeGiB };
  const { runtime, desktop, machineType, provisioningModel, bootDisk, homeSizeGiB } = computer;
  return {
    runtime, desktop, machineType, provisioningModel, homeSizeGiB,
    bootDisk: bootDisk === null ? null : { sizeGb: bootDisk.sizeGb, type: bootDisk.type },
  };
}

function onlyReadFields(profile: GatewaySizingProfile): GatewaySizingProfile {
  if (profile.isolation === "shared") return { isolation: "shared" };
  return {
    isolation: "isolated",
    sizingTier: profile.sizingTier,
    computer: computerReadFields(profile.computer),
    fallbackStorageGb: profile.fallbackStorageGb,
  };
}

function hasWholeSizes(profile: GatewaySizingProfile): boolean {
  if (profile.isolation === "shared") return true;
  const { computer } = profile;
  const bootDiskWhole = computer.runtime === "cluster" || computer.bootDisk === null || isPositiveWhole(computer.bootDisk.sizeGb);
  return bootDiskWhole && isPositiveWhole(computer.homeSizeGiB) &&
    (profile.fallbackStorageGb === null || isPositiveWhole(profile.fallbackStorageGb));
}

function parseProfile(body: unknown): { profile: GatewaySizingProfile } | { refusal: Answer } {
  if (!isGatewaySizingProfile(body) || !isDeepStrictEqual(onlyReadFields(body), body) || !hasWholeSizes(body)) {
    return refusal(400, "sizing-profile-invalid",
      "the body must be {\"isolation\":\"shared\"} or an isolated profile with sizingTier, computer and fallbackStorageGb, " +
      "with sizes in positive whole numbers and no other fields");
  }
  if (body.isolation === "isolated" && !hasComputerShape(body)) {
    return refusal(400, "sizing-profile-no-vm", "an isolated sizing profile needs a VM machine type, provisioning model and boot disk");
  }
  return { profile: body };
}

function tierConflict(profiles: Profiles, name: string, profile: GatewaySizingProfile): { refusal: Answer } | null {
  if (profile.isolation !== "isolated") return null;
  const { sizingTier, computer } = profile;
  const rivals = Object.entries(profiles)
    .filter(([key, other]) => key !== name && other.isolation === "isolated" && other.sizingTier === sizingTier &&
      other.computer.runtime === computer.runtime && !isDeepStrictEqual(other.computer, computer))
    .map(([key]) => key)
    .sort();
  if (rivals.length === 0) return null;
  return refusal(409, "sizing-tier-conflict",
    `isolated sizing profiles at tier ${sizingTier} on the ${computer.runtime} runtime must have the same computer settings, and ${rivals.join(", ")} has different ones`,
    { sizingTier, sizingProfiles: rivals });
}

function unknownProfile(name: string): { refusal: Answer } {
  return refusal(404, "sizing-profile-unknown", `unknown sizing profile ${name}`);
}

export function addAdminSizingProfileRoutes(router: Router, deps: AdminSizingProfileRouterDeps): Router {
  const { store } = deps;
  const journal = createAdminFleetMutationRunner(store);
  const routes = Router();
  routes.use(admitAdminDryRunMarker);

  async function setProfile(req: Request, name: string): Promise<Answer> {
    if (!SIZING_PROFILE_NAME.test(name)) {
      return refusal(400, "sizing-profile-name-invalid",
        "a sizing profile name is 1 to 63 lower-case letters, digits or hyphens, and starts and ends with a letter or digit").refusal;
    }
    const parsed = parseProfile(req.body);
    if ("refusal" in parsed) return parsed.refusal;
    const { profile } = parsed;
    const current = await storedProfiles(store);
    const conflict = tierConflict(current, name, profile);
    if (conflict) return conflict.refusal;
    return journal({
      req,
      what: "set sizing profile",
      why: ADMIN_FLEET_REQUEST_REASON,
      target: { sizingProfile: name },
      preActionStatus: { profile: own(current, name) },
      mutation: { kind: "set-sizing-profile", sizingProfile: name, profile },
      classifyResult: (answer) => answer.status >= 400
        ? { outcome: "failed", error: String(answer.body.error) }
        : { outcome: "completed" },
      action: (claim) => store.transaction({ label: SET_SIZING_PROFILE_TRANSACTION }, async (transaction): Promise<Answer> => {
        const profiles = await storedProfiles(transaction);
        const raced = tierConflict(profiles, name, profile);
        if (raced) return raced.refusal;
        await transaction.config.orchestrator.patch({ sizingProfiles: { ...profiles, [name]: profile } });
        return { status: 200, body: { name, profile, operationId: claim.auditId } };
      }),
    });
  }

  routes.get("/", async (_req, res, next) => {
    try {
      const profiles = await storedProfiles(store);
      res.json({ sizingProfiles: Object.keys(profiles).sort().map((name) => ({ name, profile: profiles[name] })) });
    } catch (error) {
      next(error);
    }
  });

  routes.get("/:name", async (req, res, next) => {
    try {
      const name = req.params.name as string;
      const profile = own(await storedProfiles(store), name);
      if (profile === null) {
        const { status, body } = unknownProfile(name).refusal;
        res.status(status).json(body);
        return;
      }
      res.json({ name, profile });
    } catch (error) {
      next(error);
    }
  });

  routes.put("/:name", async (req, res, next) => {
    try {
      const { status, body } = await setProfile(req, req.params.name as string);
      res.status(status).json(body);
    } catch (error) {
      next(error);
    }
  });

  routes.use(respondToAdminFleetMutationError);
  router.use("/sizing-profiles", routes);
  return router;
}
