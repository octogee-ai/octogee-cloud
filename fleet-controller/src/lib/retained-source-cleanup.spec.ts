import {describe,expect,it,vi} from 'vitest';
import {createDocumentFixtureStore} from '@octogee/core/testing/journal-store';
import type {SourceTransferExecution} from '@octogee/shared/types/glm';
import {FLEET_KEY_PAIR} from '../__tests__/fixtures/fleet-keys.js';
import {abortRetainedSourceImport} from './migration-rsync-transfer.js';

function fixture() {
 const record={executionId:'snapshot-transfer-one',status:'failed',targetCleanup:'pending',targetGatewayId:'target',targetName:'target-pod',targetIp:'10.0.0.2',targetVm:false} as SourceTransferExecution;
 const settledTarget=vi.fn(async()=>record);
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(JSON.stringify({imported:false,migrationId:'migration-one',slug:'builder'}),{status:200}));
 const deps={store:createDocumentFixtureStore({}),namespace:'octogee-test',privateKey:FLEET_KEY_PAIR.privateKey,fleetControllerPort:'3003',resolveGatewayUrl:()=>'',fetch,runCommand:vi.fn(async()=>({code:0,stderr:'',stdout:JSON.stringify({items:[{metadata:{name:'target-pod'},status:{phase:'Running',podIP:'10.0.0.2'}}]})})),retainedSource:{assertActiveClaim:vi.fn(),observe:vi.fn(async()=>record),execute:vi.fn(),settledTarget,acknowledgeCleanup:vi.fn()}};
 return {record,settledTarget,fetch,deps,input:{migrationId:'migration-one',slug:'builder',toGatewayId:'target'}};
}
describe('retained source target cleanup',()=>{
 it('requires non-dispatch or actual termination proof before sending target abort',async()=>{
  const h=fixture();h.settledTarget.mockRejectedValue(new Error('source transfer observation pending'));
  await expect(abortRetainedSourceImport(h.deps,h.input)).rejects.toThrow('observation pending');expect(h.fetch).not.toHaveBeenCalled();
 });
 it('requires exact migration acknowledgement from the target',async()=>{
  const h=fixture();await abortRetainedSourceImport(h.deps,h.input);
  const body=JSON.parse(String(h.fetch.mock.calls[0]?.[1]?.body));
  expect(body).toMatchObject({migrationId:'migration-one',slug:'builder',mode:'final',rpcPhase:'abort-rsync-import'});
  h.fetch.mockResolvedValue(new Response(JSON.stringify({imported:false}),{status:200}));
  await expect(abortRetainedSourceImport(h.deps,h.input)).rejects.toThrow('acknowledgement');
 });
 it('does not abort a replacement target',async()=>{
  const h=fixture();h.settledTarget.mockRejectedValue(new Error('source transfer target identity changed'));
  await expect(abortRetainedSourceImport(h.deps,h.input)).rejects.toThrow('target identity changed');expect(h.fetch).not.toHaveBeenCalled();
 });
});
