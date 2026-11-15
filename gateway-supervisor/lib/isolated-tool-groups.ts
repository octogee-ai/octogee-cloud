export interface IsolatedToolGroup {
  id: string;
  enabled: boolean;
  delivery: "base" | "npm";
  baseImagePackages?: string[];
  npmPackages?: Record<string, string>;
  debianPackages?: string[];
  commands?: string[];
}

export interface IsolatedToolGroups {
  schemaVersion: 1;
  groups: IsolatedToolGroup[];
  pythonPackages: string[];
  standaloneTools: Record<string, UserStandaloneTool>;
}

export interface UserStandaloneTool {
  version: string;
  sha256?: string;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) return null;
  return [...value];
}

function versionMap(value: unknown): Record<string, string> | null {
  const record = objectRecord(value);
  if (!record) return null;
  for (const [name, version] of Object.entries(record)) {
    if (!name || typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      return null;
    }
  }
  return record as Record<string, string>;
}

function standaloneToolMap(value: unknown): Record<string, UserStandaloneTool> | null {
  const record = objectRecord(value);
  if (!record) return null;
  const result: Record<string, UserStandaloneTool> = {};
  for (const [name, rawTool] of Object.entries(record)) {
    const tool = objectRecord(rawTool);
    if (!name || !tool || !exactKeys(tool, [
      "version",
      ...(tool.sha256 === undefined ? [] : ["sha256"]),
    ]) || typeof tool.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tool.version) ||
      (tool.sha256 !== undefined &&
        (typeof tool.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(tool.sha256)))) {
      return null;
    }
    result[name] = {
      version: tool.version,
      ...(typeof tool.sha256 === "string" ? { sha256: tool.sha256 } : {}),
    };
  }
  return result;
}

function fail(): never {
  throw new Error("invalid-builder-tool-groups");
}

const GROUP_KEYS = [
  "id", "enabled", "delivery", "baseImagePackages", "npmPackages", "debianPackages", "commands",
];

function groupDelivery(value: unknown): IsolatedToolGroup["delivery"] {
  if (value !== "base" && value !== "npm") fail();
  return value;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return stringArray(value) ?? fail();
}

function optionalVersionMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  return versionMap(value) ?? fail();
}

function validateGroupDelivery(
  delivery: IsolatedToolGroup["delivery"],
  baseImagePackages: string[] | undefined,
  npmPackages: Record<string, string> | undefined,
  debianPackages: string[] | undefined,
): void {
  if (delivery === "base") {
    if (npmPackages) fail();
    return;
  }
  if (!npmPackages) fail();
  if (baseImagePackages) fail();
  if (debianPackages) fail();
}

function parseIsolatedToolGroup(value: unknown): IsolatedToolGroup {
  const group = objectRecord(value);
  if (!group) fail();
  if (Object.keys(group).some((key) => !GROUP_KEYS.includes(key))) fail();
  if (typeof group.id !== "string") fail();
  if (!/^[a-z][a-z-]+$/u.test(group.id)) fail();
  if (typeof group.enabled !== "boolean") fail();
  const delivery = groupDelivery(group.delivery);
  const baseImagePackages = optionalStringArray(group.baseImagePackages);
  const npmPackages = optionalVersionMap(group.npmPackages);
  const debianPackages = optionalStringArray(group.debianPackages);
  const commands = optionalStringArray(group.commands);
  const payloadCount = [baseImagePackages, npmPackages, debianPackages, commands]
    .filter(Boolean).length;
  if (payloadCount === 0) fail();
  validateGroupDelivery(delivery, baseImagePackages, npmPackages, debianPackages);
  return {
    id: group.id,
    enabled: group.enabled,
    delivery,
    ...(baseImagePackages ? { baseImagePackages } : {}),
    ...(npmPackages ? { npmPackages } : {}),
    ...(debianPackages ? { debianPackages } : {}),
    ...(commands ? { commands } : {}),
  };
}

function addUnique(values: string[], seen: Set<string>): void {
  for (const value of values) {
    if (seen.has(value)) fail();
    seen.add(value);
  }
}

function assertUniqueGroups(groups: IsolatedToolGroup[]): void {
  const ids = new Set<string>();
  const packages = new Set<string>();
  const commands = new Set<string>();
  for (const group of groups) {
    addUnique([group.id], ids);
    addUnique([
      ...(group.baseImagePackages ?? []),
      ...Object.keys(group.npmPackages ?? {}),
      ...(group.debianPackages ?? []),
    ], packages);
    addUnique(group.commands ?? [], commands);
  }
}

export function parseIsolatedToolGroups(value: unknown): IsolatedToolGroups {
  const manifest = objectRecord(value);
  if (!manifest || manifest.schemaVersion !== 1 || !exactKeys(manifest, [
    "schemaVersion",
    "groups",
    "pythonPackages",
    "standaloneTools",
  ])) fail();
  if (!Array.isArray(manifest.groups) || manifest.groups.length === 0) fail();
  const groups = manifest.groups.map(parseIsolatedToolGroup);
  assertUniqueGroups(groups);
  const pythonPackages = stringArray(manifest.pythonPackages);
  const standaloneTools = standaloneToolMap(manifest.standaloneTools);
  if (!pythonPackages || !standaloneTools || new Set(pythonPackages).size !== pythonPackages.length) fail();
  return { schemaVersion: 1, groups, pythonPackages, standaloneTools };
}

export function enabledNpmPackages(manifest: IsolatedToolGroups): Record<string, string> {
  return Object.fromEntries(
    manifest.groups
      .filter((group) => group.enabled && group.delivery === "npm")
      .flatMap((group) => Object.entries(group.npmPackages ?? {})),
  );
}
