const SAFE_PATH_RE = /^[a-zA-Z0-9\-_./\s]+$/;

export function validateFilePath(filePath: string): string | null {
  if (!filePath || typeof filePath !== "string") {
    return "Path is required";
  }

  const trimmed = filePath.trim();

  if (trimmed.length === 0) {
    return "Path is empty";
  }

  if (trimmed.length > 500) {
    return "Path too long (max 500 chars)";
  }

  if (trimmed.startsWith("/")) {
    return "Absolute paths not allowed";
  }

  if (trimmed.includes("\0")) {
    return "Null bytes not allowed";
  }

  if (trimmed.includes("..")) {
    return "Path traversal (..) not allowed";
  }

  if (trimmed.includes("//")) {
    return "Double slashes not allowed";
  }

  if (trimmed.includes("\\")) {
    return "Backslashes not allowed";
  }

  if (!SAFE_PATH_RE.test(trimmed)) {
    return "Path contains invalid characters";
  }

  return null;
}
