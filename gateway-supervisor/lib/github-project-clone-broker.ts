import { internalFetch } from "./internal-fetch.js";

function baseUrl(): string {
  return process.env.GATEWAY_EDGE_INTERNAL_URL || "http://127.0.0.1:3001";
}

export async function cloneGithubProjectViaBroker(
  builderSlug: string,
  projectSlug: string,
): Promise<boolean> {
  const response = await internalFetch(`${baseUrl()}/internal/connectors/github/clone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ builderSlug, projectSlug }),
  });
  if (response.ok) return true;
  const detail = (await response.text().catch(() => "")).slice(0, 300);
  throw new Error(`GitHub project clone broker failed: ${response.status} ${detail}`);
}
