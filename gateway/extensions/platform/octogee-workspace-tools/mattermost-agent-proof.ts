import { readFile } from "node:fs/promises";

const DEFAULT_SECRETS_PATH = "/home/node/.openclaw/secrets/mattermost-accounts.json";

export async function readMattermostAgentProofSecret(
  accountId: string,
  filePath = DEFAULT_SECRETS_PATH,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Mattermost account secrets must contain a JSON object");
  }
  const value = (parsed as Record<string, unknown>)[accountId];
  return typeof value === "string" && value.length > 0 ? value : null;
}
