import type {PlatformStateStore} from '@octogee/core/platform-state';
import type {KubectlSubprocess,KubectlSubprocessResult} from '../fleet-ingress.js';
import {coordinateRuntimeRestart, type RuntimeRestartFence, type RuntimeRestartObservation} from './runtime-restart-coordinator.js';
import {managementHealthDriverSource,runtimeRestartDriverSource} from './runtime-restart-driver.js';

interface KubeObject {metadata:{uid:string;name:string;resourceVersion:string;generation?:number;deletionTimestamp?:string;annotations?:Record<string,string>;ownerReferences?:Array<{uid:string}>};spec?:{replicas?:number;template?:{metadata?:{annotations?:Record<string,string>}}};status?:{phase?:string;observedGeneration?:number;updatedReplicas?:number;readyReplicas?:number;availableReplicas?:number;conditions?:Array<{type:string;status:string}>}}
interface Deps {store:PlatformStateStore;namespace:string;runKubectl:KubectlSubprocess;now?:()=>number;wait?:(ms:number)=>Promise<void>}
const TOKEN='octogee.com/runtime-restart-attempt';
function kubectlFailure(result:KubectlSubprocessResult):string {
  const stderr=result.stderr.trim().slice(0,4096);
  return stderr ? `exit ${result.code}: ${stderr}` : `exit ${result.code}`;
}
async function json(deps:Deps,args:string[]):Promise<KubeObject> {
  const result=await deps.runKubectl(['-n',deps.namespace,...args,'-o','json'],{timeoutMs:15_000});
  if(result.code!==0)throw new Error(`gateway restart Kubernetes observation unavailable (${kubectlFailure(result)})`);
  return JSON.parse(result.stdout) as KubeObject;
}
async function optionalJson(deps:Deps,args:string[]):Promise<KubeObject|null> {
  const result=await deps.runKubectl(['-n',deps.namespace,...args,'--ignore-not-found','-o','json'],{timeoutMs:15_000});
  if(result.code!==0)throw new Error(`gateway restart Kubernetes observation unavailable (${kubectlFailure(result)})`);
  return result.stdout.trim()==='' ? null : JSON.parse(result.stdout) as KubeObject;
}
async function list(deps:Deps,resource:string,gatewayId:string):Promise<KubeObject[]> {
  const result=await json(deps,['get',resource,'-l',`gateway-instance=${gatewayId}`]);
  return (result as unknown as {items:KubeObject[]}).items;
}
export function validateProcessRestartReceipt(value:unknown,attemptId:string):void {
  const receipt=value as Record<string,unknown>|null;
  if(!receipt || receipt.version!==1 || receipt.attemptId!==attemptId || receipt.ready!==true || typeof receipt.beforeBootId!=='string' || typeof receipt.afterBootId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.beforeBootId) || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.afterBootId) || receipt.beforeBootId===receipt.afterBootId)throw new Error('gateway process restart completion unverified');
}
function validateManagementHealthReceipt(value:unknown,attemptId:string):string {
  const receipt=value as Record<string,unknown>|null;
  if(!receipt || receipt.version!==1 || receipt.attemptId!==attemptId || receipt.health!==true || typeof receipt.bootId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.bootId))throw new Error('gateway management health receipt invalid');
  return receipt.bootId;
}
async function probeGatewayBoot(deps:Deps,podName:string,attemptId:string):Promise<string> {
  const result=await deps.runKubectl(['-n',deps.namespace,'exec',podName,'-c','gateway','-i','--','node','--input-type=commonjs','-',attemptId],{stdin:managementHealthDriverSource(),timeoutMs:50_000});
  if(result.code!==0)throw new Error(`gateway management health unconfirmed (${kubectlFailure(result)})`);
  return validateManagementHealthReceipt(JSON.parse(result.stdout.trim()),attemptId);
}
export async function restartGatewayProcess(deps:Deps,gatewayId:string):Promise<void> {
  await coordinateRuntimeRestart(deps.store,gatewayId,'process',async(fence,save)=>{
    const pods=await list(deps,'pods',gatewayId);
    if(pods.length!==1 || pods[0]?.metadata.deletionTimestamp || pods[0]?.status?.phase!=='Running')throw new Error('gateway process restart requires one running pod');
    const pod=pods[0]!;
    const beforeBootId=await probeGatewayBoot(deps,pod.metadata.name,fence.attemptId);
    const bound={...fence,target:{podName:pod.metadata.name,podUid:pod.metadata.uid,beforeBootId}};await save(bound);
    await save({...bound,phase:'dispatched'});
    const result=await deps.runKubectl(['-n',deps.namespace,'exec',pod.metadata.name,'-c','gateway','-i','--','node','--input-type=commonjs','-',fence.attemptId],{stdin:runtimeRestartDriverSource(),timeoutMs:210_000});
    if(result.code!==0)throw new Error(`gateway process restart outcome is unresolved (${kubectlFailure(result)})`);
    const receipt=JSON.parse(result.stdout.trim()) as Record<string,unknown>;
    validateProcessRestartReceipt(receipt,fence.attemptId);
    const current=await json(deps,['get','pod',pod.metadata.name]);
    if(current.metadata.uid!==pod.metadata.uid || current.metadata.deletionTimestamp)throw new Error('gateway restarted pod identity changed');
    await save({...bound,phase:'acknowledged',acknowledgement:receipt});
  },fence=>observeRuntimeRestart(deps,fence));
}
function deploymentMatches(deployment:KubeObject,fence:RuntimeRestartFence):boolean {
  const desired=deployment.spec?.replicas??0;const status=deployment.status;
  return [deployment.metadata.uid===fence.target?.deploymentUid,deployment.metadata.generation===fence.acknowledgement?.generation,
    deployment.spec?.template?.metadata?.annotations?.[TOKEN]===fence.attemptId,
    (status?.observedGeneration??0)>=(fence.acknowledgement?.generation as number),desired>0,
    status?.updatedReplicas===desired,status?.readyReplicas===desired,status?.availableReplicas===desired].every(Boolean);
}
export function deploymentRestartComplete(deployment:KubeObject,pods:KubeObject[],replicaSets:KubeObject[],fence:RuntimeRestartFence):boolean {
  const target=fence.target!;const old=target.oldPodUids as string[];
  const owned=new Set(replicaSets.filter(rs=>rs.metadata.ownerReferences?.some(owner=>owner.uid===target.deploymentUid)).map(rs=>rs.metadata.uid));
  return deploymentMatches(deployment,fence) && pods.length===deployment.spec?.replicas && pods.every(pod=>[
    !old.includes(pod.metadata.uid),!pod.metadata.deletionTimestamp,pod.metadata.annotations?.[TOKEN]===fence.attemptId,
    pod.metadata.ownerReferences?.some(owner=>owned.has(owner.uid)),pod.status?.conditions?.some(condition=>condition.type==='Ready'&&condition.status==='True'),
  ].every(Boolean));
}
function validateDeployment(deployment:KubeObject):void {
  if(deployment.metadata.deletionTimestamp || !deployment.metadata.uid || !deployment.metadata.resourceVersion || !Number.isSafeInteger(deployment.metadata.generation))throw new Error('gateway deployment restart identity unavailable');
}
function validateDeploymentAcknowledgement(before:KubeObject,updated:KubeObject,attemptId:string):void {
  if(updated.metadata.uid!==before.metadata.uid || (updated.metadata.generation??0)<=before.metadata.generation! || updated.spec?.template?.metadata?.annotations?.[TOKEN]!==attemptId)throw new Error('gateway deployment restart acknowledgement mismatch');
}
async function waitForDeployment(deps:Deps,name:string,gatewayId:string,fence:RuntimeRestartFence):Promise<void> {
  const now=deps.now??Date.now;const wait=deps.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));const deadline=now()+180_000;
  while(now()<deadline) {
    const [current,pods,replicaSets]=await Promise.all([json(deps,['get','deployment',name]),list(deps,'pods',gatewayId),list(deps,'replicasets',gatewayId)]);
    if(deploymentRestartComplete(current,pods,replicaSets,fence))return;
    await wait(1000);
  }
  throw new Error('gateway deployment restart outcome is unresolved');
}
export async function restartGatewayDeployment(deps:Deps,gatewayId:string):Promise<void> {
  await coordinateRuntimeRestart(deps.store,gatewayId,'deployment',async(fence,save)=>{
    const name=`octogee-gateway-${gatewayId}`;
    const [deployment,pods]=await Promise.all([json(deps,['get','deployment',name]),list(deps,'pods',gatewayId)]);
    validateDeployment(deployment);
    const bound={...fence,target:{deploymentName:name,deploymentUid:deployment.metadata.uid,beforeGeneration:deployment.metadata.generation!,beforeResourceVersion:deployment.metadata.resourceVersion,oldPodUids:pods.map(pod=>pod.metadata.uid)}};
    await save(bound);
    const annotations={...deployment.spec?.template?.metadata?.annotations,[TOKEN]:fence.attemptId};
    const patch=[{op:'test',path:'/metadata/uid',value:deployment.metadata.uid},{op:'test',path:'/metadata/resourceVersion',value:deployment.metadata.resourceVersion},{op:'add',path:'/spec/template/metadata/annotations',value:annotations}];
    await save({...bound,phase:'dispatched'});
    const updated=await json(deps,['patch','deployment',name,'--type=json','-p',JSON.stringify(patch)]);
    validateDeploymentAcknowledgement(deployment,updated,fence.attemptId);
    const acknowledged:RuntimeRestartFence={...bound,phase:'acknowledged',acknowledgement:{generation:updated.metadata.generation!}};await save(acknowledged);
    await waitForDeployment(deps,name,gatewayId,acknowledged);
  },fence=>observeRuntimeRestart(deps,fence));
}

async function observeDispatchedProcess(deps:Deps,fence:RuntimeRestartFence):Promise<void> {
  const target=fence.target;
  if(typeof target?.podName!=='string' || typeof target.podUid!=='string')throw new Error('gateway restart bound pod unavailable');
  const pod=await optionalJson(deps,['get','pod',target.podName]);
  if(!pod || pod.metadata.uid!==target.podUid || ['Succeeded','Failed'].includes(pod.status?.phase??''))return;
  if(typeof target.beforeBootId!=='string')throw new Error(`gateway process restart outcome is unresolved while its bound pod ${target.podName} still runs`);
  if(await probeGatewayBoot(deps,target.podName,fence.attemptId)===target.beforeBootId)throw new Error(`gateway process restart outcome is unresolved while its bound pod ${target.podName} still runs boot ${target.beforeBootId}`);
}
async function observeDispatchedDeployment(deps:Deps,fence:RuntimeRestartFence):Promise<RuntimeRestartObservation> {
  const target=fence.target;
  if(typeof target?.deploymentName!=='string' || typeof target.deploymentUid!=='string' || typeof target.beforeResourceVersion!=='string')throw new Error('gateway restart bound deployment unavailable');
  const deployment=await optionalJson(deps,['get','deployment',target.deploymentName]);
  if(!deployment || deployment.metadata.uid!==target.deploymentUid)return 'completed';
  if(deployment.spec?.template?.metadata?.annotations?.[TOKEN]===fence.attemptId) {
    validateDeployment(deployment);
    await waitForDeployment(deps,target.deploymentName,fence.gatewayId,{...fence,phase:'acknowledged',acknowledgement:{generation:deployment.metadata.generation!}});
    return 'completed';
  }
  if(deployment.metadata.resourceVersion===target.beforeResourceVersion)throw new Error(`gateway deployment restart outcome is unresolved while deployment ${target.deploymentName} is unchanged`);
  return 'abandoned';
}
export async function observeRuntimeRestart(deps:Deps,fence:RuntimeRestartFence):Promise<RuntimeRestartObservation> {
  if(fence.kind==='process' && fence.phase==='dispatched'){await observeDispatchedProcess(deps,fence);return 'completed';}
  if(fence.kind==='deployment' && fence.phase==='dispatched')return observeDispatchedDeployment(deps,fence);
  if(fence.phase!=='acknowledged')throw new Error('gateway restart dispatch is unresolved');
  if(fence.kind==='process') {
    validateProcessRestartReceipt(fence.acknowledgement,fence.attemptId);
    const target=fence.target;
    if(typeof target?.podName!=='string' || typeof target.podUid!=='string')throw new Error('gateway restart bound pod unavailable');
    const pod=await json(deps,['get','pod',target.podName]);
    if(pod.metadata.uid!==target.podUid || pod.metadata.deletionTimestamp)throw new Error('gateway restarted pod identity changed');
    return 'completed';
  }
  if(fence.kind!=='deployment' || typeof fence.target?.deploymentName!=='string')throw new Error('gateway restart kind unavailable');
  await waitForDeployment(deps,fence.target.deploymentName,fence.gatewayId,fence);
  return 'completed';
}
