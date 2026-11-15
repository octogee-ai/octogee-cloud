import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { RestartDriverDeps } from '@octogee/core/gateway-restart-probe';
import { proveRuntimeRestart, runtimeRestartDriverSource, proveManagementHealth, managementHealthDriverSource } from './runtime-restart-driver.js';
function harness(boots = ['boot-a', 'boot-b']) {
 let now=0,index=0;
 const connections=boots.map(bootId=>({bootId,request:vi.fn(async()=>({ok:true,status:'scheduled',restart:{ok:true}})),close:vi.fn(),alive:():boolean=>true}));
 const deps={connect:vi.fn(async()=>connections[Math.min(index++,connections.length-1)]!),ready:vi.fn<RestartDriverDeps['ready']>(async()=>true),now:()=>now,wait:vi.fn(async()=>{now+=1000;})};
 return {deps,connections};
}
describe('runtime restart completion proof',()=>{
 it('binds request to the same connection boot and requires changed ready boot',async()=>{
  const h=harness();expect(await proveRuntimeRestart('attempt-1',h.deps,3000)).toEqual({version:1,attemptId:'attempt-1',beforeBootId:'boot-a',afterBootId:'boot-b',ready:true});
  expect(h.connections[0]!.request).toHaveBeenCalledWith('gateway.restart.request',{reason:'octogee.runtime-restart',skipDeferral:true});expect(h.connections[1]!.request).toHaveBeenCalledWith('health',{});
 });
 it('never repeats an unacknowledged restart',async()=>{const h=harness();h.connections[0]!.request.mockRejectedValue(new Error('lost acknowledgement'));await expect(proveRuntimeRestart('attempt-1',h.deps,3000)).rejects.toThrow();expect(h.deps.connect).toHaveBeenCalledTimes(1);});
 it('refuses a healthy unchanged boot',async()=>{const h=harness(['boot-a']);await expect(proveRuntimeRestart('attempt-1',h.deps,2000)).rejects.toThrow('deadline');expect(h.deps.ready).not.toHaveBeenCalled();});
 it('requires readiness after changed boot',async()=>{const h=harness();h.deps.ready.mockResolvedValue(false);await expect(proveRuntimeRestart('attempt-1',h.deps,2000)).rejects.toThrow('deadline');});
 it('refuses a connection lost during readiness',async()=>{const h=harness();h.connections[1]!.alive=()=>false;await expect(proveRuntimeRestart('attempt-1',h.deps,2000)).rejects.toThrow('deadline');});
 it.each([null,{}, {ok:true,status:'done',restart:{ok:true}}])('refuses malformed acknowledgement %j',async ack=>{const h=harness();h.connections[0]!.request.mockResolvedValue(ack as never);await expect(proveRuntimeRestart('attempt-1',h.deps,2000)).rejects.toThrow('acknowledgement');});
 it('refuses absent boot before dispatch',async()=>{const h=harness(['']);await expect(proveRuntimeRestart('attempt-1',h.deps,2000)).rejects.toThrow('boot');expect(h.connections[0]!.request).not.toHaveBeenCalled();});
 it('serializes bounded generic failure output',()=>{const s=runtimeRestartDriverSource();expect(s).toContain('180000');expect(s).toContain('runtime restart unconfirmed');});
});

describe('read-only management health proof', () => {
 it('uses a fresh authenticated connection and health only, then closes it', async () => {
  const h = harness(); expect(await proveManagementHealth('attempt-1', h.deps)).toEqual({ version:1, attemptId:'attempt-1', bootId:'boot-a', health:true });
  expect(h.connections[0]!.request).toHaveBeenCalledExactlyOnceWith('health', {}); expect(h.connections[0]!.close).toHaveBeenCalledOnce();
 });
 it.each(['health', 'closed', 'ready'])('refuses failed %s proof and closes the connection', async failure => {
  const h = harness();
  if (failure === 'health') h.connections[0]!.request.mockRejectedValue(new Error('revoked'));
  if (failure === 'closed') h.connections[0]!.alive = () => false;
  if (failure === 'ready') h.deps.ready.mockResolvedValue(false);
  await expect(proveManagementHealth('attempt-1', h.deps)).rejects.toThrow(); expect(h.connections[0]!.close).toHaveBeenCalledOnce();
 });
 it('serializes a bounded readonly probe without restart RPC', () => {
  expect(() => new Script(managementHealthDriverSource())).not.toThrow();
  expect(managementHealthDriverSource()).toContain('process.stdout.write(JSON.stringify(r))');
  expect(managementHealthDriverSource()).not.toContain('gateway.restart.request');
  expect(managementHealthDriverSource()).toContain('45000');
 });
});

it.each([runtimeRestartDriverSource, managementHealthDriverSource])('rejects an invalid attempt before starting the probe', source => {
 const child = spawnSync(process.execPath, ['--input-type=commonjs', '-', '../invalid'], {
  input: source(), encoding: 'utf8', timeout: 2000,
 });
 expect(child.status).toBe(1);
 expect(child.stdout).toBe('');
 expect(child.stderr).toContain('invalid restart attempt');
});
