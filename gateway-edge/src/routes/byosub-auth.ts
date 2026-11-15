import { authenticationFailureLimit, authenticatedRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import { Router, Request, Response, NextFunction } from "express";

import { requireAuthenticatedUid } from "@octogee/core/http/auth";
import {
  userDefaultAgentId,
  gatewayClaudeSsoClient,
  gatewayDeviceAuthClient,
  brokerByosubFlow,
} from "@octogee/core/model-credentials/byosub";
import {
  readByosubFlow,
  resolveByosubUserGateway,
  type ByosubFlowRecord,
} from "../lib/byosub-broker.js";
import {
  MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS,
  modelCredentialOAuthEntryByProviderId,
  modelCredentialOAuthEntryBySubscriptionProvider,
  type ModelCredentialOAuthCatalogEntry,
  type ModelCredentialOAuthProviderId,
  type ModelCredentialSubscriptionProviderId,
} from "@octogee/shared/types/model-credentials";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

function subscriptionProviderIds(): ModelCredentialSubscriptionProviderId[] {
  return [...MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS];
}

function oauthEntryFromFlow(flow: ByosubFlowRecord): ModelCredentialOAuthCatalogEntry | null {
  if (flow.modelCredentialProvider) {
    try {
      return modelCredentialOAuthEntryByProviderId(
        flow.modelCredentialProvider as ModelCredentialOAuthProviderId,
      );
    } catch {
      return null;
    }
  }
  return modelCredentialOAuthEntryBySubscriptionProvider(flow.provider);
}

function localGatewayId(): string | null {
  return process.env.GATEWAY_ID?.trim() || null;
}

function flowIsMountedHere(flow: ByosubFlowRecord): boolean {
  const local = localGatewayId();
  return !!local && flow.gatewayId === local;
}

function hasPrivateSubscriptionRuntime(): boolean {
  return isIsolatedGatewayClassValue(process.env.GATEWAY_CLASS?.trim());
}

interface SsoSubmission { flowId: string; code: string }

function validateSsoSubmission(req: Request, res: Response<unknown, { submission: SsoSubmission }>, next: NextFunction): void {
  const { flowId, code } = (req.body ?? {}) as { flowId?: unknown; code?: unknown };
  if (typeof flowId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(flowId) || typeof code !== "string" || !code) {
    res.status(400).json({ error: "flowId and code required" });
    return;
  }
  res.locals.submission = { flowId, code };
  next();
}

export function createByosubAuthRouter(): Router {
  const router = Router({ mergeParams: true });

  router.post(
    "/connect",
    authenticationFailureLimit,
    requireAuthenticatedUid,
    authenticatedRequestLimit(12),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.uid!;
        const provider = String((req.body || {}).provider ?? "openai");
        const entry = modelCredentialOAuthEntryBySubscriptionProvider(provider);
        if (!entry) {
          res.status(400).json({
            error: `Unsupported provider: ${provider}`,
            supported: subscriptionProviderIds(),
          });
          return;
        }
        const resolved = await resolveByosubUserGateway(uid);
        if (!resolved) {
          res.status(400).json({ error: "No provisioned workspace/gateway for this user" });
          return;
        }
        const local = localGatewayId();
        if (!local || resolved.gatewayId !== local) {
          res.status(409).json({ error: "not_on_this_pod" });
          return;
        }
        if (!hasPrivateSubscriptionRuntime()) {
          res.status(409).json({
            code: "subscription-runtime-required",
            error: "A private isolated runtime is required before connecting a personal subscription",
          });
          return;
        }
        const agentId = userDefaultAgentId(resolved.slug);
        try {
          const out =
            entry.oauth.gatewayFlow === "claude-sso"
              ? await gatewayClaudeSsoClient().start({ gatewayId: resolved.gatewayId, agentId })
              : await gatewayDeviceAuthClient().start({ gatewayId: resolved.gatewayId, agentId });
          await brokerByosubFlow({
            flowId: out.flowId,
            agentId,
            provider: entry.oauth.subscriptionProvider,
          });
          res.json(out);
        } catch (e) {
          res.status(503).json({
            error: `Gateway auth flow unavailable: ${(e as Error).message}`,
          });
        }
      } catch (e) {
        next(e);
      }
    },
  );

  router.get(
    "/status/:flowId",
    authenticationFailureLimit,
    requireAuthenticatedUid,
    authenticatedRequestLimit(120),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const flowId = req.params.flowId as string;
        const flow = await readByosubFlow(flowId);
        if (!flow || flow.uid !== req.uid!) {
          res.status(404).json({ error: "flow not found" });
          return;
        }
        if (!flowIsMountedHere(flow)) {
          res.status(409).json({ error: "not_on_this_pod" });
          return;
        }
        const entry = oauthEntryFromFlow(flow);
        if (!entry) {
          res.status(400).json({ error: `Unsupported provider: ${flow.provider}` });
          return;
        }
        try {
          const out =
            entry.oauth.gatewayFlow === "claude-sso"
              ? await gatewayClaudeSsoClient().status({ gatewayId: flow.gatewayId, flowId })
              : await gatewayDeviceAuthClient().status({ gatewayId: flow.gatewayId, flowId });
          res.json(out);
        } catch (e) {
          res.status(503).json({ error: `Gateway status unavailable: ${(e as Error).message}` });
        }
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/sso/submit",
    authenticationFailureLimit,
    requireAuthenticatedUid,
    authenticatedRequestLimit(12),
    validateSsoSubmission,
    async (req: Request, res: Response<unknown, { submission: SsoSubmission }>, next: NextFunction) => {
      try {
        const { flowId, code } = res.locals.submission;
        const flow = await readByosubFlow(flowId);
        if (!flow || flow.uid !== req.uid!) {
          res.status(404).json({ error: "flow not found" });
          return;
        }
        if (!flowIsMountedHere(flow)) {
          res.status(409).json({ error: "not_on_this_pod" });
          return;
        }
        const entry = oauthEntryFromFlow(flow);
        if (entry?.oauth.gatewayFlow !== "claude-sso") {
          res.status(400).json({ error: "flow is not an Anthropic SSO flow" });
          return;
        }
        try {
          res.json(
            await gatewayClaudeSsoClient().submit({
              gatewayId: flow.gatewayId,
              flowId,
              code,
            }),
          );
        } catch (e) {
          res.status(503).json({ error: `Gateway Claude SSO unavailable: ${(e as Error).message}` });
        }
      } catch (e) {
        next(e);
      }
    },
  );

  return router;
}
