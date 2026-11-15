import { logger } from "@octogee/core/http/logging";

const MM_URL =
  process.env.MM_URL ||
  `http://mattermost.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:8065`;

function getAdminToken(): string {
  const token = process.env.MM_ADMIN_TOKEN;
  if (!token) throw new Error("MM_ADMIN_TOKEN not configured");
  return token;
}

function isExpectedMembershipConflict(path: string, method: string, status: number): boolean {
  return status === 409
    && method === "POST"
    && /^\/(?:channels|teams)\/[^/]+\/members$/u.test(path);
}

export async function mmApi(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
): Promise<unknown> {
  const authToken = token || getAdminToken();
  const url = `${MM_URL}/api/v4${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (!isExpectedMembershipConflict(path, method, resp.status)) {
      logger.error(`MM API error: ${resp.status} ${method} ${path}`, {
        response: text.slice(0, 500),
      });
    }
    const err = new Error(`MM API ${resp.status}: ${text.slice(0, 200)}`) as Error & { status: number };
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

export async function mmUploadAvatarBuffer(
  userId: string,
  png: Buffer,
  token?: string,
): Promise<boolean> {
  const authToken = token || getAdminToken();
  const bytes = new Uint8Array(png.length);
  bytes.set(png);
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), "avatar.png");
  const resp = await fetch(`${MM_URL}/api/v4/users/${userId}/image`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}` },
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error(`MM avatar upload error: ${resp.status} ${userId}`, {
      response: text.slice(0, 300),
    });
    return false;
  }
  return true;
}

export { MM_URL };
