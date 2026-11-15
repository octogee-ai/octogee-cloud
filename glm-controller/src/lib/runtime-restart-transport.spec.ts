import {describe,it,expect} from 'vitest';
import {createDocumentFixtureStore} from '@octogee/core/testing/journal-store';
import type {KubectlSubprocess,KubectlSubprocessResult} from '../fleet-ingress.js';
import {deploymentRestartComplete,restartGatewayProcess,validateProcessRestartReceipt} from './runtime-restart-transport.js';
import {assertMigrationRestartUnfenced,type RuntimeRestartFence} from './runtime-restart-coordinator.js';

describe('runtime restart positive completion proof',()=>{
 it.each([{}, {version:1,attemptId:'attempt',beforeBootId:'before',afterBootId:'before',ready:true},{version:1,attemptId:'other',beforeBootId:'before',afterBootId:'after',ready:true},{version:1,attemptId:'attempt',beforeBootId:'before',afterBootId:'after',ready:false}])('rejects incomplete or mismatched process receipts %j',receipt=>{
  expect(()=>validateProcessRestartReceipt(receipt,'attempt')).toThrow('completion unverified');
 });
 it('accepts only distinct boot IDs for the exact attempt',()=>{
  expect(()=>validateProcessRestartReceipt({version:1,attemptId:'attempt',beforeBootId:'before',afterBootId:'after',ready:true},'attempt')).not.toThrow();
 });
 it.each(['ready','old-pod','wrong-owner','unready','wrong-token','wrong-generation','wrong-deployment'])('requires exact rollout completion for %s',fault=>{
  const fence:RuntimeRestartFence={attemptId:'attempt',auditId:'audit',gatewayId:'gateway',kind:'deployment',phase:'acknowledged',startedAt:1,target:{deploymentUid:'deployment',oldPodUids:['old']},acknowledgement:{generation:2}};
  const deployment={metadata:{uid:'deployment',name:'deployment',resourceVersion:'2',generation:2},spec:{replicas:1,template:{metadata:{annotations:{'octogee.com/runtime-restart-attempt':'attempt'}}}},status:{observedGeneration:2,updatedReplicas:1,readyReplicas:1,availableReplicas:1}};
  const pod={metadata:{uid:'new',name:'pod',resourceVersion:'2',annotations:{'octogee.com/runtime-restart-attempt':'attempt'},ownerReferences:[{uid:'replica-set'}]},status:{conditions:[{type:'Ready',status:'True'}]}};
  const replicaSet={metadata:{uid:'replica-set',name:'replica-set',resourceVersion:'2',ownerReferences:[{uid:'deployment'}]}};
  if(fault==='old-pod')pod.metadata.uid='old';
  if(fault==='wrong-owner')pod.metadata.ownerReferences=[{uid:'foreign'}];
  if(fault==='unready')pod.status.conditions=[];
  if(fault==='wrong-token')pod.metadata.annotations['octogee.com/runtime-restart-attempt']='other';
  if(fault==='wrong-generation')deployment.status.observedGeneration=1;
  if(fault==='wrong-deployment')deployment.metadata.uid='replaced';
  expect(deploymentRestartComplete(deployment,[pod],[replicaSet],fence)).toBe(fault==='ready');
 });
});

const BOUND_POD={podName:'octogee-gateway-gw-1-abc',podUid:'uid-bound'};
type BoundPodState='running'|'gone'|'replaced'|'failed'|'unobservable';
function boundPodRead(state:BoundPodState):KubectlSubprocessResult {
 if(state==='gone')return {code:0,stdout:'',stderr:''};
 if(state==='unobservable')return {code:1,stdout:'',stderr:'Unable to connect to the server: i/o timeout'};
 const pod={metadata:{name:BOUND_POD.podName,uid:state==='replaced'?'uid-replacement':BOUND_POD.podUid,resourceVersion:'2'},status:{phase:state==='failed'?'Failed':'Running'}};
 return {code:0,stdout:JSON.stringify(pod),stderr:''};
}
function restartHarness(boundPod:BoundPodState,fence?:RuntimeRestartFence) {
 const store=createDocumentFixtureStore({'gateways/gw-1':{gatewayId:'gw-1',gatewayClass:'isolated',desiredStatus:'running',liveRelease:1,desiredRelease:1,latestRelease:1,...(fence?{runtimeRestartFence:fence}:{})}});
 const calls:string[][]=[];
 const runKubectl:KubectlSubprocess=async args=>{
  calls.push(args);
  if(args.includes('exec'))return {code:1,stdout:'',stderr:'error: unable to upgrade connection: Forbidden'};
  if(args.includes('pods'))return {code:0,stdout:JSON.stringify({items:[{metadata:{name:BOUND_POD.podName,uid:BOUND_POD.podUid,resourceVersion:'1'},status:{phase:'Running'}}]}),stderr:''};
  return boundPodRead(boundPod);
 };
 const savedFence=async()=>(await store.gateways.roots.get('gw-1'))?.runtimeRestartFence;
 const migrationClaim=()=>assertMigrationRestartUnfenced(store,{uid:'user-1',fromGatewayId:'shared-b',toGatewayId:'gw-1'});
 return {store,calls,savedFence,migrationClaim,deps:{store,namespace:'octogee',runKubectl}};
}
const DISPATCHED:RuntimeRestartFence={attemptId:'attempt-1',auditId:'audit-1',gatewayId:'gw-1',kind:'process',startedAt:1,phase:'dispatched',target:BOUND_POD};

describe('a process restart whose dispatch failed',()=>{
 it('keeps the fence and reports the restart driver stderr while the bound pod still runs',async()=>{
  const h=restartHarness('running');
  await expect(restartGatewayProcess(h.deps,'gw-1')).rejects.toThrow(/unable to upgrade connection: Forbidden.*bound pod octogee-gateway-gw-1-abc still runs/);
  expect(await h.savedFence()).toMatchObject({phase:'dispatched',target:BOUND_POD});
  await expect(h.migrationClaim()).rejects.toThrow('restart outcome is unresolved');
 });
 it.each(['gone','replaced','failed'] as const)('clears the fence when the bound pod is %s',async boundPod=>{
  const h=restartHarness(boundPod);
  await expect(restartGatewayProcess(h.deps,'gw-1')).rejects.toThrow('unable to upgrade connection: Forbidden');
  expect(await h.savedFence()).toBeUndefined();
  await expect(h.migrationClaim()).resolves.toBeUndefined();
 });
 it('keeps the fence and names the Kubernetes failure when the bound pod cannot be read',async()=>{
  const h=restartHarness('unobservable');
  await expect(restartGatewayProcess(h.deps,'gw-1')).rejects.toThrow(/Forbidden.*observation unavailable.*i\/o timeout/);
  expect(await h.savedFence()).toMatchObject({phase:'dispatched'});
 });
});

describe('a later restart of a gateway left with a dispatched process fence',()=>{
 it.each(['gone','replaced','failed'] as const)('clears the fence without dispatching again when the bound pod is %s',async boundPod=>{
  const h=restartHarness(boundPod,DISPATCHED);
  await expect(h.migrationClaim()).rejects.toThrow('restart outcome is unresolved');
  await restartGatewayProcess(h.deps,'gw-1');
  expect(await h.savedFence()).toBeUndefined();
  expect(h.calls.filter(args=>args.includes('exec'))).toEqual([]);
  await expect(h.migrationClaim()).resolves.toBeUndefined();
 });
 it('keeps the fence while the bound pod still runs',async()=>{
  const h=restartHarness('running',DISPATCHED);
  await expect(restartGatewayProcess(h.deps,'gw-1')).rejects.toThrow('bound pod octogee-gateway-gw-1-abc still runs');
  expect(await h.savedFence()).toEqual(DISPATCHED);
  expect(h.calls.filter(args=>args.includes('exec'))).toEqual([]);
 });
 it('keeps a dispatched fence that names no bound pod',async()=>{
  const {target:_target,...unbound}=DISPATCHED;
  const h=restartHarness('gone',unbound);
  await expect(restartGatewayProcess(h.deps,'gw-1')).rejects.toThrow('bound pod unavailable');
  expect(await h.savedFence()).toEqual(unbound);
 });
});
