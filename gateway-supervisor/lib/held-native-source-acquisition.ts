import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { heldNativeSourceHoldAudience, heldNativeSourceHoldJobId, verifyFleetRequest } from "@octogee/core/fleet-signature";
import {
  isHeldNativeSourceClaim, SIGNATURE_HEADER,
  type HeldNativeSourceBinding, type HeldNativeSourceClaim, type HeldNativeSourceHoldAction,
} from "@octogee/shared/types/fleet-controller";
import type { Request, RequestHandler } from "express";
import { createMetadataClient } from "./vm-gateway-agent/metadata.js";
import { acquireHeldNativeSourceKeeper } from "./held-native-source-keeper.js";
import { assertBrokeredHeldNativeSourceClaim } from "./fleet-broker-client.js";

type Keeper = Awaited<ReturnType<typeof acquireHeldNativeSourceKeeper>>;
type SourceBacking = Pick<HeldNativeSourceClaim, "vmId" | "bootId" | "bootDiskId" | "homeDiskId">;
type StoreIdentity = { storeId: string; databaseIdentity: string };

export interface EstablishedSourceHostHold {
  homeDirectory: string;
  heldSince: number;
  stores: readonly StoreIdentity[];
  readSourceBacking(): Promise<SourceBacking>;
  assertOrdinaryWritersExcluded(): Promise<void>;
  assertOwnerStoreWritesHeld(): Promise<void>;
}

export type InterruptedHeldNativeSource = {
  binding: HeldNativeSourceBinding;
  maintenanceAttempted: boolean;
};

type SourceHoldBackend = {
  acquireHostHold: (binding: HeldNativeSourceBinding) => Promise<EstablishedSourceHostHold>;
  recoverInterruptedHold?: (binding: HeldNativeSourceBinding, prior: InterruptedHeldNativeSource) => Promise<EstablishedSourceHostHold>;
  assertWorkerClaim?: (claim: HeldNativeSourceClaim) => Promise<void>;
  now: () => number;
};

function sourceBacking({ vmId, bootId, bootDiskId, homeDiskId }: HeldNativeSourceClaim): SourceBacking {
  return { vmId, bootId, bootDiskId, homeDiskId };
}

function heldClaim(binding: HeldNativeSourceBinding): HeldNativeSourceClaim {
  const { holdGeneration: _, ...claim } = binding;
  return claim;
}

function sameAcquisitionScope(left: HeldNativeSourceClaim, right: HeldNativeSourceClaim): boolean {
  const { claimStartedAt: _leftClaim, ...leftScope } = left;
  const { claimStartedAt: _rightClaim, ...rightScope } = right;
  return isDeepStrictEqual(leftScope, rightScope);
}

export function createHeldNativeSourceAcquisition(deps: SourceHoldBackend) {
  const assertWorkerClaim = deps.assertWorkerClaim ?? assertBrokeredHeldNativeSourceClaim;
  let acquiring = false;
  let interrupted: InterruptedHeldNativeSource | undefined;
  let live: { claim: HeldNativeSourceClaim; keeper: Keeper; host: EstablishedSourceHostHold; generation: string; stores: StoreIdentity[] } | undefined;

  async function read(claim: HeldNativeSourceClaim) {
    const held = live;
    if (acquiring || !held || !isDeepStrictEqual(held.claim, claim)) throw new Error("Held Native source has no exact acquired claim");
    const { gatewayId: sourceGatewayId, claimStartedAt: _, ...identity } = claim;
    const { vmId, bootId, bootDiskId, homeDiskId, ...scope } = identity;
    await held.keeper.assertHeld();
    if (acquiring || held !== live || !isDeepStrictEqual([...held.host.stores], held.stores)) {
      throw new Error("Held Native source hold or store roster changed");
    }
    return { scope: { ...scope, sourceGatewayId }, generation: held.generation, heldSince: held.host.heldSince,
      source: { vmId, bootId, bootDiskId, homeDiskId }, stores: structuredClone(held.stores) };
  }

  async function reserveReplacement(claim: HeldNativeSourceClaim): Promise<void> {
    const previous = live?.claim ?? (interrupted ? heldClaim(interrupted.binding) : undefined);
    if (!previous) return;
    if (!deps.recoverInterruptedHold || !sameAcquisitionScope(previous, claim) || claim.claimStartedAt <= previous.claimStartedAt) {
      throw new Error("Held Native source recovery has no authorized replacement for its exact claim");
    }
    if (live) {
      const state = await live.keeper.close();
      interrupted = { binding: { ...live.claim, holdGeneration: live.generation }, ...state };
      live = undefined;
    }
  }

  async function acquire(claim: HeldNativeSourceClaim) {
    if (acquiring) throw new Error("Held Native source acquisition is already running");
    if (live && isDeepStrictEqual(live.claim, claim)) return read(claim);
    acquiring = true;
    try {
      await assertWorkerClaim(claim);
      await reserveReplacement(claim);
      const generation = randomBytes(32).toString("hex");
      const binding = { ...claim, holdGeneration: generation };
      const host = interrupted
        ? await deps.recoverInterruptedHold!(binding, interrupted)
        : await deps.acquireHostHold(binding);
      const stores = structuredClone([...host.stores]);
      if (!stores.length || new Set(stores.map(store => store.storeId)).size !== stores.length ||
          stores.some(store => !store.storeId || !store.databaseIdentity) ||
          !Number.isSafeInteger(host.heldSince) || host.heldSince < claim.claimStartedAt || host.heldSince > deps.now() ||
          !isDeepStrictEqual(await host.readSourceBacking(), sourceBacking(claim))) {
        throw new Error("Held Native source host and store authority could not be verified");
      }
      const keeper = await acquireHeldNativeSourceKeeper(binding, {
        homeDirectory: host.homeDirectory,
        readSourceBacking: () => host.readSourceBacking(),
        assertWorkerClaim: () => assertWorkerClaim(claim),
        assertOrdinaryWritersExcluded: () => host.assertOrdinaryWritersExcluded(),
        assertOwnerStoreWritesHeld: () => host.assertOwnerStoreWritesHeld(),
      });
      live = { claim: structuredClone(claim), keeper, host, generation, stores };
      interrupted = undefined;
    } finally {
      acquiring = false;
    }
    return read(claim);
  }

  return { acquire, read, getHeldSourceKeeper: () => acquiring ? undefined : live?.keeper };
}

function parseSignedHoldRequest(input: {
  req: Request;
  action: HeldNativeSourceHoldAction;
  publicKey: string;
  gatewayId: string;
  now: number;
}) {
  const { req, action, publicKey, gatewayId, now } = input;
  const raw = (req as Request & { rawBody?: string }).rawBody ?? "";
  if (raw.length > 8192) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length !== 3) return null;
  const { claim, nonce, expiresAt } = parsed as Record<string, unknown>;
  if (!isHeldNativeSourceClaim(claim) || claim.gatewayId !== gatewayId || req.params.gatewayId !== gatewayId ||
      typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce) ||
      typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < now || expiresAt > now + 90_000 ||
      !verifyFleetRequest(publicKey, heldNativeSourceHoldJobId(action, claim.operationId, gatewayId), raw, req.header(SIGNATURE_HEADER))) return null;
  return { claim, nonce, expiresAt, raw };
}

export function createHeldNativeSourceHoldHandler(deps: {
  action: HeldNativeSourceHoldAction;
  publicKey: string;
  gatewayId: string;
  acquisition: ReturnType<typeof createHeldNativeSourceAcquisition>;
  now?: () => number;
  identityToken?: (audience: string) => Promise<string>;
}): RequestHandler {
  const identityToken = deps.identityToken ?? createMetadataClient().identityToken;
  const now = deps.now ?? Date.now;
  return async (req, res) => {
    let request;
    try {
      request = parseSignedHoldRequest({ ...deps, req, now: now() });
    } catch {
      res.status(400).json({ error: "invalid_held_native_source_hold_request" }); return;
    }
    if (!request) { res.status(403).json({ error: "held_native_source_hold_unauthorized" }); return; }
    try {
      const hold = await deps.acquisition[deps.action](request.claim);
      if (now() > request.expiresAt) throw new Error("Held Native source hold request expired");
      const instanceIdentity = await identityToken(heldNativeSourceHoldAudience(deps.action, request.raw, hold));
      const verified = await deps.acquisition.read(request.claim);
      if (!isDeepStrictEqual(verified, hold) || now() > request.expiresAt) {
        throw new Error("Held Native source changed while attesting its hold");
      }
      res.set("Cache-Control", "no-store").json({ nonce: request.nonce, hold, instanceIdentity });
    } catch {
      res.status(409).json({ error: "held_native_source_hold_unavailable" });
    }
  };
}
