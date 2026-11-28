const SECRET_REF_SOURCES = new Set(["env", "file", "exec", "store"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secretRefKey(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).length !== 3) return null;
  const { source, provider, id } = value;
  if (typeof source !== "string" || !SECRET_REF_SOURCES.has(source)) return null;
  if (typeof provider !== "string" || typeof id !== "string") return null;
  return `${source}:${provider}:${id}`;
}

export function collectSecretRefs(config: unknown): Map<string, string> {
  const refs = new Map<string, string>();
  const visit = (value: unknown, path: string): void => {
    const key = secretRefKey(value);
    if (key !== null) {
      refs.set(path, key);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, path ? `${path}.${index}` : String(index)));
      return;
    }
    if (!isRecord(value)) return;
    for (const [name, entry] of Object.entries(value)) {
      visit(entry, path ? `${path}.${name}` : name);
    }
  };
  visit(config, "");
  return refs;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? "undefined";
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

function secretProviderConfig(config: unknown): string {
  return canonicalJson(isRecord(config) ? config.secrets : undefined);
}

export function configSecretMaterialChangeReasons(before: unknown, after: unknown): string[] {
  const reasons: string[] = [];
  if (secretProviderConfig(before) !== secretProviderConfig(after)) {
    reasons.push("secret provider config changed");
  }
  const previous = collectSecretRefs(before);
  const current = collectSecretRefs(after);
  for (const [path, key] of current) {
    const priorKey = previous.get(path);
    if (priorKey === undefined) reasons.push(`SecretRef added at ${path}`);
    else if (priorKey !== key) reasons.push(`SecretRef changed at ${path}`);
  }
  for (const path of previous.keys()) {
    if (!current.has(path)) reasons.push(`SecretRef removed at ${path}`);
  }
  return reasons;
}

export type SecretMaterialReason = string | readonly string[] | null | undefined;

export interface SecretMaterialLedger {
  readonly reasons: readonly string[];
  readonly changed: boolean;
  readonly authStoreChanged: boolean;
  note(reason: SecretMaterialReason): void;
  noteIf(changed: boolean, reason: string): void;
  noteAuthStore(reason: SecretMaterialReason): void;
  noteAuthStoreIf(changed: boolean, reason: string): void;
}

export function createSecretMaterialLedger(): SecretMaterialLedger {
  const reasons: string[] = [];
  let authStoreChanged = false;
  const record = (reason: SecretMaterialReason): boolean => {
    if (reason === null || reason === undefined) return false;
    if (typeof reason === "string") {
      if (reason.length === 0) return false;
      reasons.push(reason);
      return true;
    }
    const entries = reason.filter((entry) => entry.length > 0);
    if (entries.length === 0) return false;
    reasons.push(...entries);
    return true;
  };
  return {
    get reasons() {
      return reasons;
    },
    get changed() {
      return reasons.length > 0;
    },
    get authStoreChanged() {
      return authStoreChanged;
    },
    note(reason) {
      record(reason);
    },
    noteIf(changed, reason) {
      if (changed) record(reason);
    },
    noteAuthStore(reason) {
      if (record(reason)) authStoreChanged = true;
    },
    noteAuthStoreIf(changed, reason) {
      if (changed && record(reason)) authStoreChanged = true;
    },
  };
}
