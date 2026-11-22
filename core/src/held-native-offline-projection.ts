import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import { isValidProjectId, isValidUsername } from "@octogee/shared/types/identity";
import { gatewayScopedJobId, signFleetRequest, verifyFleetRequest } from "./fleet-signature.js";

export interface HeldNativeProjectionScope {
  uid: string;
  slug: string;
  gatewayId: string;
  operationId: string;
  requestId: string;
  holdGeneration: string;
}
interface CredentialCheck {
  accountId: string;
  sha256: string;
}
interface Desired {
  version: 1;
  scope: HeldNativeProjectionScope;
  snapshot: FleetBrokerUserSnapshot;
  credentials: CredentialCheck[];
}
const sha256 = /^[a-f0-9]{64}$/;

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function purpose(scope: HeldNativeProjectionScope) {
  return gatewayScopedJobId(`held-native-offline-desired/${scope.operationId}/${scope.requestId}`, scope.gatewayId);
}

function eligibleScope(scope: HeldNativeProjectionScope, snapshot: FleetBrokerUserSnapshot) {
  return [
    scope.uid === snapshot.uid, isValidUsername(scope.slug), scope.slug === snapshot.slug, scope.gatewayId === snapshot.gatewayId,
    Boolean(scope.operationId), sha256.test(scope.requestId), sha256.test(scope.holdGeneration),
    snapshot.status === "complete", snapshot.runtimeMutationFenced === true,
    snapshot.runtimeReset === undefined, snapshot.restoreAuthority === undefined,
  ].every(Boolean);
}

function safeByotBase(snapshot: FleetBrokerUserSnapshot) {
  const baseUrl = snapshot.systemConfig?.byot?.baseUrl;
  if (!baseUrl) return;
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Held Native broker projection has an unsafe model endpoint");
  }
}

function projectRestoreFields(snapshot: FleetBrokerUserSnapshot): FleetBrokerUserSnapshot["projects"] {
  return snapshot.projects.map(({ projectSlug, giteaRepoName, repoSource, provisioningState, checkoutEnabled, recipe }) => {
    if (!repoSource) return { projectSlug, giteaRepoName, repoSource, provisioningState, checkoutEnabled, recipe };
    const { provider, owner, repo, workingCopy } = repoSource;
    const checkout = workingCopy && {
      id: workingCopy.id, repositoryId: workingCopy.repositoryId, baseBranch: workingCopy.baseBranch,
      baseCommit: workingCopy.baseCommit, ready: workingCopy.ready,
    };
    return { projectSlug, giteaRepoName, repoSource: { provider, owner, repo, workingCopy: checkout },
      provisioningState, checkoutEnabled, recipe };
  });
}

function redactAccountSecrets(snapshot: FleetBrokerUserSnapshot) {
  const { coachToken, projectAgents } = snapshot;
  if (!coachToken) throw new Error("Held Native broker projection has no enrolled coach credential");
  const credentials = [{ accountId: `${snapshot.slug}-coach`, sha256: digest(coachToken) }];
  const projects = projectAgents?.map(agent => {
    const { token, projectId } = agent;
    if (!isValidProjectId(projectId)) throw new Error("Held Native broker projection has an invalid project account");
    if (token) credentials.push({ accountId: `${snapshot.slug}-proj-${projectId}`, sha256: digest(token) });
    const { enabled, mmUserId, githubBacked, identity, deliveryPending, activationId, status } = agent;
    return { projectId, enabled, mmUserId, githubBacked, identity, deliveryPending, activationId, status, token: null };
  });
  if (new Set(credentials.map(c => c.accountId)).size !== credentials.length) {
    throw new Error("Held Native broker projection duplicates an owner credential");
  }
  const redacted: FleetBrokerUserSnapshot = {
    uid: snapshot.uid, slug: snapshot.slug, gatewayId: snapshot.gatewayId, status: snapshot.status,
    agentIds: snapshot.agentIds, runtimeMutationFenced: true,
    contextTemplateKey: snapshot.contextTemplateKey, planInputs: snapshot.planInputs,
    mattermostUserId: snapshot.mattermostUserId, customerMmUserId: snapshot.customerMmUserId,
    coachMmUserId: snapshot.coachMmUserId, coachIdentity: snapshot.coachIdentity, coachToken: null,
    channels: snapshot.channels, projectCheckoutScope: snapshot.projectCheckoutScope,
    projects: projectRestoreFields(snapshot), ...(projects ? { projectAgents: projects } : {}),
    freeTierModelRef: snapshot.freeTierModelRef, builderAgentDefault: snapshot.builderAgentDefault,
    byotActive: snapshot.byotActive, systemConfig: snapshot.systemConfig, timeZone: snapshot.timeZone,
    ownerName: "", email: "", displayName: "", lastName: "", photoURL: "", repoUrl: "", persona: null,
  };
  return { redacted, credentials };
}

export function signHeldNativeOfflineDesiredProjection(input: {
  scope: HeldNativeProjectionScope; snapshot: FleetBrokerUserSnapshot; fleetPrivateKey: string;
}) {
  const { scope, snapshot, fleetPrivateKey } = input;
  if (!eligibleScope(scope, snapshot)) throw new Error("Held Native projection cannot read an unfenced or foreign owner");
  safeByotBase(snapshot);
  const { redacted, credentials } = redactAccountSecrets(snapshot);
  const desired: Desired = { version: 1, scope, snapshot: redacted, credentials };
  const raw = JSON.stringify(desired);
  if (Buffer.byteLength(raw) > 128 * 1024) throw new Error("Held Native broker projection is too large");
  return { raw, signature: signFleetRequest(fleetPrivateKey, purpose(scope), raw), sha256: digest(raw) };
}

function enrolledAccounts(snapshot: FleetBrokerUserSnapshot): Set<string> {
  const ids = [`${snapshot.slug}-coach`, ...(snapshot.projectAgents ?? []).map(agent => `${snapshot.slug}-proj-${agent.projectId}`)];
  return new Set(ids);
}

async function localCredentials(desired: Desired, localRead: (accountId: string) => Promise<string | null>) {
  const allowed = enrolledAccounts(desired.snapshot);
  const credentials = new Map<string, string>();
  for (const { accountId, sha256: expectedHash } of desired.credentials) {
    if (!allowed.has(accountId) || credentials.has(accountId) || !sha256.test(expectedHash)) {
      throw new Error("Held Native desired projection references an unauthorized credential");
    }
    const token = await localRead(accountId);
    if (!token || digest(token) !== expectedHash) {
      throw new Error("Held Native restored credential does not match its broker projection");
    }
    credentials.set(accountId, token);
  }
  return credentials;
}

type ProjectionRead = {
  raw: string; signature: string; expectedSha256: string; scope: HeldNativeProjectionScope; fleetPublicKey: string;
  readRestoredCredential(accountId: string): Promise<string | null>;
};

function readSignedDesired({
  raw, signature, expectedSha256, scope, fleetPublicKey,
}: Omit<ProjectionRead, "readRestoredCredential">): Desired {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 128 * 1024 || digest(raw) !== expectedSha256 ||
      !verifyFleetRequest(fleetPublicKey, purpose(scope), raw, signature)) {
    throw new Error("Held Native desired projection does not match the signed maintenance request");
  }
  const desired = JSON.parse(raw) as Desired;
  const snapshot = desired?.snapshot;
  if (desired?.version !== 1 || !snapshot || !isDeepStrictEqual(desired.scope, scope) ||
      !eligibleScope(scope, snapshot) || snapshot.coachToken !== null ||
      snapshot.projectAgents?.some(agent => agent.token !== null) || !Array.isArray(desired.credentials)) {
    throw new Error("Held Native desired projection is not a credential-free fenced snapshot");
  }
  safeByotBase(snapshot);
  return desired;
}

export async function readHeldNativeOfflineDesiredProjection(input: ProjectionRead): Promise<FleetBrokerUserSnapshot> {
  const desired = readSignedDesired(input);
  const { snapshot } = desired;
  const credentials = await localCredentials(desired, input.readRestoredCredential);
  const coachToken = credentials.get(`${snapshot.slug}-coach`);
  if (!coachToken) throw new Error("Held Native restored coach credential is unavailable");
  const projectAgents = snapshot.projectAgents?.map(agent => ({
    ...agent, token: credentials.get(`${snapshot.slug}-proj-${agent.projectId}`) ?? null,
  }));
  return { ...snapshot, coachToken, ...(projectAgents ? { projectAgents } : {}) };
}
