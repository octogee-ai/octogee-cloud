import {
  GIT_REPOSITORY_ROLES,
  type GitRepositoryRole,
  type GitKeySpec,
  type UserProvisioningSpec,
} from "@octogee/shared/types/provisioning-service";
import { ApiError } from "../http/errors.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EMAIL = /^([^\s@]+@[^\s@]+)?$/;
const PUBLIC_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) [A-Za-z0-9+/=]+( [^\r\n]*)?$/;
const MAX_TEXT = 256;

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid-request", message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string, options: { pattern?: RegExp; allowEmpty?: boolean } = {}): string {
  if (typeof value !== "string" || value.length > MAX_TEXT) throw invalid(`${path} must be a string of at most ${MAX_TEXT} characters`);
  if (!options.allowEmpty && value.length === 0) throw invalid(`${path} must not be empty`);
  if (options.pattern && !options.pattern.test(value)) throw invalid(`${path} is not in the expected form`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${path} must be a boolean`);
  return value;
}

export function validIdentifier(value: string, name: string): string {
  if (!IDENTIFIER.test(value)) throw invalid(`${name} is not a valid identifier`);
  return value;
}

export function parseUserProvisioningSpec(value: unknown): UserProvisioningSpec {
  const spec = object(value, "spec");
  const displayName = object(spec.displayName, "spec.displayName");
  const chat = object(spec.chat, "spec.chat");
  const defaultAgent = object(chat.defaultAgent, "spec.chat.defaultAgent");
  const git = object(spec.git, "spec.git");
  if (!Array.isArray(git.repositories)) throw invalid("spec.git.repositories must be an array");
  const repositories = git.repositories.map((role, index) => {
    if (!GIT_REPOSITORY_ROLES.includes(role as GitRepositoryRole)) throw invalid(`spec.git.repositories[${index}] is not a known role`);
    return role as GitRepositoryRole;
  });
  if (new Set(repositories).size !== repositories.length) throw invalid("spec.git.repositories must not repeat a role");
  if (!Array.isArray(spec.agentIds)) throw invalid("spec.agentIds must be an array");
  const agentIds = spec.agentIds.map((agentId, index) => text(agentId, `spec.agentIds[${index}]`, { pattern: IDENTIFIER }));
  const avatarUrl = spec.avatarUrl === null || spec.avatarUrl === undefined ? null : text(spec.avatarUrl, "spec.avatarUrl");
  if (avatarUrl !== null && !/^https:\/\//.test(avatarUrl)) throw invalid("spec.avatarUrl must be an https URL or null");
  return {
    slug: text(spec.slug, "spec.slug", { pattern: SLUG }),
    displayName: {
      first: text(displayName.first, "spec.displayName.first", { allowEmpty: true }),
      last: text(displayName.last, "spec.displayName.last", { allowEmpty: true }),
    },
    email: text(spec.email, "spec.email", { pattern: EMAIL, allowEmpty: true }),
    avatarUrl,
    chat: {
      teamDisplayName: text(chat.teamDisplayName, "spec.chat.teamDisplayName"),
      defaultAgent: { enabled: bool(defaultAgent.enabled, "spec.chat.defaultAgent.enabled") },
    },
    git: { repositories, systemConfigRepository: bool(git.systemConfigRepository, "spec.git.systemConfigRepository") },
    agentIds,
  };
}

export function parseGitKeySpec(value: unknown): GitKeySpec {
  const spec = object(value, "spec");
  if (typeof spec.publicKey !== "string" || spec.publicKey.length > 16_384 || !PUBLIC_KEY.test(spec.publicKey.trim())) {
    throw invalid("spec.publicKey must be one OpenSSH public key line");
  }
  return { publicKey: spec.publicKey.trim() };
}

export function parseGitKeyRelease(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const body = object(value, "body");
  if (body.expectedPublicKey === undefined) return null;
  if (typeof body.expectedPublicKey !== "string" || body.expectedPublicKey.length > 16_384 || !PUBLIC_KEY.test(body.expectedPublicKey.trim())) {
    throw invalid("expectedPublicKey must be one OpenSSH public key line");
  }
  return body.expectedPublicKey.trim();
}

export function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, field]) => field !== undefined).sort(([a], [b]) => a.localeCompare(b, "en"));
    const members = entries.map(([key, field]) => JSON.stringify(key) + ":" + canonical(field));
    return "{" + members.join(",") + "}";
  }
  return JSON.stringify(value);
}
