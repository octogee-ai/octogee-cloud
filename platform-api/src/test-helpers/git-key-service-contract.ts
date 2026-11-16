import { createGiteaGitHost, type GiteaGitHost } from "@octogee/core/git-host";
import { gatewayKeyTitle, isManagedGatewayKeyTitle, publicKeyIdentity } from "@octogee/core/gitea-naming";
import { ProvisioningServiceError } from "@octogee/core/provisioning-service-client";
import type { GitKey, ProvisioningConditionReason, UserProvisioning } from "@octogee/shared/types/provisioning-service";
import type { LegacyProvisioningClient } from "../lib/legacy-provisioning.js";

export interface HostKey {
  id: number;
  title: string;
  key: string;
}

export interface FakeGitHost {
  host: GiteaGitHost;
  held: () => HostKey[];
  titled: (holder: string) => string[];
  deleteTitled: (holder: string, publicKey: string) => void;
}

export function fakeGitHost(slug: string): FakeGitHost {
  const keys: HostKey[] = [];
  let nextId = 1;
  const account = `ws-${slug}`;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, "");
    const method = init?.method ?? "GET";
    if (method === "POST" && path === "/admin/users") return Response.json({ message: "user already exists" }, { status: 422 });
    if (method === "GET" && path === `/users/${account}/keys`) return Response.json(keys);
    if (method === "POST" && path === `/admin/users/${account}/keys`) {
      const body = JSON.parse(String(init?.body)) as { title: string; key: string };
      if (keys.some((existing) => publicKeyIdentity(existing.key) === publicKeyIdentity(body.key))) {
        return Response.json({ message: "Key content has been used as non-deploy key" }, { status: 422 });
      }
      keys.push({ id: nextId++, ...body });
      return Response.json(keys.at(-1), { status: 201 });
    }
    const keyPath = `/admin/users/${account}/keys/`;
    if (method === "DELETE" && path.startsWith(keyPath) && /^\d+$/.test(path.slice(keyPath.length))) {
      const index = keys.findIndex((key) => key.id === Number(path.slice(keyPath.length)));
      if (index < 0) return new Response(null, { status: 404 });
      keys.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected git host request ${method} ${path}`);
  };
  return {
    host: createGiteaGitHost({ apiBaseUrl: "https://gitea.invalid/api/v1", token: () => "token", fetch }),
    held: () => keys.map((key) => ({ ...key })),
    titled: (holder) => keys.filter((key) => key.title === gatewayKeyTitle(holder)).map((key) => key.key),
    deleteTitled(holder, publicKey) {
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        if (keys[index].title === gatewayKeyTitle(holder) && publicKeyIdentity(keys[index].key) === publicKeyIdentity(publicKey)) keys.splice(index, 1);
      }
    },
  };
}

interface Row {
  key: GitKey;
  registeredPublicKey: string | null;
  backingOff: boolean;
}

export interface GitKeyServiceContract {
  client: LegacyProvisioningClient;
  attempt: () => Promise<void>;
  releaseHolder: (holder: string) => void;
  park: (reason: ProvisioningConditionReason) => void;
  failNextRegistration: (message: string) => void;
  attempts: () => number;
  puts: string[];
  row: (holder: string) => GitKey | null;
  rows: () => Array<{ holder: string; publicKey: string }>;
}

const NOW = "2026-11-16T10:00:00Z";

function condition(status: "True" | "False", reason: ProvisioningConditionReason, message: string, generation: number): GitKey["status"]["conditions"][number] {
  return { type: "Registered", status, reason, message, lastTransitionTime: NOW, observedGeneration: generation };
}

export function gitKeyServiceContract(user: { uid: string; slug: string }, git: FakeGitHost): GitKeyServiceContract {
  const rows = new Map<string, Row>();
  const puts: string[] = [];
  let version = 0;
  let parked: ProvisioningConditionReason | null = null;
  let registrationFailure: string | null = null;
  let attempts = 0;
  const sameKey = (left: string, right: string) => publicKeyIdentity(left) === publicKeyIdentity(right);
  const copy = (key: GitKey): GitKey => structuredClone(key);

  function resource(): UserProvisioning {
    return {
      uid: user.uid,
      generation: 1,
      resourceVersion: String(version),
      spec: {
        slug: user.slug,
        displayName: { first: user.slug, last: "" },
        email: `${user.slug}@example.test`,
        avatarUrl: null,
        chat: { teamDisplayName: user.slug, defaultAgent: { enabled: true } },
        git: { repositories: ["workspace", "project-coaches"], systemConfigRepository: true },
        agentIds: [],
      },
      status: {
        observedGeneration: 1,
        conditions: parked === null
          ? [{ type: "GitReady", status: "True", reason: "Converged", message: "", lastTransitionTime: NOW, observedGeneration: 1 }]
          : [{ type: "Ready", status: "False", reason: parked, message: "", lastTransitionTime: NOW, observedGeneration: 1 }],
        outputs: { credentials: [] },
        work: { state: parked === null ? "idle" : "parked", attempts: 1, nextAttemptAt: null, lastAttemptAt: null },
      },
    };
  }

  function staleKeys(row: Row): string[] {
    const released = row.key.deletionRequestedAt !== null;
    const candidates = [row.registeredPublicKey, released ? row.key.spec.publicKey : null].filter((value): value is string => value !== null);
    const unique = [...new Set(candidates)];
    return released ? unique : unique.filter((value) => !sameKey(value, row.key.spec.publicKey));
  }

  async function reconcile(holder: string, row: Row): Promise<void> {
    const { key } = row;
    const sequence = key.putSequence;
    const managed = () => git.held().filter((existing) => isManagedGatewayKeyTitle(existing.title));
    const has = (publicKey: string) => managed().some((existing) => sameKey(existing.key, publicKey) && existing.title === gatewayKeyTitle(holder));
    for (const stale of staleKeys(row).filter(has)) git.deleteTitled(holder, stale);
    if (key.deletionRequestedAt !== null) {
      rows.delete(holder);
      return;
    }
    const registered = () => {
      key.status = { ...key.status, observedGeneration: key.generation, observedPutSequence: Math.max(key.status.observedPutSequence, sequence), nextAttemptAt: null,
        conditions: [condition("True", "Converged", "", key.generation)] };
      row.registeredPublicKey = key.spec.publicKey;
      row.backingOff = false;
    };
    if (has(key.spec.publicKey)) return registered();
    if (row.backingOff) return;
    const putPending = key.putSequence > key.status.observedPutSequence;
    const notRegistered = (reason: ProvisioningConditionReason, message: string) => {
      key.status = { ...key.status, observedGeneration: key.generation, conditions: [condition("False", reason, message, key.generation)] };
    };
    const refused = (reason: ProvisioningConditionReason, message: string) => {
      key.status = { ...key.status, observedGeneration: key.generation, observedPutSequence: Math.max(key.status.observedPutSequence, sequence),
        nextAttemptAt: new Date(Date.parse(NOW) + 120_000).toISOString(),
        conditions: [condition("False", reason, message, key.generation)] };
      row.backingOff = true;
    };
    const elsewhere = managed().some((existing) => sameKey(existing.key, key.spec.publicKey) && existing.title !== gatewayKeyTitle(holder));
    if (elsewhere && !putPending) return refused("GitKeyHeldElsewhere", "the key is held under another managed title; it is taken only while its gateway puts it");
    if (!putPending) {
      return managed().some((existing) => existing.title === gatewayKeyTitle(holder))
        ? refused("GitKeyReplacedOnHost", "the git host holds a different key under this holder's title; the service writes the key only when its gateway puts it")
        : refused("GitKeyNotOnHost", "the git host holds no key under this holder's title; the service writes the key only when its gateway puts it");
    }
    if (registrationFailure !== null) {
      const failure = registrationFailure;
      registrationFailure = null;
      return notRegistered("GitKeyFailed", failure);
    }
    await git.host.registerKey(user.slug, key.spec.publicKey, holder);
    registered();
  }

  const client: LegacyProvisioningClient = {
    getProvisioning: async () => resource(),
    getCredential: async () => null,
    async putGitKey(uid, holder, spec) {
      if (uid !== user.uid) throw new ProvisioningServiceError(404, "not-found", "no provisioning for this user");
      puts.push(holder);
      version += 1;
      const current = rows.get(holder);
      if (current && current.key.spec.publicKey === spec.publicKey && current.key.deletionRequestedAt === null) {
        current.key = { ...current.key, putSequence: current.key.putSequence + 1, resourceVersion: String(version) };
        current.backingOff = false;
        return { outcome: "unchanged", key: copy(current.key) };
      }
      const key: GitKey = {
        uid,
        gatewayId: holder.slice(0, holder.indexOf("/")),
        holder,
        generation: (current?.key.generation ?? 0) + 1,
        putSequence: (current?.key.putSequence ?? 0) + 1,
        resourceVersion: String(version),
        deletionRequestedAt: null,
        spec: { publicKey: spec.publicKey },
        status: current?.key.status ?? { observedGeneration: 0, observedPutSequence: 0, conditions: [], nextAttemptAt: null },
      };
      rows.set(holder, { key, registeredPublicKey: current?.registeredPublicKey ?? null, backingOff: false });
      return { outcome: current ? "changed" : "created", key: copy(key) };
    },
    async getGitKey(_uid, holder) {
      const row = rows.get(holder);
      return row ? copy(row.key) : null;
    },
    async deleteGitKey(_uid, holder, { expectedPublicKey }) {
      const row = rows.get(holder);
      if (!row || row.key.deletionRequestedAt !== null) return "deleted";
      if (!sameKey(row.key.spec.publicKey, expectedPublicKey)) return "superseded";
      row.key = { ...row.key, deletionRequestedAt: NOW };
      return "deleted";
    },
  };

  return {
    client,
    puts,
    async attempt() {
      attempts += 1;
      for (const [holder, row] of [...rows]) {
        if (parked !== null && row.key.deletionRequestedAt === null) continue;
        await reconcile(holder, row);
      }
    },
    releaseHolder(holder) {
      const row = rows.get(holder);
      if (row && row.key.deletionRequestedAt === null) row.key = { ...row.key, deletionRequestedAt: NOW };
    },
    park(reason) {
      parked = reason;
    },
    failNextRegistration(message) {
      registrationFailure = message;
    },
    attempts: () => attempts,
    row: (holder) => {
      const row = rows.get(holder);
      return row ? copy(row.key) : null;
    },
    rows: () => [...rows.entries()].map(([holder, row]) => ({ holder, publicKey: row.key.spec.publicKey })).sort((left, right) => left.holder.localeCompare(right.holder)),
  };
}
