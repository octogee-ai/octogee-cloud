import { authenticatedRequestLimit, authenticationFailureLimit } from "../middleware/authenticated-request-limit.js";
import { Router, Request, Response, NextFunction } from "express";
import { FieldPath } from "firebase-admin/firestore";
import { requireActiveAccount, requireAuthenticatedUid } from "../middleware/auth.js";
import { db, FieldValue } from "../lib/db.js";
import { platformStateStore } from "../lib/platform-state.js";
import { logger } from "../middleware/logging.js";
import { triggerGatewayModelCredentialSync } from "../lib/byot-sync-trigger.js";
import { readGatewayAuthorizationInStore } from "@octogee/core/gateway-live-release";
import { byotSnapshotProjectionFromSystemConfig } from "@octogee/core/user-snapshot-mapping";
import {
  agentIdBelongsToSlug,
  parseAgentModelSelection,
  parseAgentModelSelections,
  platformModelRefs,
  type AgentModelSelection,
  type AgentModelSelections,
} from "@octogee/shared/types/agent-models";
import { resolveUserByosubCredentialRefs } from "@octogee/shared/types/model-credentials";
import { agentModelCatalog } from "../lib/agent-model-catalog.js";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import {
  userAgentModelDefaultFromDoc,
  type UserAgentModelDefault,
} from "@octogee/shared/types/platform-config";

const router = Router();

function agentIdParam(req: Request): string {
  const value = req.params.agentId;
  return typeof value === "string" ? value : "";
}

function slugFromRequest(req: Request): string | null {
  const user = req.user as { username?: unknown; defaultWorkspaceId?: unknown } | undefined;
  const slug = user?.username ?? user?.defaultWorkspaceId;
  return typeof slug === "string" && slug.length > 0 ? slug : null;
}

function gatewayIdFromRequest(req: Request): string | null {
  const gatewayId = (req.user as { provisioning?: { openclaw?: { gatewayId?: unknown } } } | undefined)
    ?.provisioning?.openclaw?.gatewayId;
  return typeof gatewayId === "string" && gatewayId.length > 0 ? gatewayId : null;
}

async function readSystemConfig(uid: string): Promise<Record<string, unknown>> {
  const snap = await db.doc(`users/${uid}/system/config`).get();
  return snap.data() ?? {};
}

// The operator's user Agent default dial — what an agent with no explicit
// pick runs, so the picker can show the effective selection instead of an
// empty "Choose a model…". An unreadable doc serves the compiled default.
async function platformAgentModelDefault(
  logWarn: (msg: string) => void,
): Promise<UserAgentModelDefault> {
  try {
    return userAgentModelDefaultFromDoc((await platformStateStore.config.platform.get("models"))?.value);
  } catch (err) {
    logWarn(
      `[agent-models] platform default dial read failed — serving the compiled default: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return userAgentModelDefaultFromDoc(undefined);
  }
}

async function readSubscriptionProviders(uid: string) {
  const integration = await db.doc(`users/${uid}/integrations/byosub`).get();
  const { refs, skipped } = resolveUserByosubCredentialRefs(uid, integration.data());
  if (skipped.length > 0) logger.warn(`[agent-models] ${uid}: ${skipped.join("; ")}`);
  return refs.map((ref) => ref.provider);
}

async function isIsolatedRuntime(req: Request): Promise<boolean> {
  const gatewayId = gatewayIdFromRequest(req);
  if (!gatewayId) return false;
  const authorization = await readGatewayAuthorizationInStore(platformStateStore, gatewayId);
  return authorization?.kind === "durable" && authorization.config.gatewayClass === "isolated";
}

// The picker's live-flip path: persist the pick, then push the FULL selection
// map (plus the credential projection) to the gateway so byot-sync re-asserts
// every agent — the same payload shape the boot re-assert derives from the
// mount snapshot.
function triggerAgentModelSync(args: {
  req: Request;
  uid: string;
  slug: string;
  sysData: Record<string, unknown>;
  agentModels: AgentModelSelections;
}): void {
  const gatewayId = gatewayIdFromRequest(args.req);
  if (!gatewayId) {
    logger.warn(`[agent-models] sync trigger skipped for ${args.slug}: missing gatewayId`);
    return;
  }
  const projection = byotSnapshotProjectionFromSystemConfig({
    ...args.sysData,
    agentModels: args.agentModels,
  });
  const user = (args.req.user ?? {}) as Record<string, unknown>;
  triggerGatewayModelCredentialSync({
    gatewayId,
    userData: {
      byotActive: projection.byotActive ?? user.byotActive === true,
      username: args.slug,
      provisioning: { openclaw: { status: "complete" } },
      ...userEntitlements().previousImageFields("model-pick-push", user),
      planInputs: userEntitlements().pickInputs(user),
      systemConfig: projection.systemConfig,
    },
  });
}

router.get("/", authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(120), requireActiveAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const [sysData, platformDefault, subscriptionProviders] = await Promise.all([
      readSystemConfig(uid),
      platformAgentModelDefault((m) => logger.warn(m)),
      readSubscriptionProviders(uid),
    ]);
    const policy = userEntitlements().policy(req.user ?? {});
    const slug = slugFromRequest(req);
    res.json({
      ...userEntitlements().productProjection?.agentModels(req.user ?? {}),
      modelAccess: policy.modelAccess,
      builderTools: policy.toolAccess,
      ...(slug ? { coachAgentId: `octogee-${slug}-coach` } : {}),
      byosub: subscriptionProviders.length > 0 && await isIsolatedRuntime(req),
      subscriptionProviders,
      catalog: agentModelCatalog(subscriptionProviders),
      selections: parseAgentModelSelections(sysData.agentModels),
      platformDefault,
    });
  } catch (e) { next(e); }
});

type SelectionGate =
  | { ok: true; slug: string; selection: AgentModelSelection | null; sysData: Record<string, unknown> }
  | { ok: false; status: number; error: string };

async function gateSelectionRequest(
  req: Request,
  opts: { requireSelection: boolean },
): Promise<SelectionGate> {
  const uid = req.uid!;
  const slug = slugFromRequest(req);
  if (!slug) return { ok: false, status: 409, error: "No workspace slug on account" };
  const agentId = agentIdParam(req);
  if (!agentIdBelongsToSlug(agentId, slug)) {
    return { ok: false, status: 403, error: `Agent ${agentId} is not yours` };
  }
  const policy = userEntitlements().policy(req.user ?? {});
  if (policy.modelAccess === "house_only") {
    return { ok: false, status: 402, error: "The model picker is available on paid plans" };
  }

  if (!opts.requireSelection) {
    return { ok: true, slug, selection: null, sysData: await readSystemConfig(uid) };
  }

  const selection = parseAgentModelSelection(req.body);
  if (!selection) {
    return { ok: false, status: 400, error: "primary (and optional fallbacks) must be valid model refs" };
  }
  const [sysData, subscriptionProviders] = await Promise.all([readSystemConfig(uid), readSubscriptionProviders(uid)]);
  if (!(subscriptionProviders.length > 0 && await isIsolatedRuntime(req))) {
    const allowed = new Set(platformModelRefs());
    const strangers = [selection.primary, ...selection.fallbacks].filter((ref) => !allowed.has(ref));
    if (strangers.length > 0) {
      return {
        ok: false,
        status: 400,
        error: `Not in the platform catalog: ${strangers.join(", ")}`,
      };
    }
  }
  return { ok: true, slug, selection, sysData };
}

router.put("/:agentId", authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(30), requireActiveAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const agentId = agentIdParam(req);
    const gate = await gateSelectionRequest(req, { requireSelection: true });
    if (!gate.ok) { res.status(gate.status).json({ error: gate.error }); return; }
    const selection = gate.selection!;
    const selections = new Map(Object.entries(parseAgentModelSelections(gate.sysData.agentModels)));
    selections.set(agentId, selection);

    await db
      .doc(`users/${uid}/system/config`)
      .set({ agentModels: Object.fromEntries([[agentId, selection]]) }, { merge: true });

    triggerAgentModelSync({ req, uid, slug: gate.slug, sysData: gate.sysData, agentModels: Object.fromEntries(selections) });
    logger.info(
      `[agent-models] ${gate.slug}: ${agentId} → ${selection.primary}` +
        (selection.fallbacks.length ? ` (fallback ${selection.fallbacks.join(", ")})` : ""),
    );

    res.json({ ok: true, agentId, selection });
  } catch (e) { next(e); }
});

router.delete("/:agentId", authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(30), requireActiveAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const agentId = agentIdParam(req);
    const gate = await gateSelectionRequest(req, { requireSelection: false });
    if (!gate.ok) { res.status(gate.status).json({ error: gate.error }); return; }

    await db
      .doc(`users/${uid}/system/config`)
      .update(new FieldPath("agentModels", agentId), FieldValue.delete());

    const selections = new Map(Object.entries(parseAgentModelSelections(gate.sysData.agentModels)));
    selections.delete(agentId);
    triggerAgentModelSync({ req, uid, slug: gate.slug, sysData: gate.sysData, agentModels: Object.fromEntries(selections) });
    logger.info(
      `[agent-models] ${gate.slug}: ${agentId} pick removed — class default re-asserts on next sync`,
    );

    res.json({ ok: true, agentId });
  } catch (e) { next(e); }
});

export default router;
