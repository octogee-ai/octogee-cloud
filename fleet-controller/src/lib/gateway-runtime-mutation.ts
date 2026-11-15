import type { PlatformStateStore, PlatformStateTransaction } from '@octogee/core/platform-state';
import { assertGatewayRuntimeMutationUnfencedInStore } from '@octogee/core/gateway-retirement-claim';

let runtimeMutationTail: Promise<unknown> = Promise.resolve();

export function runGatewayRuntimeExclusive<T>(work: () => Promise<T>): Promise<T> {
  const pending = runtimeMutationTail.then(work);
  runtimeMutationTail = pending.catch(() => undefined);
  return pending;
}

export async function withGatewayRuntimeMutation<T>(
  store: PlatformStateStore,
  gatewayId: string,
  mutation: (transaction: PlatformStateTransaction) => Promise<T>,
  allowedVmRecoveryOperationId?: string,
): Promise<T> {
  return store.transaction({ label: 'gateway-runtime-mutation' }, async transaction => {
    await assertGatewayRuntimeMutationUnfencedInStore(transaction, gatewayId, allowedVmRecoveryOperationId);
    return mutation(transaction);
  });
}
