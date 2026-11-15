import { OpenclawWireError } from "./gateway-rpc.js";

export class SchedulerRefusal extends Error {
  override readonly name = "SchedulerRefusal";
}

const TRANSIENT_GATEWAY_REFUSALS = [
  /Auth profile "[^"]+" is temporarily unavailable/,
  /contains unsettled runs/,
];

export function isRetryableSchedulerFailure(error: unknown): boolean {
  if (error instanceof SchedulerRefusal) return false;
  if (error instanceof OpenclawWireError && error.code === "rpc-error") {
    return TRANSIENT_GATEWAY_REFUSALS.some(refusal => refusal.test(error.message));
  }
  return true;
}
