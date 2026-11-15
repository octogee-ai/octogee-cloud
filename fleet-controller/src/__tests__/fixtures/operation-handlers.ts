import type { OperationHandler, OperationHandlers } from "../../operation-router.js";

const unexpected: OperationHandler = async (op) => {
  throw new Error(`unexpected ${op.kind} dispatch`);
};

export function operationHandlers(overrides: Partial<OperationHandlers> = {}): OperationHandlers {
  return {
    "add-gateway": unexpected,
    "gateway-vm": unexpected,
    "migrate-user": unexpected,
    "retire-gateway": unexpected,
    "restart-gateway": unexpected,
    "recycle-gateway": unexpected,
    "scale-shared-member": unexpected,
    rollout: unexpected,
    "deprovision-user": unexpected,
    "suspend-user": unexpected,
    "erase-user": unexpected,
    ...overrides,
  };
}
