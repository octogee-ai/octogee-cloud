import { describe, expect, it } from 'vitest';
import { planSourceTransfer, observeSourceTransfer, sourceTransferBlocksRelease } from './source-transfer-execution.js';
const authority = { targetIdentity: 'instance-2', targetGatewayId: 'builder-two', targetName: 'target', targetIp: '10.0.0.2', targetVm: true, operationId: 'op-1', claimStartedAt: 100, migrationId: 'migration-1', uid: 'user-1', slug: 'builder', sourceGatewayId: 'shared-one', assignmentEpoch: 3, podName: 'source', podUid: 'pod-1', namespace: 'octogee-test', image: `registry.example/gateway@sha256:${'a'.repeat(64)}` };
const pod = () => ({ metadata: { name: 'source', namespace: 'octogee-test', uid: 'pod-1', resourceVersion: '5' }, spec: { volumes: [{ name: 'data', emptyDir: {} }], containers: [{ name: 'gateway', volumeMounts: [{name:'data',mountPath:'/home/node'}] }] } });
describe('retained source transfer execution', () => {
 it('binds a deterministic readonly helper to the complete claim and immutable image', () => {
  const planned = planSourceTransfer(authority, pod());
  expect(planned.record).toMatchObject(authority);
  expect(planned.container).toMatchObject({ image: authority.image, stdin: true, stdinOnce: true, volumeMounts: [{ name: 'data', mountPath: '/home/node', readOnly: true }] });
  expect(planned.container.command).toEqual(['/usr/bin/python3', '/octogee/scripts/libexec/source-transfer-launcher.py', planned.record.executionId]);
  expect(planned.patch!.slice(0,2)).toEqual([{op:'test',path:'/metadata/uid',value:'pod-1'},{op:'test',path:'/metadata/resourceVersion',value:'5'}]);
  expect(planSourceTransfer({...authority,claimStartedAt:101},pod()).record.executionId).not.toBe(planned.record.executionId);
 });
 it('observes an existing exact execution and rejects a colliding spec', () => {
  const planned = planSourceTransfer(authority,pod());
  expect(planSourceTransfer(authority,{...pod(),spec:{...pod().spec,ephemeralContainers:[planned.container]}}).patch).toBeNull();
  expect(() => planSourceTransfer(authority,{...pod(),spec:{...pod().spec,ephemeralContainers:[{...planned.container,image:'foreign'}]}})).toThrow('collision');
 });
 it.each([{podUid:'foreign'},{sourceGatewayId:'builder-one'},{assignmentEpoch:0},{claimStartedAt:0},{image:'registry.example/gateway:latest'}])('rejects authority change %j', change => {
  expect(() => planSourceTransfer({...authority,...change},pod())).toThrow();
 });
 it.each(['shareProcessNamespace','hostPID'])('rejects source pods with %s enabled',flag=>{expect(()=>planSourceTransfer(authority,{...pod(),spec:{...pod().spec,[flag]:true}})).toThrow('isolated process namespace');});
 it('rejects deleting pods and missing shared data mounts', () => {
  expect(() => planSourceTransfer(authority,{...pod(),metadata:{...pod().metadata,deletionTimestamp:'now'}})).toThrow();
  expect(() => planSourceTransfer(authority,{...pod(),spec:{...pod().spec,volumes:[]}})).toThrow();
 });
 it('keeps quiescence on missing, running, replacement or zero-exit without exact receipt', () => {
  const {record} = planSourceTransfer(authority,pod());
  for(const state of [{}, {running:{}}, {terminated:{exitCode:0,message:'{}'}}]) {
   const result = observeSourceTransfer(record,{...pod(),status:{ephemeralContainerStatuses:[{name:record.executionId,state}]}});
   expect(sourceTransferBlocksRelease(result)).toBe(true);
  }
  expect(sourceTransferBlocksRelease(observeSourceTransfer(record,{...pod(),metadata:{...pod().metadata,uid:'replacement'}}))).toBe(true);
 });
 it('requires exact bounded transfer receipt and actual termination before target verification', () => {
  const {record} = planSourceTransfer(authority,pod());
  const receipt = {version:1,executionId:record.executionId,migrationId:record.migrationId,sourcePodUid:record.podUid,status:'transferred'};
  const terminated = (message:string,exitCode=0) => ({...pod(),status:{ephemeralContainerStatuses:[{name:record.executionId,state:{terminated:{exitCode,message}}}]}});
  expect(observeSourceTransfer(record,terminated(JSON.stringify(receipt))).status).toBe('transferred');
  expect(observeSourceTransfer(record,terminated(JSON.stringify({...receipt,migrationId:'other'}))).status).toBe('unresolved');
  expect(observeSourceTransfer(record,terminated('x'.repeat(1025))).status).toBe('unresolved');
  expect(observeSourceTransfer(record,terminated('',1)).status).toBe('failed');
  expect(sourceTransferBlocksRelease(observeSourceTransfer(record,terminated('',1)))).toBe(false);
 });
});
