import { Router, type Request, type Response } from "express";

import { isValidProjectId, isValidUsername } from "@octogee/shared/types/identity";
import {
  defaultProjectRecipe,
  isProjectRecipeId,
  PROJECT_RECIPE_IDS,
  type ProjectRecipeId,
} from "@octogee/shared/types/project";
import {
  configuredUserBootstrapAllowed,
} from "@octogee/core/gateway-live-release";
import {
  gatewayKeyOwnerId,
  systemConfigRepoName,
  workspaceRepoName,
} from "@octogee/core/gitea-naming";
import type { PlatformUserRecord } from "@octogee/core/platform-state";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { gitHost } from "../../lib/git-host.js";
import { requireInternalServiceAuth } from "@octogee/core/http/auth";
import { logger } from "@octogee/core/http/logging";
import {
  deleteProjectGiteaRepo,
  ensureProjectGiteaRepo,
  ProjectRepoProvisioningError,
} from "../projects/provisioning.js";
import { respondProvisioningPending, routeBudget, type LegacyGitRepository, type LegacyProvisioning } from "../../lib/legacy-provisioning.js";

// Gitea ADMIN broker for the in-pod provisioner. The provisioner runs in the OpenClaw
// openclaw container and no longer holds the admin token; it calls octogee-api with its
// projected gateway KSA token so the API singleton performs the admin operation. Local git
// (SSH clone/init/push) stays in the provisioner. The legacy gateway-edge mount stays
// fail-closed unless a trusted caller presents a supported internal identity.
//
// Every path-bound input is re-validated HERE because this HTTP boundary is a new entry
// point that bypasses the provisioner's upstream isValidUsername gate. Strict validation blocks
// path traversal / injection into the privileged Gitea paths. The assigned-roster guard below is
// defense-in-depth over octogee-api tenant enforcement: it blocks cross-tenant Gitea key
// replacement / repo mutation before any admin call is attempted.

// Our Gitea repo names are fixed platform repos or project slugs. Keep the
// system_config underscore as an exact-name exception instead of relaxing
// arbitrary repo input.
function isSshPublicKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 8192 &&
    /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp\d+) /.test(value.trim())
  );
}

// Validates the slug at the boundary and 400s on failure; narrows to string on success.
function validSlug(res: Response, slug: unknown): slug is string {
  if (isValidUsername(slug)) return true;
  res.status(400).json({ error: "slug must be a valid workspace username" });
  return false;
}

function validRepoName(value: unknown): value is string {
  return (
    value === workspaceRepoName() ||
    value === systemConfigRepoName() ||
    isValidProjectId(value)
  );
}

// recipe is optional on the wire because octogee-api and the pod sidecar ship
// separately: a sender from before the field still provisions, on the same
// type-derived recipe project create would have stamped.
interface ProjectRepoProvisionRequest {
  workspaceId: string;
  slug: string;
  name: string;
  tagline: string;
  projectType: string | null;
  visibility: "private" | "public" | "unlisted";
  recipe?: ProjectRecipeId;
  githubBacked?: boolean;
}

function validProjectRepoName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

function validProjectRepoTagline(value: unknown): value is string {
  return typeof value === "string" && value.length <= 500;
}

function validProjectRepoType(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 100);
}

function validProjectRepoVisibility(value: unknown): value is ProjectRepoProvisionRequest["visibility"] {
  return value === "private" || value === "public" || value === "unlisted";
}

function validProjectRepoRecipe(value: unknown): value is ProjectRecipeId | undefined {
  return value === undefined || isProjectRecipeId(value);
}

function validProjectRepoProvisionRequest(
  res: Response,
  value: unknown,
): value is ProjectRepoProvisionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    res.status(400).json({ error: "project repo provisioning input is required" });
    return false;
  }
  const input = value as Record<string, unknown>;
  if (!validSlug(res, input.workspaceId)) return false;
  if (!isValidProjectId(input.slug)) {
    res.status(400).json({ error: "slug must be a valid project id" });
    return false;
  }
  if (!validProjectRepoName(input.name)) {
    res.status(400).json({ error: "name must be 1-200 characters" });
    return false;
  }
  if (!validProjectRepoTagline(input.tagline)) {
    res.status(400).json({ error: "tagline must be at most 500 characters" });
    return false;
  }
  if (!validProjectRepoType(input.projectType)) {
    res.status(400).json({ error: "projectType must be null or at most 100 characters" });
    return false;
  }
  if (!validProjectRepoVisibility(input.visibility)) {
    res.status(400).json({ error: "visibility must be private, public, or unlisted" });
    return false;
  }
  if (!validProjectRepoRecipe(input.recipe)) {
    res.status(400).json({ error: `recipe must be one of ${PROJECT_RECIPE_IDS.join(", ")}` });
    return false;
  }
  return true;
}

interface GatewayCaller {
  gatewayId: string;
  podName: string | undefined;
}

function gatewayCallerForRequest(req: Request): GatewayCaller | null {
  const boundTenant = (req as Request & {
    boundTenant?: { kind?: unknown; gatewayId?: unknown; podName?: unknown };
  }).boundTenant;
  if (boundTenant?.kind === "gateway" && typeof boundTenant.gatewayId === "string") {
    const gatewayId = boundTenant.gatewayId.trim();
    if (gatewayId) {
      return {
        gatewayId,
        podName: typeof boundTenant.podName === "string" ? boundTenant.podName : undefined,
      };
    }
  }
  return null;
}

function gatewayKeyOwnerForRequest(req: Request, res: Response): string | null {
  const caller = gatewayCallerForRequest(req);
  if (!caller?.podName) {
    res.status(403).json({ error: "gateway pod identity is required for SSH key ownership" });
    return null;
  }
  return gatewayKeyOwnerId(caller.gatewayId, caller.podName);
}

async function assignedSlugsForGateway(gatewayId: string): Promise<string[]> {
  const users = await platformStateStore.users.records.listByGateway(gatewayId);
  return users.flatMap((user) => (user.slug ? [user.slug] : []));
}

async function inboundMigrationRunning(gatewayId: string, user: PlatformUserRecord): Promise<boolean> {
  const operations = await platformStateStore.journal.operations.listForUid(user.uid, {
    kind: "migrate-user",
    statuses: ["running"],
  });
  return operations.some((operation) => {
    const input = operation.input as { uid?: unknown; toGatewayId?: unknown } | undefined;
    return input?.uid === user.uid && input.toGatewayId === gatewayId;
  });
}

type UserAccess = "serving" | "standby";

async function userAccessForGateway(caller: GatewayCaller, slug: string): Promise<UserAccess | null> {
  const { gatewayId, podName } = caller;
  const assigned = await assignedSlugsForGateway(gatewayId);
  if (assigned.includes(slug)) return "serving";
  const user = await platformStateStore.users.records.findBySlug(slug);
  if (user && (await inboundMigrationRunning(gatewayId, user))) return "serving";
  const gateway = await platformStateStore.gateways.roots.get(gatewayId);
  if (!configuredUserBootstrapAllowed(gateway, { gatewayId, podName, slug })) return null;
  return user?.gateway ? "standby" : "serving";
}

async function requireUserAccess(req: Request, res: Response, slug: string): Promise<UserAccess | null> {
  const caller = gatewayCallerForRequest(req);
  if (!caller) {
    logger.error("internal/gitea assignment guard failed: no gateway identity is configured");
    res.status(500).json({ error: "gateway assignment guard is not configured" });
    return null;
  }

  try {
    const access = await userAccessForGateway(caller, slug);
    if (!access) res.status(403).json({ error: "slug is not assigned to this gateway" });
    return access;
  } catch (err) {
    logger.error("internal/gitea assignment guard lookup failed", { err, gatewayId: caller.gatewayId, slug });
    res.status(502).json({ error: "gateway assignment lookup failed" });
    return null;
  }
}

async function broker(res: Response, op: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    res.status(204).end();
  } catch (err) {
    logger.error(`internal/gitea ${op} failed`, { err });
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function awaitServiceGit(
  res: Response,
  legacyProvisioning: LegacyProvisioning,
  route: string,
  slug: string,
  repository: LegacyGitRepository | null,
): Promise<void> {
  try {
    const user = await platformStateStore.users.records.findBySlug(slug);
    if (!user) {
      logger.error("internal/gitea: no user carries the slug", { slug });
      respondProvisioningPending(res, { route, slug }, { reason: "NotProvisioned", retryAfterSeconds: 5 });
      return;
    }
    const wait = await legacyProvisioning.git(user.uid, repository, routeBudget());
    if (!wait.ready) {
      respondProvisioningPending(res, { route, uid: user.uid }, wait);
      return;
    }
    res.status(204).end();
  } catch (err) {
    logger.error("internal/gitea provisioning service read failed", { err, slug, repository });
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

interface UserGitRoute {
  op: string;
  repository: LegacyGitRepository | null;
  ensure: (slug: string) => Promise<void>;
}

const USER_GIT_ROUTES: readonly UserGitRoute[] = [
  { op: "ensure-org", repository: null, ensure: (slug) => gitHost().ensureOwner(slug) },
  { op: "ensure-workspace-repo", repository: "workspace", ensure: (slug) => gitHost().ensureRepo(slug, { kind: "workspace" }) },
  { op: "ensure-system-config-repo", repository: "system-config", ensure: (slug) => gitHost().ensureRepo(slug, { kind: "system-config" }) },
  { op: "ensure-project-coach-repo", repository: "project-coaches", ensure: (slug) => gitHost().ensureRepo(slug, { kind: "project-coaches" }) },
];

function userGitHandler(route: UserGitRoute, legacyProvisioning: LegacyProvisioning | null) {
  return async (req: Request, res: Response): Promise<void> => {
    const { slug } = (req.body ?? {}) as { slug?: unknown };
    if (!validSlug(res, slug)) return;
    if (!(await requireUserAccess(req, res, slug))) return;
    if (legacyProvisioning) {
      await awaitServiceGit(res, legacyProvisioning, route.op, slug, route.repository);
      return;
    }
    await broker(res, route.op, () => route.ensure(slug));
  };
}

const ENSURE_USER = "ensure-user";

async function awaitServiceGitReady(res: Response, legacyProvisioning: LegacyProvisioning, slug: string): Promise<boolean> {
  try {
    const user = await platformStateStore.users.records.findBySlug(slug);
    if (!user) {
      logger.error("internal/gitea: no user carries the slug", { slug });
      respondProvisioningPending(res, { route: ENSURE_USER, slug }, { reason: "NotProvisioned", retryAfterSeconds: 5 });
      return false;
    }
    const wait = await legacyProvisioning.git(user.uid, null, routeBudget());
    if (!wait.ready) {
      respondProvisioningPending(res, { route: ENSURE_USER, uid: user.uid }, wait);
      return false;
    }
    return true;
  } catch (err) {
    logger.error("internal/gitea ensure-user provisioning service read failed", { err, slug });
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

interface ServiceHeldKey {
  slug: string;
  publicKey: string;
  keyOwner: string;
  access: UserAccess;
}

async function registerServiceHeldKey(
  res: Response,
  legacyProvisioning: LegacyProvisioning,
  { slug, publicKey, keyOwner }: ServiceHeldKey,
): Promise<void> {
  try {
    const user = await platformStateStore.users.records.findBySlug(slug);
    if (!user) {
      logger.error("internal/gitea: no user carries the slug", { slug });
      respondProvisioningPending(res, { route: ENSURE_USER, slug }, { reason: "NotProvisioned", retryAfterSeconds: 5 });
      return;
    }
    const wait = await legacyProvisioning.gitKey(user.uid, keyOwner, publicKey, routeBudget());
    if (!wait.ready) {
      respondProvisioningPending(res, { route: ENSURE_USER, uid: user.uid }, wait);
      return;
    }
    res.status(204).end();
  } catch (err) {
    logger.error("internal/gitea ensure-user through the provisioning service failed", { err, slug, keyOwner });
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function registerOnGitHostInstead(res: Response, { slug, publicKey, keyOwner, access }: ServiceHeldKey): Promise<void> {
  try {
    await (access === "serving"
      ? gitHost().registerKey(slug, publicKey, keyOwner)
      : gitHost().registerKeyUnlessHeld(slug, publicKey, keyOwner));
    res.status(200).json({ registeredOn: "git-host" });
  } catch (err) {
    logger.error("internal/gitea ensure-user failed", { err });
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function ensureServiceHeldKey(
  req: Request,
  res: Response,
  legacyProvisioning: LegacyProvisioning | null,
  { slug, publicKey, serviceHolder, access }: { slug: string; publicKey: string; serviceHolder: string; access: UserAccess },
): Promise<void> {
  const caller = gatewayCallerForRequest(req);
  if (!caller?.podName) {
    logger.error("internal/gitea ensure-user: a key held by the service needs a token that names its pod, and this one binds no pod", { slug, gatewayId: caller?.gatewayId });
    res.status(403).json({ error: "gateway pod identity is required for SSH key ownership" });
    return;
  }
  const keyOwner = gatewayKeyOwnerId(caller.gatewayId, caller.podName);
  const key = { slug, publicKey, keyOwner, access };
  if (legacyProvisioning === null) {
    logger.warn("internal/gitea ensure-user: the provisioning service is not configured, so a key the gateway says the service holds is registered on the git host", { slug, keyOwner });
    await registerOnGitHostInstead(res, key);
    return;
  }
  if (serviceHolder !== keyOwner || access !== "serving") {
    logger.info("internal/gitea ensure-user: the key is registered on the git host, since the gateway's marker names another pod or this pod is on standby", { slug, keyOwner, serviceHolder, access });
    if (!(await awaitServiceGitReady(res, legacyProvisioning, slug))) return;
    await registerOnGitHostInstead(res, key);
    return;
  }
  await registerServiceHeldKey(res, legacyProvisioning, key);
}

function ensureUserHandler(legacyProvisioning: LegacyProvisioning | null) {
  return async (req: Request, res: Response): Promise<void> => {
    const { slug, pubKey, serviceHolder } = (req.body ?? {}) as { slug?: unknown; pubKey?: unknown; serviceHolder?: unknown };
    if (!validSlug(res, slug)) return;
    if (!isSshPublicKey(pubKey)) {
      res.status(400).json({ error: "pubKey must be a valid SSH public key" });
      return;
    }
    const access = await requireUserAccess(req, res, slug);
    if (!access) return;
    if (typeof serviceHolder === "string" && serviceHolder !== "") {
      await ensureServiceHeldKey(req, res, legacyProvisioning, { slug, publicKey: pubKey.trim(), serviceHolder, access });
      return;
    }
    const keyOwner = gatewayKeyOwnerForRequest(req, res);
    if (!keyOwner) return;
    if (legacyProvisioning && !(await awaitServiceGitReady(res, legacyProvisioning, slug))) return;
    await broker(res, ENSURE_USER, () =>
      access === "serving"
        ? gitHost().registerKey(slug, pubKey, keyOwner)
        : gitHost().registerKeyUnlessHeld(slug, pubKey, keyOwner));
  };
}

async function releaseUserKey(req: Request, res: Response): Promise<void> {
  const { slug, pubKey } = (req.body ?? {}) as { slug?: unknown; pubKey?: unknown };
  if (!validSlug(res, slug)) return;
  if (!isSshPublicKey(pubKey)) {
    res.status(400).json({ error: "pubKey must be a valid SSH public key" });
    return;
  }
  const keyOwner = gatewayKeyOwnerForRequest(req, res);
  if (!keyOwner) return;
  await broker(res, "release-user-key", () => gitHost().releaseKey(slug, pubKey, keyOwner));
}

const router: Router = Router();

router.get("/user-pubkey", async (req: Request, res: Response) => {
  const { slug } = req.query;
  if (!validSlug(res, slug)) return;
  if (!(await requireUserAccess(req, res, slug))) return;
  try {
    const pubKey = await gitHost().primaryKey(slug);
    res.json({ pubKey });
  } catch (err) {
    logger.error("internal/gitea user-pubkey failed", { err });
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/user-pubkeys", async (req: Request, res: Response) => {
  const { slug } = req.query;
  if (!validSlug(res, slug)) return;
  if (!(await requireUserAccess(req, res, slug))) return;
  try {
    const pubKeys = await gitHost().listKeys(slug);
    res.json({ pubKeys });
  } catch (err) {
    logger.error("internal/gitea user-pubkeys failed", { err });
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/ensure-project-repo", async (req: Request, res: Response) => {
  const { slug, projectName } = (req.body ?? {}) as { slug?: unknown; projectName?: unknown };
  if (!validSlug(res, slug)) return;
  if (!isValidProjectId(projectName)) {
    res.status(400).json({ error: "projectName must be a valid project id" });
    return;
  }
  if (!(await requireUserAccess(req, res, slug))) return;
  await broker(res, "ensure-project-repo", () => gitHost().ensureRepo(slug, { kind: "project", projectSlug: projectName }));
});

router.post("/provision-project-repo", async (req: Request, res: Response) => {
  const input = req.body;
  if (!validProjectRepoProvisionRequest(res, input)) return;
  if (!(await requireUserAccess(req, res, input.workspaceId))) return;
  try {
    const result = await ensureProjectGiteaRepo({
      workspaceId: input.workspaceId,
      slug: input.slug,
      name: input.name,
      tagline: input.tagline,
      projectType: input.projectType,
      visibility: input.visibility,
      recipe: input.recipe ?? defaultProjectRecipe(input.projectType),
      githubBacked: input.githubBacked === true,
    });
    res.json(result);
  } catch (err) {
    logger.error("internal/gitea provision-project-repo failed", { err });
    res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
      created: err instanceof ProjectRepoProvisioningError && err.created,
    });
  }
});

router.post("/delete-project-repo", async (req: Request, res: Response) => {
  const { workspaceId, slug } = (req.body ?? {}) as { workspaceId?: unknown; slug?: unknown };
  if (!validSlug(res, workspaceId)) return;
  if (!isValidProjectId(slug)) {
    res.status(400).json({ error: "slug must be a valid project id" });
    return;
  }
  if (!(await requireUserAccess(req, res, workspaceId))) return;
  await broker(res, "delete-project-repo", () => deleteProjectGiteaRepo({ workspaceId, slug }));
});

router.get("/repo-exists", async (req: Request, res: Response) => {
  const { org, repo } = req.query;
  if (!isValidUsername(org) || !validRepoName(repo)) {
    res.status(400).json({ error: "org must be a valid workspace username and repo a valid repo name" });
    return;
  }
  if (!(await requireUserAccess(req, res, org))) return;
  try {
    const exists = await gitHost().repoExists({ owner: org, repo });
    res.json({ exists });
  } catch (err) {
    logger.error("internal/gitea repo-exists failed", { err });
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/archive-repo", async (req: Request, res: Response) => {
  const { org, repo } = (req.body ?? {}) as { org?: unknown; repo?: unknown };
  if (!isValidUsername(org) || !validRepoName(repo)) {
    res.status(400).json({ error: "org must be a valid workspace username and repo a valid repo name" });
    return;
  }
  if (!(await requireUserAccess(req, res, org))) return;
  await broker(res, "archive-repo", () => gitHost().archiveRepo({ owner: org, repo }));
});

export interface InternalGiteaAdminRouteDeps {
  legacyProvisioning: LegacyProvisioning | null;
}

export function createInternalGiteaAdminRoutes({ legacyProvisioning }: InternalGiteaAdminRouteDeps): Router {
  const routes: Router = Router();
  routes.use(requireInternalServiceAuth);
  for (const route of USER_GIT_ROUTES) routes.post(`/${route.op}`, userGitHandler(route, legacyProvisioning));
  routes.post(`/${ENSURE_USER}`, ensureUserHandler(legacyProvisioning));
  routes.post("/release-user-key", releaseUserKey);
  routes.use(router);
  return routes;
}
