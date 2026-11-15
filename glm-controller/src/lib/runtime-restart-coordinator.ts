import { randomUUID } from 'node:crypto';
import { updateRuntimeRestart, type RuntimeRestartFence } from '@octogee/core/gateway-runtime-restart';
export { updateRuntimeRestart, type RuntimeRestartFence } from '@octogee/core/gateway-runtime-restart';
import { assertGatewayRuntimeMutationUnfencedInStore } from '@octogee/core/gateway-retirement-claim';
import { findActiveGatewayMigration, type FleetOperationLockRef } from '@octogee/core/fleet-operation-lock';
import { runNormalFleetMutation } from '@octogee/core/normal-fleet-mutation';
import type { PlatformStateRepositories, PlatformStateStore } from '@octogee/core/platform-state';
import { runGatewayRuntimeExclusive } from './gateway-runtime-mutation.js';

export type RuntimeRestartObservation = 'completed' | 'abandoned';

export async function assertMigrationRestartUnfenced(state:Pick<PlatformStateRepositories,'gateways'|'users'>,input:Record<string,unknown>):Promise<void> {
  const ids=[...new Set([input.fromGatewayId,input.toGatewayId].filter((id):id is string=>typeof id==='string'))];
  const uid = typeof input.uid === 'string' && input.uid && !input.uid.includes('/') ? input.uid : null;
  const [roots, owner] = await Promise.all([
    state.gateways.roots.getMany(ids),
    uid ? state.users.records.get(uid) : null,
  ]);
  if([...roots.values()].some(root=>root.runtimeRestartFence!==undefined))throw new Error('gateway runtime restart outcome is unresolved');
  if (owner?.fences.computerRecovery !== undefined) throw new Error('Gateway VM recovery is in progress');
}
export async function acquireRuntimeRestart(store:PlatformStateStore,fence:RuntimeRestartFence):Promise<void> {
  await store.transaction({label:'runtime-restart.acquire'},async transaction=>{
    const [root,operations]=await Promise.all([transaction.gateways.roots.get(fence.gatewayId),transaction.journal.operations.listByStatus(['running','pending'])]);
    await assertGatewayRuntimeMutationUnfencedInStore(transaction,fence.gatewayId);
    if(!root || !['running','draining'].includes(root.desiredStatus) || root.retirementClaim!=null || root.runtimeRestartFence!==undefined || !Number.isSafeInteger(root.liveRelease) || root.liveRelease!<1 || root.desiredRelease!==root.liveRelease)throw new Error('gateway restart authority is unavailable');
    if(findActiveGatewayMigration(fence.gatewayId,operations as readonly FleetOperationLockRef[]))throw new Error('gateway migration is pending during restart admission');
    await transaction.gateways.roots.compareAndSetRuntimeRestartFence(fence.gatewayId,null,fence);
  });
}
async function savedRuntimeRestart(store:PlatformStateStore,gatewayId:string):Promise<RuntimeRestartFence|undefined> {
  return (await store.gateways.roots.get(gatewayId))?.runtimeRestartFence as RuntimeRestartFence|undefined;
}
function observable(fence:RuntimeRestartFence|undefined):fence is RuntimeRestartFence {
  return fence?.phase==='dispatched' || fence?.phase==='acknowledged';
}
function messageOf(error:unknown):string {
  return error instanceof Error ? error.message : String(error);
}
export async function coordinateRuntimeRestart(
  store:PlatformStateStore,gatewayId:string,kind:RuntimeRestartFence['kind'],
  work:(fence:RuntimeRestartFence,save:(next:RuntimeRestartFence)=>Promise<void>)=>Promise<void>,
  observe?:(fence:RuntimeRestartFence)=>Promise<RuntimeRestartObservation>,
):Promise<void> {
  const attemptId=randomUUID();
  const saved=await savedRuntimeRestart(store,gatewayId);
  await runNormalFleetMutation(store,{
    actor:'cowboy',forced:false,what:observable(saved)?'gateway-restart-observation':`gateway-${kind}-restart`,why:kind==='deployment'?'model-key secret changed':'operator requested process restart',
    target:{gatewayId},preActionStatus:saved?{restartAttemptId:saved.attemptId,phase:saved.phase}:{},mutation:{kind,attemptId},idempotencyKey:attemptId,
    action:async claim=>{
      const existing=await savedRuntimeRestart(store,gatewayId);
      if(observable(existing)) {
        if(!observe || existing.gatewayId!==gatewayId)throw new Error('gateway restart observation unavailable');
        const observation=await observe(existing);
        await updateRuntimeRestart(store,existing,null);
        if(observation==='abandoned')throw new Error(`gateway ${existing.kind} restart ${existing.attemptId} never took effect; its fence is cleared`);
        return;
      }
      let current:RuntimeRestartFence={attemptId,auditId:claim.auditId,gatewayId,kind,startedAt:Date.now(),phase:'reserved'};
      await runGatewayRuntimeExclusive(() => acquireRuntimeRestart(store,current));
      try {
        await work(current,async next=>{await updateRuntimeRestart(store,current,next);current=next;});
        if(current.phase!=='acknowledged')throw new Error('gateway restart completion was not acknowledged');
        await updateRuntimeRestart(store,current,null);
      } catch(error) {
        if(current.phase==='reserved')await updateRuntimeRestart(store,current,null);
        if(current.phase!=='dispatched' || !observe)throw error;
        const unresolved=await observe(current).then(()=>null,(observation:unknown)=>observation);
        if(unresolved!==null)throw new Error(`${messageOf(error)}; ${messageOf(unresolved)}`,{cause:error});
        await updateRuntimeRestart(store,current,null);
        throw error;
      }
    },
  });
}
