import {EventEmitter} from 'node:events';
import {afterEach,describe,expect,it,vi} from 'vitest';
const spawn=vi.hoisted(()=>vi.fn());
vi.mock('node:child_process',()=>({spawn}));
import {spawnKubectl} from '../fleet-ingress.js';
function child() {
 const process=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),stdin:Object.assign(new EventEmitter(),{write:vi.fn(),end:vi.fn()}),kill:vi.fn()});spawn.mockReturnValue(process);return process;
}
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
describe('bounded kubectl subprocess',()=>{
 it('kills and rejects a timed-out child',async()=>{
  vi.useFakeTimers();const process=child();const result=spawnKubectl(['get','pods'],{timeoutMs:15});
  const failure=expect(result).rejects.toThrow('request timed out');await vi.advanceTimersByTimeAsync(15);await failure;
  expect(process.kill).toHaveBeenCalledWith('SIGKILL');
 });
 it('kills and rejects on stdin transport failure instead of leaving a child running',async()=>{
  vi.useFakeTimers();const process=child();const result=spawnKubectl(['exec'],{stdin:'driver',timeoutMs:20});
  const failure=expect(result).rejects.toThrow('broken input');process.stdin.emit('error',new Error('broken input'));await failure;
  expect(process.kill).toHaveBeenCalledWith('SIGKILL');await vi.advanceTimersByTimeAsync(20);expect(process.kill).toHaveBeenCalledTimes(1);
 });
 it('clears its timer after successful output and stdin EOF',async()=>{
  vi.useFakeTimers();const process=child();const result=spawnKubectl(['exec'],{stdin:'driver',timeoutMs:20});
  process.stdout.emit('data',Buffer.from('receipt'));process.emit('close',0,null);
  await expect(result).resolves.toEqual({code:0,stdout:'receipt',stderr:''});
  expect(process.stdin.write).toHaveBeenCalledWith('driver');expect(process.stdin.end).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(20);expect(process.kill).not.toHaveBeenCalled();
 });
});
