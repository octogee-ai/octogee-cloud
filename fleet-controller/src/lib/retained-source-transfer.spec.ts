import {describe,expect,it,vi} from 'vitest';
import {createDocumentFixtureStore} from '@octogee/core/testing/journal-store';
import type {SourceTransferFence} from '@octogee/core/platform-state';
import type {UserMigrationV2State,Operation,SourceTransferExecution} from '@octogee/shared/types/glm';
import {createRetainedSourceTransfer} from './retained-source-transfer.js';
import {runGatewayRuntimeExclusive} from './gateway-runtime-mutation.js';

function harness() {
 const state = {phase:'sourceQuiesced',operationId:'op-1',migrationId:'mig-1',uid:'uid-1',slug:'builder',sourceGatewayId:'shared-one',sourceEpoch:3,sourceRelease:1,targetRelease:2,sourceAssignmentMode:'assigned',targetGatewayId:'target'} as UserMigrationV2State;
 const op: Operation = {id:'op-1',kind:'migrate-user',status:'running',createdBy:'test',createdAt:90,startedAt:100,completedAt:null,steps:[],input:{uid:'uid-1',fromGatewayId:'shared-one',toGatewayId:'target',sourceTransferMode:'retained-pod'},userMigrationV2:state};
 const user: {username:string;provisioning:{openclaw:{gatewayId:string;sourceTransferFence?:SourceTransferFence}}} = {username:'builder',provisioning:{openclaw:{gatewayId:'shared-one'}}};
 const assignment={uid:'uid-1',slug:'builder',gatewayId:'shared-one',source:'onboarding',epoch:3,state:'quiescing',updatedByOperationId:'op-1'};
 const docs = new Map<string,Record<string,unknown>>([['glmOperations/op-1',structuredClone(op) as unknown as Record<string,unknown>],['users/uid-1',user],['gateways/shared-one/assignments/uid-1',assignment],['gateways/shared-one',{gatewayId:'shared-one',gatewayClass:'shared',desiredStatus:'running',desiredRelease:1,latestRelease:1,liveRelease:1}],['gateways/target',{gatewayId:'target',gatewayClass:'isolated',desiredStatus:'running',desiredRelease:2,latestRelease:2,liveRelease:2}],['glmGateways/target',{docKind:'runtime',gatewayId:'target',release:2,lifecycle:'serving',runtime:'gce-vm',vm:{instanceId:'instance-2',instanceName:'target',internalIp:'10.0.0.2'}}]]);
 const store=createDocumentFixtureStore(docs);
 const pod={metadata:{name:'source',namespace:'octogee-test',uid:'pod-1',resourceVersion:'5'},spec:{volumes:[{name:'data',emptyDir:{}}],containers:[{name:'gateway',volumeMounts:[{name:'data',mountPath:'/home/node'}]}]},status:{podIP:'10.0.0.1',ephemeralContainerStatuses:[] as unknown[]}};
 const runCommand=vi.fn(async(_command:string,args:string[])=>{
  if(args.includes('patch')) {const patch=JSON.parse(args[args.indexOf('-p')+1]!);const name=patch.at(-1).value.at(-1).name;pod.status.ephemeralContainerStatuses=[{name,state:{running:{}}}];return {code:0,stdout:'',stderr:''};}
  if(args.includes('exec'))return {code:0,stdout:JSON.stringify({sourceMemoryMax:8*1024**3,sourceMemoryCurrent:2*1024**3}),stderr:''};
  return {code:0,stdout:JSON.stringify(args.includes('pods')?{items:[pod]}:pod),stderr:''};
 });
 const prepare=vi.fn(async()=>({migrationId:'mig-1',slug:'builder',rpcPhase:'push-rsync-state' as const,mode:'final' as const,targetHost:'10.0.0.2',targetPort:1234,targetCertificatePem:'certificate',transferUser:'migration',transferKey:'private-test-key',includeActivationManifest:true}));
 const attach=vi.fn(async()=>{});
 const deps={store,namespace:'octogee-test',image:`registry/gateway@sha256:${'a'.repeat(64)}`,runCommand,attach,now:()=>200};
 const input={target:{name:'target',podIP:'10.0.0.2',vm:true},prepare};
 const controller=()=>createRetainedSourceTransfer(deps,{op,state});
 const record=()=>docs.get('glmOperations/op-1')?.sourceTransferExecution as SourceTransferExecution;
 return {state,op,get user(){return docs.get('users/uid-1') as typeof user;},assignment,docs,pod,runCommand,prepare,attach,deps,input,controller,record};
}

describe('retained source controller',()=>{
 it('queues source discovery and reservation but releases the queue before target preparation',async()=>{
  const h=harness();let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const mutation=runGatewayRuntimeExclusive(()=>held);
  h.prepare.mockImplementation(async()=>{
   expect(h.user.provisioning.openclaw).toHaveProperty('sourceTransferFence');
   await runGatewayRuntimeExclusive(async()=>undefined);
   throw new Error('prepared outside queue');
  });
  const transfer=h.controller().execute(h.input);
  await Promise.resolve();
  expect(h.runCommand).not.toHaveBeenCalled();
  expect(h.record()).toBeUndefined();
  release();await mutation;
  await expect(transfer).rejects.toThrow('prepared outside queue');
  expect(h.prepare).toHaveBeenCalledOnce();
  expect(h.user.provisioning.openclaw).toHaveProperty('sourceTransferFence');
 });
 it.each(['source-paused','source-retired','source-retiring','source-unconverged','target-paused','target-retired','target-retiring','target-unconverged','target-wrong-release','target-wrong-class'])('rejects %s before reserving or preparing',async fault=>{
  const h=harness();const root=h.docs.get(fault.startsWith('source')?'gateways/shared-one':'gateways/target')!;
  if(fault.endsWith('paused'))root.desiredStatus='paused';
  if(fault.endsWith('retired'))root.desiredStatus='retired';
  if(fault.endsWith('retiring'))root.retirementClaim={operationId:'retirement'};
  if(fault.endsWith('unconverged'))root.desiredRelease=3;
  if(fault.endsWith('wrong-release')){root.desiredRelease=3;root.liveRelease=3;}
  if(fault.endsWith('wrong-class'))root.gatewayClass='unknown';
  await expect(h.controller().execute(h.input)).rejects.toThrow('authority changed');
  expect(h.prepare).not.toHaveBeenCalled();expect(h.record()).toBeUndefined();
 });
 it.each(['source','target'])('rejects any %s restart fence before prepare',async side=>{
  for(const value of [null,false,{}, {attemptId:'restart'}]) {
    const h=harness();h.docs.get(side==='source'?'gateways/shared-one':'gateways/target')!.runtimeRestartFence=value;
    await expect(h.controller().execute(h.input)).rejects.toThrow('authority changed');expect(h.prepare).not.toHaveBeenCalled();
  }
 });
 it('keeps a crashed or failed prepare ambiguous and never repeats prepare or dispatch',async()=>{
  const h=harness();h.prepare.mockImplementation(async()=>{expect(h.record().status).toBe('preparing');throw new Error('prepare interrupted');});
  await expect(h.controller().execute(h.input)).rejects.toThrow('prepare interrupted');
  expect(h.record().status).toBe('preparing');expect(h.user.provisioning.openclaw).toHaveProperty('sourceTransferFence');
  expect((await h.controller().observe())?.status).toBe('preparing');
  await expect(h.controller().execute(h.input)).rejects.toThrow('observation pending');
  expect(h.prepare).toHaveBeenCalledTimes(1);expect(h.attach).not.toHaveBeenCalled();
 });
 it.each(['reserved','prepared'])('revokes %s before the older claimant can progress',async phase=>{
  const h=harness();let revoked=false;const transaction=h.deps.store.transaction.bind(h.deps.store);
  h.deps.store.transaction=async(options,body)=>{
   const result=await transaction(options,body);
   if(!revoked && h.record()?.status===phase){revoked=true;expect((await h.controller().observe())?.status).toBe('failed');}
   return result;
  };
  await expect(h.controller().execute(h.input)).rejects.toThrow('dispatch authority changed');
  expect(h.record()).toMatchObject({status:'failed',failureReason:'not-dispatched'});
  expect(h.prepare).toHaveBeenCalledTimes(phase==='reserved'?0:1);
  expect(h.user.provisioning.openclaw.sourceTransferFence!==undefined).toBe(phase==='prepared');
  expect(h.attach).not.toHaveBeenCalled();expect(h.runCommand.mock.calls.some(([,args])=>args.includes('patch'))).toBe(false);
 });
 it('settles expired resource admission before dispatch without starting a helper',async()=>{
  const h=harness();const original=h.prepare.getMockImplementation()!;
  h.prepare.mockImplementation(async()=>{h.deps.now=()=>40_000;return original();});
  await expect(h.controller().execute(h.input)).rejects.toThrow('admission expired');
  expect(h.record()).toMatchObject({status:'failed',failureReason:'not-dispatched',targetCleanup:'pending'});expect(h.user.provisioning.openclaw).toHaveProperty('sourceTransferFence');
  expect(h.attach).not.toHaveBeenCalled();expect(h.runCommand.mock.calls.some(([,args])=>args.includes('patch'))).toBe(false);
 });
 it('withholds credentials when cancelled durable custody changes after dispatch but retains the fence until termination',async()=>{
  const h=harness();const original=h.runCommand.getMockImplementation()!;
  h.runCommand.mockImplementation(async(command,args)=>{if(args.includes('patch')){const fresh=h.docs.get('glmOperations/op-1')!;fresh.cancellationRequestedAt=1;(fresh.userMigrationV2 as UserMigrationV2State).phase='preSynced';}return original(command,args);});
  await expect(h.controller().execute(h.input)).rejects.toThrow('active claim changed');
  expect(h.record().status).toBe('dispatched');expect(h.user.provisioning.openclaw).toHaveProperty('sourceTransferFence');expect(h.attach).not.toHaveBeenCalled();
 });
 it('refreshes the same pod resource version after target preparation',async()=>{
  const h=harness();const original=h.prepare.getMockImplementation()!;
  h.prepare.mockImplementation(async()=>{h.pod.metadata.resourceVersion='6';return original();});h.attach.mockRejectedValue(new Error('interrupted'));
  await expect(h.controller().execute(h.input)).rejects.toThrow('interrupted');
  const call=h.runCommand.mock.calls.find(([,args])=>args.includes('patch'))!;const args=call[1];
  expect(JSON.parse(args[args.indexOf('-p')+1]!)).toContainEqual({op:'test',path:'/metadata/resourceVersion',value:'6'});
 });
 it('observes early termination and never sends credentials to a terminated helper',async()=>{
  const h=harness();const original=h.runCommand.getMockImplementation()!;
  h.runCommand.mockImplementation(async(command,args)=>{const result=await original(command,args);if(args.includes('patch')){h.pod.status.ephemeralContainerStatuses=[{name:h.record().executionId,state:{terminated:{exitCode:1}}}];}return result;});
  await expect(h.controller().execute(h.input)).rejects.toThrow('helper failed');
  expect(h.record()).toMatchObject({status:'failed',targetCleanup:'pending'});expect(h.user.provisioning.openclaw).toHaveProperty('sourceTransferFence');expect(h.attach).not.toHaveBeenCalled();
 });
 it('waits through a cold image pull and sends freshly measured admission',async()=>{
  const h=harness();let clock=200;let remaining=35;const original=h.runCommand.getMockImplementation()!;
  h.deps.now=()=>clock;
  Object.assign(h.deps,{wait:async(ms:number)=>{clock+=ms;}});
  h.runCommand.mockImplementation(async(command,args)=>{
   const result=await original(command,args);
   if(args.includes('pod') && !args.includes('patch') && h.record()?.status==='dispatched' && remaining-->0) return {code:0,stdout:JSON.stringify({...h.pod,status:{...h.pod.status,ephemeralContainerStatuses:[]}}),stderr:''};
   return result;
  });
  h.attach.mockImplementation(async(...args:unknown[])=>{
   expect((args[3] as {resourceAdmission:{observedAt:number}}).resourceAdmission.observedAt).toBe(clock);expect(clock).toBeGreaterThan(30_000);
   h.pod.status.ephemeralContainerStatuses=[{name:h.record().executionId,state:{terminated:{exitCode:1}}}];
  });
  await expect(h.controller().execute(h.input)).rejects.toThrow('helper failed');
  expect(h.runCommand.mock.calls.filter(([,args])=>args.includes('exec'))).toHaveLength(2);
 });
 it('keeps dispatched authority fenced when helper startup remains unknown',async()=>{
  const h=harness();let clock=200;const original=h.runCommand.getMockImplementation()!;h.deps.now=()=>clock;
  Object.assign(h.deps,{wait:async(ms:number)=>{clock+=ms;}});
  h.runCommand.mockImplementation(async(command,args)=>{const result=await original(command,args);if(args.includes('pod')&&!args.includes('patch')&&h.record()?.status==='dispatched'){h.pod.status.ephemeralContainerStatuses=[];return {code:0,stdout:JSON.stringify(h.pod),stderr:''};}return result;});
  await expect(h.controller().execute(h.input)).rejects.toThrow('startup observation pending');
  expect(h.record().status).toBe('dispatched');expect(h.user.provisioning.openclaw).toHaveProperty('sourceTransferFence');expect(h.attach).not.toHaveBeenCalled();
 });
 it('never launches or attaches again when the first attach outcome is ambiguous',async()=>{
  const h=harness();h.attach.mockRejectedValue(new Error('attach interrupted'));
  await expect(h.controller().execute(h.input)).rejects.toThrow('attach interrupted');
  await expect(h.controller().execute(h.input)).rejects.toThrow('observation pending');
  expect(h.attach).toHaveBeenCalledTimes(1);expect(h.runCommand.mock.calls.filter(([,args])=>args.includes('patch'))).toHaveLength(1);
  const serialized=JSON.stringify([...h.docs.values()])+JSON.stringify(h.runCommand.mock.calls);
  expect(serialized).not.toContain('private-test-key');expect(serialized).not.toContain('certificate');
 });
 it('clears exactly its user fence after observing terminated matching receipt',async()=>{
  const h=harness();h.attach.mockImplementation(async()=>{
   const r=h.record();h.pod.status.ephemeralContainerStatuses=[{name:r.executionId,state:{terminated:{exitCode:0,message:JSON.stringify({version:1,executionId:r.executionId,migrationId:r.migrationId,sourcePodUid:r.podUid,status:'transferred'})}}}];
  });
  expect((await h.controller().execute(h.input)).status).toBe('transferred');
  expect(h.user.provisioning.openclaw).not.toHaveProperty('sourceTransferFence');
  expect((await h.controller().execute(h.input)).status).toBe('transferred');expect(h.attach).toHaveBeenCalledTimes(1);
 });
 it('rejects a saved transferred result after its operation claim changes',async()=>{
  const h=harness();h.attach.mockImplementation(async()=>{const r=h.record();h.pod.status.ephemeralContainerStatuses=[{name:r.executionId,state:{terminated:{exitCode:0,message:JSON.stringify({version:1,executionId:r.executionId,migrationId:r.migrationId,sourcePodUid:r.podUid,status:'transferred'})}}}];});
  await h.controller().execute(h.input);h.docs.get('glmOperations/op-1')!.startedAt=101;
  await expect(h.controller().execute(h.input)).rejects.toThrow('active claim');
 });
 it('keeps the fence for zero exit without a valid receipt',async()=>{
  const h=harness();h.attach.mockImplementation(async()=>{h.pod.status.ephemeralContainerStatuses=[{name:h.record().executionId,state:{terminated:{exitCode:0,message:'{}'}}}];});
  await expect(h.controller().execute(h.input)).rejects.toThrow('observation pending');
  expect(h.record().status).toBe('unresolved');expect(h.user.provisioning.openclaw).toHaveProperty('sourceTransferFence');
 });
 it('never clears another execution fence even when this helper has terminated',async()=>{
  const h=harness();h.attach.mockImplementation(async()=>{
   Object.assign(h.user.provisioning.openclaw,{sourceTransferFence:{executionId:'foreign'}});
   h.pod.status.ephemeralContainerStatuses=[{name:h.record().executionId,state:{terminated:{exitCode:1,message:''}}}];
  });
  await expect(h.controller().execute(h.input)).rejects.toThrow('helper failed');
  await expect(h.controller().acknowledgeCleanup(h.record())).rejects.toThrow('user fence changed');
  expect(h.user.provisioning.openclaw).toHaveProperty('sourceTransferFence',{executionId:'foreign'});
  expect(h.record().status).toBe('failed');
 });
 it('clears its exact fence only after nonzero termination and target cleanup acknowledgement',async()=>{
  const h=harness();h.attach.mockImplementation(async()=>{h.pod.status.ephemeralContainerStatuses=[{name:h.record().executionId,state:{terminated:{exitCode:1,message:''}}}];});
  await expect(h.controller().execute(h.input)).rejects.toThrow('helper failed');
  expect(h.record()).toMatchObject({status:'failed',targetCleanup:'pending'});expect(h.user.provisioning.openclaw).toHaveProperty('sourceTransferFence');
  await h.controller().acknowledgeCleanup(h.record());
  expect(h.user.provisioning.openclaw).not.toHaveProperty('sourceTransferFence');
 });
 it.each(['cancelled','reclaimed'])('settles cleanup only for the current claim when %s',async situation=>{
  const h=harness();h.attach.mockImplementation(async()=>{h.pod.status.ephemeralContainerStatuses=[{name:h.record().executionId,state:{terminated:{exitCode:1,message:''}}}];});
  await expect(h.controller().execute(h.input)).rejects.toThrow('helper failed');
  const op=h.docs.get('glmOperations/op-1')!;
  if(situation==='cancelled')op.cancellationRequestedAt=201;else op.startedAt=101;
  if(situation==='cancelled') {
    await expect(h.controller().settledTarget(h.input.target)).resolves.toMatchObject({targetCleanup:'pending'});
    await h.controller().acknowledgeCleanup(h.record());
    expect(h.user.provisioning.openclaw).not.toHaveProperty('sourceTransferFence');
  } else {
    await expect(h.controller().settledTarget(h.input.target)).rejects.toThrow('active claim');
    await expect(h.controller().acknowledgeCleanup(h.record())).rejects.toThrow('active claim');
    expect(h.user.provisioning.openclaw).toHaveProperty('sourceTransferFence');
  }
 });
 it('does not let a stale running observation overwrite a concurrent terminal observation',async()=>{
  const h=harness();h.attach.mockRejectedValue(new Error('interrupted'));await expect(h.controller().execute(h.input)).rejects.toThrow();
  h.runCommand.mockImplementation(async()=>{h.docs.get('glmOperations/op-1')!.sourceTransferExecution={...h.record(),status:'transferred'};return {code:0,stdout:JSON.stringify(h.pod),stderr:''};});
  expect((await h.controller().observe())?.status).toBe('transferred');expect(h.record().status).toBe('transferred');
 });
 it('refuses to finish a transfer into a replaced target instance',async()=>{
  const h=harness();h.attach.mockRejectedValue(new Error('interrupted'));await expect(h.controller().execute(h.input)).rejects.toThrow();
  h.docs.set('glmGateways/target',{...h.docs.get('glmGateways/target'),vm:{instanceId:'replacement',instanceName:'target',internalIp:'10.0.0.2'}});
  await expect(h.controller().execute(h.input)).rejects.toThrow('target identity changed');expect(h.prepare).toHaveBeenCalledTimes(1);
 });
 it.each(['claim','cancel','slug','epoch','state','owner','root','retirement','stopped','restore','existing-fence'])('rejects changed %s authority before target prepare',async change=>{
  const h=harness();const op=h.docs.get('glmOperations/op-1')!;
  if(change==='claim')op.startedAt=101;
  if(change==='cancel'){op.cancellationRequestedAt=1;(op.userMigrationV2 as UserMigrationV2State).phase='preSynced';}
  if(change==='slug')h.user.username='other';
  if(change==='epoch')h.assignment.epoch=4;
  if(change==='state')h.assignment.state='serving';
  if(change==='owner')h.assignment.updatedByOperationId='other';
  if(change==='root')h.docs.set('gateways/shared-one',{...h.docs.get('gateways/shared-one'),gatewayClass:'isolated'});
  if(change==='retirement')Object.assign(h.docs.get('gateways/shared-one')!,{retirementClaim:{operationId:'retire'}});
  if(change==='stopped')Object.assign(h.docs.get('gateways/shared-one')!,{desiredStatus:'retired'});
  if(change==='restore')Object.assign(h.user.provisioning.openclaw,{restoreFence:{}});
  if(change==='existing-fence')Object.assign(h.user.provisioning.openclaw,{sourceTransferFence:{}});
  await expect(h.controller().execute(h.input)).rejects.toThrow('authority changed');expect(h.prepare).not.toHaveBeenCalled();expect(h.attach).not.toHaveBeenCalled();
 });
});

describe('retained source forward continuation',()=>{
 it.each(['reservation','preparation','dispatch','completion'])('finishes the exact durable transfer when cancellation arrives during %s',async at=>{
  const h=harness();const cancel=()=>{h.docs.get('glmOperations/op-1')!.cancellationRequestedAt=201;};
  if(at==='reservation')cancel();
  const prepare=h.prepare.getMockImplementation()!;
  h.prepare.mockImplementation(async()=>{if(at==='preparation'){cancel();}return prepare();});
  const run=h.runCommand.getMockImplementation()!;
  h.runCommand.mockImplementation(async(command,args)=>{const result=await run(command,args);if(at==='dispatch'&&args.includes('patch')){cancel();}return result;});
  h.attach.mockImplementation(async()=>{
   if(at==='completion')cancel();
   const r=h.record();h.pod.status.ephemeralContainerStatuses=[{name:r.executionId,state:{terminated:{exitCode:0,message:JSON.stringify({version:1,executionId:r.executionId,migrationId:r.migrationId,sourcePodUid:r.podUid,status:'transferred'})}}}];
  });
  expect((await h.controller().execute(h.input)).status).toBe('transferred');
  await expect(h.controller().assertActiveClaim()).resolves.toBeUndefined();
  expect(h.user.provisioning.openclaw).not.toHaveProperty('sourceTransferFence');
  expect((await h.controller().execute(h.input)).status).toBe('transferred');
  expect(h.prepare).toHaveBeenCalledOnce();expect(h.attach).toHaveBeenCalledOnce();
 });
 it.each(['phase','claim','operation','migration','uid','slug','source','target','epoch'])('rejects cancelled continuation after its durable %s changes',async fault=>{
  const h=harness();const fresh=h.docs.get('glmOperations/op-1')!;fresh.cancellationRequestedAt=201;
  const durable=fresh.userMigrationV2 as Record<string,unknown>;
  if(fault==='phase')durable.phase='preSynced';
  if(fault==='claim')fresh.startedAt=101;
  const field={operation:'operationId',migration:'migrationId',uid:'uid',slug:'slug',source:'sourceGatewayId',target:'targetGatewayId',epoch:'sourceEpoch'}[fault];
  if(field)durable[field]=field==='sourceEpoch'?4:'other';
  await expect(h.controller().assertActiveClaim()).rejects.toThrow('active claim changed');
  await expect(h.controller().execute(h.input)).rejects.toThrow('authority changed');
  expect(h.prepare).not.toHaveBeenCalled();expect(h.attach).not.toHaveBeenCalled();
 });
});
