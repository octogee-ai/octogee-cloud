import type { ModelCredentialRecord, PlatformUserRecord, PlatformStateRepositories } from "@octogee/core/platform-state";
import { readGatewayAuthorizationInStore, type GatewayAuthorization } from "@octogee/core/gateway-live-release";

import type {
  ModelBrokerProvider,
  ModelBrokerTokenRecord,
} from "./tokens.js";
import { readSecret as defaultReadSecret } from "@octogee/core/secret-store";
import { userAssignedToGateway } from "@octogee/core/assigned-user";

export type ModelBrokerProviderKeySource = "platform" | "owner_model_credential";

export interface ModelBrokerProviderKey {
  apiKey: string;
  source: ModelBrokerProviderKeySource;
  secretName?: string;
}

export interface ResolveModelBrokerProviderKeyInput {
  provider: ModelBrokerProvider;
  record: ModelBrokerTokenRecord;
}

export type ModelBrokerProviderKeyResolver = (
  input: ResolveModelBrokerProviderKeyInput,
) => Promise<ModelBrokerProviderKey | null>;

type ProviderKeyState = Pick<PlatformStateRepositories, "users" | "gateways">;

export interface AnthropicProviderKeyResolverDeps {
  store: ProviderKeyState;
  platformKey?: string;
  readSecret?: (name: string) => Promise<string>;
}

export interface ModelBrokerProviderKeyResolverDeps {
  store: ProviderKeyState;
  platformKeys?: Partial<Record<ModelBrokerProvider, string | undefined>>;
  readSecret?: (name: string) => Promise<string>;
}

export type AnthropicModelCredentialResolution =
  | { kind: "platform" }
  | { kind: "deny" }
  | { kind: "owner_model_credential"; secretName: string };

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function configuredAnthropicModelCredentialResolution(
  builderSlug: string | null,
  credential: ModelCredentialRecord | null,
): AnthropicModelCredentialResolution {
  if (
    credential?.active !== true ||
    credential.provider !== "anthropic" ||
    credential.mode !== "api_key"
  ) {
    return { kind: "platform" };
  }
  const slug = builderSlug !== null && SLUG_PATTERN.test(builderSlug) ? builderSlug : null;
  if (!slug) return { kind: "deny" };
  const expected = `byok-${slug}-anthropic`;
  return credential.secretName === expected
    ? { kind: "owner_model_credential", secretName: expected }
    : { kind: "deny" };
}

function platformKeyResolution(platformKey: string | undefined): ModelBrokerProviderKey | null {
  const apiKey = platformKey?.trim();
  return apiKey ? { apiKey, source: "platform" } : null;
}

interface OwnerKeyAuthority {
  user: PlatformUserRecord | null;
  credential: ModelCredentialRecord | null;
}

async function readOwnerKeyAuthority(
  deps: Pick<AnthropicProviderKeyResolverDeps, "store">,
  ownerUid: string,
): Promise<OwnerKeyAuthority> {
  const [user, credential] = await Promise.all([
    deps.store.users.records.get(ownerUid),
    deps.store.users.modelCredentials.get(ownerUid),
  ]);
  return { user, credential };
}

function assignedUserOwnsKey(
  record: ModelBrokerTokenRecord,
  user: PlatformUserRecord | null,
  authorization: GatewayAuthorization | null,
): user is PlatformUserRecord {
  return authorization?.config.gatewayClass === "isolated" &&
    authorization.config.ownerUid === record.ownerUid &&
    user !== null &&
    userAssignedToGateway(user, record.gatewayId, authorization.config.builderSlug);
}

export function createAnthropicProviderKeyResolver(
  deps: AnthropicProviderKeyResolverDeps,
): ModelBrokerProviderKeyResolver {
  const readSecret = deps.readSecret ?? defaultReadSecret;
  return async ({ provider, record }) => {
    if (provider !== "anthropic") return null;
    if (!record.ownerUid) return platformKeyResolution(deps.platformKey);

    const authorization = await readGatewayAuthorizationInStore(deps.store, record.gatewayId);
    if (!authorization) return null;
    if (authorization.config.gatewayClass === "shared") return platformKeyResolution(deps.platformKey);
    const owner = await readOwnerKeyAuthority(deps, record.ownerUid);
    if (!assignedUserOwnsKey(record, owner.user, authorization)) return null;
    const resolution = configuredAnthropicModelCredentialResolution(owner.user.slug, owner.credential);
    if (resolution.kind === "deny") return null;
    if (resolution.kind === "platform") return platformKeyResolution(deps.platformKey);

    const apiKey = (await readSecret(resolution.secretName)).trim();
    const [current, currentOwner] = await Promise.all([
      readGatewayAuthorizationInStore(deps.store, record.gatewayId),
      readOwnerKeyAuthority(deps, record.ownerUid),
    ]);
    if (!assignedUserOwnsKey(record, currentOwner.user, current)) return null;
    const currentResolution = configuredAnthropicModelCredentialResolution(currentOwner.user.slug, currentOwner.credential);
    if (currentResolution.kind !== "owner_model_credential" || currentResolution.secretName !== resolution.secretName) return null;
    return apiKey
      ? { apiKey, source: "owner_model_credential", secretName: resolution.secretName }
      : null;
  };
}

export function createModelBrokerProviderKeyResolver(
  deps: ModelBrokerProviderKeyResolverDeps,
): ModelBrokerProviderKeyResolver {
  const anthropic = createAnthropicProviderKeyResolver({
    store: deps.store,
    platformKey: deps.platformKeys?.anthropic,
    readSecret: deps.readSecret,
  });
  return async (input) => {
    if (input.provider === "anthropic") return anthropic(input);
    if (input.provider === "openrouter") {
      return platformKeyResolution(deps.platformKeys?.openrouter);
    }
    if (input.provider === "openai") {
      return platformKeyResolution(deps.platformKeys?.openai);
    }
    if (input.provider === "meta") return platformKeyResolution(deps.platformKeys?.meta);
    return null;
  };
}
