import {
  GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME,
  isGatewayClass,
  isGatewayControlIdentity,
  isGatewayProfile,
  isValidGatewayId,
  isolatedGatewayServiceAccountName,
  type GatewayClass,
  type GatewayImageProfile,
  type GatewayModelBrokerLimits,
  type GatewayProfile,
  type GatewayServiceAccountSpec,
  type IsolatedGatewayAccessSpec,
} from "./glm.js";
import { isSizingTier, type SizingTier } from "./sizing.js";

export const GATEWAY_CONFIG_SCHEMA_VERSION = 1 as const;

const KUBERNETES_SERVICE_ACCOUNT_NAME = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u;
const REVISION_GATEWAY_ID_RE = /-r[1-9]\d*$/u;
const GATEWAY_SERVICE_ACCOUNT_PREFIX = "octogee-gw-";
const LEGACY_GATEWAY_SERVICE_ACCOUNT_PREFIX = "octogee-gateway-";
const PLATFORM_SERVICE_ACCOUNT_NAMES = new Set([
  "default",
  "octogee-api",
  GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME,
  "octogee-cron",
  "glm-controller",
  "llm-broker",
  "octogee-glm-controller",
]);

export interface GatewayMutableConfig {
  configSchemaVersion: typeof GATEWAY_CONFIG_SCHEMA_VERSION;
  profile: GatewayProfile | null;
  gatewayClass: GatewayClass;
  imageProfile: GatewayImageProfile;
  sizingTier: SizingTier | null;
  sizingProfile?: string | null;
  gcpProject: string | null;
  gatewayContainerSecurityContext: Record<string, unknown> | null;
  serviceAccountName: string | null;
  serviceAccount: GatewayServiceAccountSpec | null;
  builderAccess: IsolatedGatewayAccessSpec | null;
  ownerUid: string | null;
  builderSlug: string | null;
  modelBrokerLimits: GatewayModelBrokerLimits | null;
  preemption?: null;
  allocation?: IsolatedGatewayAllocation | null;
}

export interface IsolatedGatewayAllocation {
  kind: "disposable-builder";
  schemaVersion: 1;
  leaseId: string;
  generation: number;
  claimedByUid: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableServiceAccountName(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      (value.length === 0 ||
        (value.length <= 63 && KUBERNETES_SERVICE_ACCOUNT_NAME.test(value))))
  );
}

function isNullableRecord(value: unknown): value is Record<string, unknown> | null {
  return value === null || isRecord(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isNullableSizingTier(value: unknown): value is SizingTier | null {
  return value === null || isSizingTier(value);
}

function isNullableIsolatedAccess(value: unknown): value is IsolatedGatewayAccessSpec | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const fields = new Set([
    "controlUiEnabled",
    "controlIdentity",
    "kubeApiServerEgressCidrs",
    "reason",
    "verifiedAt",
    "verifiedBy",
  ]);
  if (!Object.keys(value).every((field) => fields.has(field))) return false;
  const validPowerAccess = isOptionalBoolean(value.controlUiEnabled) &&
    (value.controlIdentity === undefined || isGatewayControlIdentity(value.controlIdentity));
  const validNetworkAccess = value.kubeApiServerEgressCidrs === undefined ||
    isStringArray(value.kubeApiServerEgressCidrs);
  const validVerification = isOptionalString(value.reason) &&
    (value.verifiedAt === undefined ||
      (typeof value.verifiedAt === "number" && Number.isFinite(value.verifiedAt))) &&
    isOptionalString(value.verifiedBy);
  return validPowerAccess && validNetworkAccess && validVerification;
}

function isNullableServiceAccount(value: unknown): value is GatewayServiceAccountSpec | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const annotations = value.annotations;
  return (
    (value.create === undefined || typeof value.create === "boolean") &&
    (annotations === undefined ||
      (isRecord(annotations) &&
        Object.values(annotations).every((entry) => typeof entry === "string")))
  );
}

function isNullableModelBrokerLimits(value: unknown): value is GatewayModelBrokerLimits | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const spendWindowUsd = value.spendWindowUsd;
  const spendWeekUsd = value.spendWeekUsd;
  const requestsPerMinute = value.requestsPerMinute;
  const isNonNegative = (entry: unknown) =>
    entry === undefined ||
    entry === null ||
    (typeof entry === "number" && Number.isFinite(entry) && entry >= 0);
  return (
    isNonNegative(spendWindowUsd) &&
    isNonNegative(spendWeekUsd) &&
    isNonNegative(requestsPerMinute)
  );
}

export function isIsolatedGatewayAllocation(
  value: unknown,
): value is IsolatedGatewayAllocation {
  if (!isRecord(value)) return false;
  const fields = new Set(["kind", "schemaVersion", "leaseId", "generation", "claimedByUid"]);
  return Object.keys(value).every((field) => fields.has(field)) &&
    value.kind === "disposable-builder" &&
    value.schemaVersion === 1 &&
    typeof value.leaseId === "string" &&
    value.leaseId.length > 0 &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) > 0 &&
    typeof value.claimedByUid === "string" &&
    value.claimedByUid.length > 0;
}

function isOptionalIsolatedGatewayAllocation(
  value: unknown,
): value is IsolatedGatewayAllocation | null | undefined {
  return value === undefined || value === null || isIsolatedGatewayAllocation(value);
}

function isOwnedGateway(value: Record<string, unknown>): boolean {
  return typeof value.ownerUid === "string" && value.ownerUid.length > 0 &&
    typeof value.builderSlug === "string" && value.builderSlug.length > 0;
}

function hasLegalOwnedAllocation(value: Record<string, unknown>): boolean {
  const allocation = value.allocation;
  if (allocation === undefined || allocation === null) return true;
  return isIsolatedGatewayAllocation(allocation) &&
    allocation.claimedByUid === value.ownerUid;
}

function isUnallocated(value: Record<string, unknown>): boolean {
  return value.allocation === undefined || value.allocation === null;
}

function hasLegalOwnershipAndAllocation(value: Record<string, unknown>): boolean {
  if (value.gatewayClass === "shared") {
    return value.ownerUid === null && value.builderSlug === null && isUnallocated(value);
  }
  return isOwnedGateway(value) && hasLegalOwnedAllocation(value);
}

function hasLegalClassProfiles(value: Record<string, unknown>): boolean {
  if (value.gatewayClass === "shared") {
    return (value.profile === null || value.profile === "standard") &&
      value.imageProfile === "standard";
  }
  return (value.profile === null || value.profile === "builder") &&
    value.imageProfile === "builder";
}

export function isBareGatewayId(value: unknown): value is string {
  return isValidGatewayId(value) && !REVISION_GATEWAY_ID_RE.test(value);
}

// eslint-disable-next-line complexity
export function isGatewayMutableConfig(value: unknown): value is GatewayMutableConfig {
  if (!isRecord(value) || value.configSchemaVersion !== GATEWAY_CONFIG_SCHEMA_VERSION) return false;
  if (
    Object.prototype.hasOwnProperty.call(value, "byosub") ||
    Object.prototype.hasOwnProperty.call(value, "coOwnerUids") ||
    Object.prototype.hasOwnProperty.call(value, "standby")
  ) return false;
  return (
    (value.profile === null || isGatewayProfile(value.profile)) &&
    isGatewayClass(value.gatewayClass) &&
    isGatewayProfile(value.imageProfile) &&
    isNullableSizingTier(value.sizingTier) &&
    (value.sizingProfile === undefined || isNullableString(value.sizingProfile)) &&
    isNullableString(value.gcpProject) &&
    isNullableRecord(value.gatewayContainerSecurityContext) &&
    isNullableServiceAccountName(value.serviceAccountName) &&
    isNullableServiceAccount(value.serviceAccount) &&
    isNullableIsolatedAccess(value.builderAccess) &&
    isNullableString(value.ownerUid) &&
    isNullableString(value.builderSlug) &&
    isNullableModelBrokerLimits(value.modelBrokerLimits) &&
    (value.preemption === undefined || value.preemption === null) &&
    isOptionalIsolatedGatewayAllocation(value.allocation) &&
    hasLegalClassProfiles(value) &&
    hasLegalOwnershipAndAllocation(value)
  );
}

export function isGatewayMutableConfigForGateway(
  value: unknown,
  gatewayId: string,
): value is GatewayMutableConfig {
  if (!isBareGatewayId(gatewayId) || !isGatewayMutableConfig(value)) return false;
  const serviceAccountName = value.serviceAccountName;
  if (serviceAccountName === null || serviceAccountName === "") return true;
  if (PLATFORM_SERVICE_ACCOUNT_NAMES.has(serviceAccountName)) return false;
  const generatedName = isolatedGatewayServiceAccountName(gatewayId);
  const legacyName = `${LEGACY_GATEWAY_SERVICE_ACCOUNT_PREFIX}${gatewayId}`;
  if (serviceAccountName.startsWith(GATEWAY_SERVICE_ACCOUNT_PREFIX)) {
    return serviceAccountName === generatedName;
  }
  if (serviceAccountName.startsWith(LEGACY_GATEWAY_SERVICE_ACCOUNT_PREFIX)) {
    return serviceAccountName === legacyName;
  }
  return true;
}

export function projectGatewayMutableConfigForGateway(
  value: unknown,
  gatewayId: string,
): GatewayMutableConfig | null {
  if (isGatewayMutableConfigForGateway(value, gatewayId)) return value;
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "coOwnerUids")) {
    return null;
  }
  if (!Array.isArray(value.coOwnerUids) || value.coOwnerUids.length !== 0) return null;
  const projected = { ...value };
  delete projected.coOwnerUids;
  return isGatewayMutableConfigForGateway(projected, gatewayId) ? projected : null;
}

export function effectiveGatewayServiceAccountNameForGateway(
  config: GatewayMutableConfig,
  gatewayId: string,
): string {
  return config.serviceAccountName || isolatedGatewayServiceAccountName(gatewayId);
}
