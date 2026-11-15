import { USERNAME_RE } from "@octogee/shared/types/identity";
import { platformStateStore } from "../identity/platform-state-store.js";

export interface UserWorkspaceIdentityData {
  username?: unknown;
  workspaceId?: unknown;
  workspaceSlug?: unknown;
  defaultWorkspaceId?: unknown;
  provisioning?: {
    openclaw?: {
      slug?: unknown;
    } | null;
  } | null;
}

function usableSlug(v: unknown): string | null {
  return typeof v === "string" && USERNAME_RE.test(v) ? v : null;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

async function ownsWorkspace(uid: string, slug: string): Promise<boolean> {
  return (await platformStateStore.workspaces.records.get(slug))?.ownerUid === uid;
}

export async function resolveCanonicalWorkspaceSlug(
  uid: string,
  data: UserWorkspaceIdentityData | null | undefined,
): Promise<string | null> {
  const provisionedSlug = usableSlug(data?.provisioning?.openclaw?.slug);
  if (provisionedSlug) return provisionedSlug;

  const candidates = unique(
    [
      data?.workspaceSlug,
      data?.workspaceId,
      data?.defaultWorkspaceId,
      data?.username,
    ]
      .map(usableSlug)
      .filter((slug): slug is string => !!slug),
  );

  for (const slug of candidates) {
    if (await ownsWorkspace(uid, slug)) return slug;
  }
  return null;
}
