export function classifyHttp(status: number): "user" | "transient" {
  if (status === 401 || status === 403) return "user";
  if (status === 429) return "transient";
  if (status >= 500) return "transient";
  return "user";
}
