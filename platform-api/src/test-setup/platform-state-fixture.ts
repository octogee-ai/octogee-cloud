import type { UserPatch } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

const records = new Map<string, Record<string, unknown>>();

export const platformState = createDocumentFixtureStore(records);

export function resetPlatformState(): void {
  records.clear();
}

export async function seedPlatformUser(uid: string, patch: UserPatch = {}, gatewayId?: string): Promise<void> {
  await platformState.users.records.create({ uid, createdAt: Date.now() });
  if (Object.keys(patch).length > 0) await platformState.users.records.patch(uid, patch);
  if (gatewayId !== undefined) await platformState.users.records.setGatewayMirror(uid, { gatewayId });
}

type SeedData = Record<string, unknown>;

function isPlainMap(value: unknown): value is SeedData {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function mergeDeep(base: SeedData, patch: SeedData): SeedData {
  const next: SeedData = { ...base };
  for (const [field, value] of Object.entries(patch)) {
    next[field] = isPlainMap(value) && isPlainMap(next[field]) ? mergeDeep(next[field] as SeedData, value) : value;
  }
  return next;
}

export async function seedDocument(
  db: { doc(path: string): { set(data: SeedData, options?: { merge?: boolean }): Promise<unknown> } },
  path: string,
  data: SeedData,
  options: { merge?: boolean } = {},
): Promise<void> {
  await db.doc(path).set(data, options);
  records.set(path, options.merge ? mergeDeep(records.get(path) ?? {}, data) : data);
}

export async function deleteDocument(db: { doc(path: string): { delete(): Promise<unknown> } }, path: string): Promise<void> {
  await db.doc(path).delete();
  records.delete(path);
}

export function platformDocument(path: string): SeedData | undefined {
  return records.get(path);
}
