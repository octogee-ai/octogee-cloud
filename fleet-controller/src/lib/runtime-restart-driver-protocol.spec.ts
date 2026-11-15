import {afterEach,expect,it,vi} from 'vitest';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {generateIdentity} from '@octogee/shared/types/device-identity';
import {createRestartDriverDeps,proveRuntimeRestart,runtimeRestartDriverSource} from './runtime-restart-driver.js';
import {Script} from 'node:vm';
afterEach(()=>vi.unstubAllEnvs());
it.each(['shared','per-user'])('uses %s auth and binds same-wire boot through readiness without redispatch',async controlIdentity=>{
 const dir=await mkdtemp(join(tmpdir(),'restart-driver-'));
 const server=createServer((_req,res)=>{res.writeHead(200);res.end('{}');});
 const wsServer=new WebSocketServer({server});let boot='boot-before',restartCount=0;const calls:string[]=[];
 wsServer.on('connection',(ws,upgrade)=>{if(controlIdentity==='per-user'){expect(upgrade.headers['x-octogee-user']).toBe('svc:octogee-provisioner');expect(upgrade.headers['x-octogee-proxy']).toBe('1');}const connectionBoot=boot;ws.send(JSON.stringify({type:'event',event:'connect.challenge',payload:{nonce:'nonce'}}));ws.on('message',data=>{
  const request=JSON.parse(String(data));calls.push(request.method);
  if(request.method==='connect'){if(controlIdentity==='shared'){expect(request.params.auth.token).toBe('private-test-token');expect(request.params.device.nonce).toBe('nonce');}else{expect(request.params.auth).toBeUndefined();expect(request.params.client.id).toBe('openclaw-control-ui');}ws.send(JSON.stringify({type:'res',id:request.id,ok:true,payload:{server:{bootId:connectionBoot}}}));}
  else if(request.method==='gateway.restart.request'){restartCount++;boot='boot-after';ws.send(JSON.stringify({type:'res',id:request.id,ok:true,payload:{ok:true,status:'scheduled',restart:{ok:true}}}));}
  else ws.send(JSON.stringify({type:'res',id:request.id,ok:true,payload:{ok:true}}));
 });});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {
  const address=server.address();if(!address || typeof address==='string')throw Error('missing address');
  await writeFile(join(dir,'config.json'),JSON.stringify({gateway:{port:address.port,auth:{token:'private-test-token'}}}));
  await writeFile(join(dir,'device.json'),JSON.stringify(generateIdentity()));
  vi.stubEnv('OPENCLAW_CONFIG_PATH',join(dir,'config.json'));vi.stubEnv('OCTOGEE_PROVISIONER_IDENTITY_PATH',join(dir,'device.json'));vi.stubEnv('OPENCLAW_CONTROL_IDENTITY',controlIdentity);vi.stubEnv('API_PUBLIC_URL','https://api-test.octogee.com');vi.stubEnv('OPENCLAW_GATEWAY_TOKEN','');
  const deps=await createRestartDriverDeps(fileURLToPath(new URL('../../package.json',import.meta.url)));
  expect(await proveRuntimeRestart('attempt-wire',deps,5000)).toMatchObject({beforeBootId:'boot-before',afterBootId:'boot-after',ready:true});
  expect(restartCount).toBe(1);expect(calls).toEqual(['connect','gateway.restart.request','connect','health']);
  expect(()=>new Script(runtimeRestartDriverSource())).not.toThrow();
 } finally {for(const ws of wsServer.clients){ws.terminate();}await new Promise<void>(r=>wsServer.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
