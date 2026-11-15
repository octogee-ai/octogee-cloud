import {describe,it,expect} from 'vitest';
import {createDocumentFixtureStore} from '@octogee/core/testing/journal-store';
import type {KubectlSubprocess,KubectlSubprocessResult} from '../fleet-ingress.js';
import {deploymentRestartComplete,restartGatewayDeployment,restartGatewayProcess,validateProcessRestartReceipt} from './runtime-restart-transport.js';
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

const DEPLOYMENT='octogee-gateway-gw-1';
const TOKEN_KEY='octogee.com/runtime-restart-attempt';
type DeploymentAfter='gone'|'replaced'|'applied'|'moved'|'unchanged'|'unobservable';
function deploymentHarness(after:DeploymentAfter,fence?:RuntimeRestartFence) {
 const store=createDocumentFixtureStore({'gateways/gw-1':{gatewayId:'gw-1',gatewayClass:'shared',desiredStatus:'running',liveRelease:1,desiredRelease:1,latestRelease:1,...(fence?{runtimeRestartFence:fence}:{})}});
 const calls:string[][]=[];
 let patchSent=fence!==undefined;
 const before={metadata:{name:DEPLOYMENT,uid:'deployment-uid',resourceVersion:'10',generation:3},spec:{replicas:1,template:{metadata:{annotations:{}}}},status:{observedGeneration:3,updatedReplicas:1,readyReplicas:1,availableReplicas:1}};
 const ok=(value:unknown):KubectlSubprocessResult=>({code:0,stdout:JSON.stringify(value),stderr:''});
 const runKubectl:KubectlSubprocess=async args=>{
  calls.push(args);
  const savedAttempt=String((await store.gateways.roots.get('gw-1'))?.runtimeRestartFence?.attemptId??fence?.attemptId??'');
  const applied={metadata:{name:DEPLOYMENT,uid:'deployment-uid',resourceVersion:'12',generation:4},spec:{replicas:1,template:{metadata:{annotations:{[TOKEN_KEY]:savedAttempt}}}},status:{observedGeneration:4,updatedReplicas:1,readyReplicas:1,availableReplicas:1}};
  if(args.includes('patch')){patchSent=true;return {code:1,stdout:'',stderr:'The request is invalid: the server rejected our request due to an error in our request'};}
  if(args.includes('replicasets'))return ok({items:[{metadata:{name:'rs',uid:'rs-uid',resourceVersion:'1',ownerReferences:[{uid:'deployment-uid'}]}}]});
  if(args.includes('pods'))return ok({items:patchSent&&after==='applied'
   ?[{metadata:{name:'new-pod',uid:'new-pod-uid',resourceVersion:'1',annotations:{[TOKEN_KEY]:savedAttempt},ownerReferences:[{uid:'rs-uid'}]},status:{conditions:[{type:'Ready',status:'True'}]}}]
   :[{metadata:{name:'old-pod',uid:'old-pod-uid',resourceVersion:'1'}}]});
  if(!patchSent)return ok(before);
  if(after==='unobservable')return {code:1,stdout:'',stderr:'Unable to connect to the server: i/o timeout'};
  if(after==='gone')return {code:0,stdout:'',stderr:''};
  if(after==='replaced')return ok({...before,metadata:{...before.metadata,uid:'replacement-uid'}});
  if(after==='applied')return ok(applied);
  if(after==='moved')return ok({...before,metadata:{...before.metadata,resourceVersion:'11'}});
  return ok(before);
 };
 const savedFence=async()=>(await store.gateways.roots.get('gw-1'))?.runtimeRestartFence;
 return {store,calls,savedFence,deps:{store,namespace:'octogee',runKubectl,now:(()=>{let t=0;return()=>t++;})(),wait:async()=>{}}};
}
const DISPATCHED_DEPLOYMENT:RuntimeRestartFence={attemptId:'attempt-2',auditId:'audit-2',gatewayId:'gw-1',kind:'deployment',startedAt:1,phase:'dispatched',
 target:{deploymentName:DEPLOYMENT,deploymentUid:'deployment-uid',beforeGeneration:3,beforeResourceVersion:'10',oldPodUids:['old-pod-uid']}};

describe('a deployment restart whose patch failed',()=>{
 it.each(['gone','replaced','applied','moved'] as const)('clears the fence when the deployment is %s',async after=>{
  const h=deploymentHarness(after);
  await expect(restartGatewayDeployment(h.deps,'gw-1')).rejects.toThrow('server rejected our request');
  expect(await h.savedFence()).toBeUndefined();
 });
 it('keeps the fence while the deployment is unchanged since the guarded patch',async()=>{
  const h=deploymentHarness('unchanged');
  await expect(restartGatewayDeployment(h.deps,'gw-1')).rejects.toThrow(/server rejected our request.*deployment octogee-gateway-gw-1 is unchanged/);
  expect(await h.savedFence()).toMatchObject({phase:'dispatched',target:{beforeResourceVersion:'10'}});
 });
 it('keeps the fence when the deployment cannot be read',async()=>{
  const h=deploymentHarness('unobservable');
  await expect(restartGatewayDeployment(h.deps,'gw-1')).rejects.toThrow(/server rejected our request.*i\/o timeout/);
  expect(await h.savedFence()).toMatchObject({phase:'dispatched'});
 });
});

describe('a later restart of a gateway left with a dispatched deployment fence',()=>{
 it.each(['gone','replaced','applied'] as const)('clears the fence as complete when the deployment is %s',async after=>{
  const h=deploymentHarness(after,DISPATCHED_DEPLOYMENT);
  await restartGatewayProcess(h.deps,'gw-1');
  expect(await h.savedFence()).toBeUndefined();
  expect(h.calls.filter(args=>args.includes('patch')||args.includes('exec'))).toEqual([]);
 });
 it('clears the fence but reports that the restart never took effect when the guarded patch can no longer apply',async()=>{
  const h=deploymentHarness('moved',DISPATCHED_DEPLOYMENT);
  await expect(restartGatewayProcess(h.deps,'gw-1')).rejects.toThrow('restart attempt-2 never took effect');
  expect(await h.savedFence()).toBeUndefined();
  expect(h.calls.filter(args=>args.includes('patch')||args.includes('exec'))).toEqual([]);
 });
 it('keeps the fence while the deployment is unchanged',async()=>{
  const h=deploymentHarness('unchanged',DISPATCHED_DEPLOYMENT);
  await expect(restartGatewayProcess(h.deps,'gw-1')).rejects.toThrow('deployment octogee-gateway-gw-1 is unchanged');
  expect(await h.savedFence()).toEqual(DISPATCHED_DEPLOYMENT);
 });
 it('keeps a dispatched fence that names no guarded resource version',async()=>{
  const {beforeResourceVersion:_version,...target}=DISPATCHED_DEPLOYMENT.target!;
  const fence={...DISPATCHED_DEPLOYMENT,target};
  const h=deploymentHarness('moved',fence);
  await expect(restartGatewayProcess(h.deps,'gw-1')).rejects.toThrow('bound deployment unavailable');
  expect(await h.savedFence()).toEqual(fence);
 });
});
