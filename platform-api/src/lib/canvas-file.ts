export const DEFAULT_CANVAS_FILE = "README.md";

const SAFE_CANVAS_PATH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const MARKDOWN_CANVAS_PATH_RE = /\.(md|markdown)$/i;

export function isSafeCanvasPath(p: unknown): p is string {
  if (typeof p !== "string") return false;
  if (!SAFE_CANVAS_PATH_RE.test(p)) return false;
  if (p.startsWith("/")) return false;
  if (p.split("/").some((seg) => seg === "..")) return false;
  return true;
}

export function resolveCanvasFile(canvasFile: unknown): string {
  return isSafeCanvasPath(canvasFile) ? canvasFile : DEFAULT_CANVAS_FILE;
}

export function isSettableCanvasFile(p: unknown): p is string {
  return isSafeCanvasPath(p) && MARKDOWN_CANVAS_PATH_RE.test(p);
}
