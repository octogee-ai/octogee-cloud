export function normalizeTenantPolicyPath(path: string): string {
  let out = path.toLowerCase();
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}
