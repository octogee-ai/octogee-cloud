const ASSET_PATH = /^\/api\/g\/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\/openclaw\/assets\/(?:[A-Za-z0-9@+_-][A-Za-z0-9@+._-]*\/)*[A-Za-z0-9@+_-][A-Za-z0-9@+._-]*[.]([a-z]+)$/u;
const ASSET_EXTENSIONS = new Set([
  "css", "gif", "ico", "jpeg", "jpg", "js", "json", "map", "png", "svg", "txt", "wasm", "webmanifest", "webp",
]);

export function isDashboardAssetRequest(req: { method: string; path: string }): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const match = ASSET_PATH.exec(req.path);
  return Boolean(match && ASSET_EXTENSIONS.has(match[1]));
}
