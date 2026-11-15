export function applyConnectorApprovalDelivery(config: Record<string, unknown>): boolean {
  const previous = JSON.stringify(config.approvals);
  const approvals = config.approvals ?? {};
  if (!approvals || typeof approvals !== "object" || Array.isArray(approvals)) throw new Error("OpenClaw approvals must be an object");
  const plugin = (approvals as Record<string, unknown>).plugin ?? {};
  if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) throw new Error("OpenClaw plugin approvals must be an object");
  (approvals as Record<string, unknown>).plugin = { enabled: true, mode: "session", ...plugin };
  config.approvals = approvals;
  return JSON.stringify(approvals) !== previous;
}
