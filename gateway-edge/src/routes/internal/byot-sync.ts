import { clientRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import { Router, Request, Response, NextFunction } from "express";
import { applyConfigPatch } from "@octogee/core/apply-config-patch";
import {
  refreshModelCredentialRuntimeSessions,
  syncModelCredentialsForUser,
} from "@octogee/core/model-credential-sync-runtime";
import { acquireSystemConfigMutationLease } from "@octogee/core/system-config-mutation-lease";
import { requireByotSyncInternalAuth } from "../../middleware/byot-sync-auth.js";

const router: Router = Router();

export function createLeasedModelConfigWriter(
  deps: {
    acquireLease?: typeof acquireSystemConfigMutationLease;
    applyPatch?: typeof applyConfigPatch;
    openclawDir?: () => string;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): typeof applyConfigPatch {
  const acquireLease = deps.acquireLease ?? acquireSystemConfigMutationLease;
  const applyPatch = deps.applyPatch ?? applyConfigPatch;
  const openclawDir = deps.openclawDir ?? (() => process.env.OPENCLAW_DIR ?? "/home/node/.openclaw");
  const wait = deps.wait ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  return async (args, options) => {
    let acquired = await acquireLease({ openclawDir: openclawDir() });
    for (const delayMs of [250, 750]) {
      if (acquired.ok || acquired.code !== "writer-lock-busy") break;
      await wait(delayMs);
      acquired = await acquireLease({ openclawDir: openclawDir() });
    }
    if (!acquired.ok) {
      throw new Error("system config writer lock is busy");
    }
    try {
      return await applyPatch(args, options);
    } finally {
      await acquired.lease.release();
    }
  };
}

const modelConfigWriter = createLeasedModelConfigWriter();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidPayload(value: unknown): value is Parameters<typeof syncModelCredentialsForUser>[0] {
  if (!isRecord(value)) return false;
  if (typeof value.username !== "string" || value.username.trim().length === 0) return false;
  if (!isRecord(value.planInputs)) return false;
  const provisioning = value.provisioning;
  if (!isRecord(provisioning)) return false;
  const openclaw = provisioning.openclaw;
  if (!isRecord(openclaw)) return false;
  return typeof openclaw.status === "string" && openclaw.status.length > 0;
}

router.post(
  ["/model-credential-sync", "/byot-sync"],
  clientRequestLimit(1200, true),
  requireByotSyncInternalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isValidPayload(req.body)) {
        res.status(400).json({ error: "username, planInputs and provisioning.openclaw.status required" });
        return;
      }
      await syncModelCredentialsForUser(req.body, {
        applyConfigPatch: modelConfigWriter,
        refreshDefaultAgentRuntimeSessions: refreshModelCredentialRuntimeSessions,
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
