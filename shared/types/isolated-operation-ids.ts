function runtimeOperationSuffix(gatewayId: string, generation: number): string {
  if (gatewayId.length === 0) throw new Error("Isolated runtime operation needs a gateway id");
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error(`Isolated runtime operation needs a positive generation, got ${generation}`);
  }
  return `${gatewayId}-g${generation}`;
}

export function builderActivateOperationId(gatewayId: string, generation: number): string {
  return `builder-activate-${runtimeOperationSuffix(gatewayId, generation)}`;
}

export function builderReturnOperationId(gatewayId: string, generation: number): string {
  return `builder-return-${runtimeOperationSuffix(gatewayId, generation)}`;
}

export function isolatedRecoverOperationId(gatewayId: string, generation: number): string {
  return `builder-recover-${runtimeOperationSuffix(gatewayId, generation)}`;
}

export function placementRetireOperationId(uid: string, gatewayId: string, generation: number): string {
  if (uid.length === 0) throw new Error("placement retirement needs an owner uid");
  return `placement-retire-${uid}-${runtimeOperationSuffix(gatewayId, generation)}`;
}

function runtimeOperationIdMatches(prefix: string, operationId: unknown, gatewayId: unknown): boolean {
  if (typeof operationId !== "string" || typeof gatewayId !== "string" || gatewayId.length === 0) return false;
  const head = `${prefix}${gatewayId}-g`;
  return operationId.startsWith(head) && /^[1-9]\d*$/.test(operationId.slice(head.length));
}

export function isUserActivateOperationIdFor(operationId: unknown, gatewayId: unknown): boolean {
  return runtimeOperationIdMatches("builder-activate-", operationId, gatewayId);
}

export function isUserReturnOperationIdFor(operationId: unknown, gatewayId: unknown): boolean {
  return runtimeOperationIdMatches("builder-return-", operationId, gatewayId);
}
