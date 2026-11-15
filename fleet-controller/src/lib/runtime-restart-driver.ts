import { createRestartDriverDeps, type RestartConnection, type RestartDriverDeps } from "@octogee/core/gateway-restart-probe";
export { createRestartDriverDeps } from "@octogee/core/gateway-restart-probe";
export interface RuntimeRestartReceipt {
  version: 1;
  attemptId: string;
  beforeBootId: string;
  afterBootId: string;
  ready: true;
}
export async function proveRuntimeRestart(attemptId: string, deps: RestartDriverDeps, timeoutMs = 180000): Promise<RuntimeRestartReceipt> {
  const acknowledged = (response: {ok?:unknown;status?:unknown;restart?:{ok?:unknown}} | null): boolean => response?.ok === true && ['scheduled','deferred','coalesced'].includes(String(response.status)) && response.restart?.ok === true;
  const deadline = deps.now() + timeoutMs;
  const before = await deps.connect();
  let beforeBootId: string;
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(before.bootId)) throw new Error('restart boot identity unavailable');
    beforeBootId = before.bootId;
    const response = await before.request('gateway.restart.request', { reason: 'octogee.runtime-restart', skipDeferral: true }) as {ok?:unknown;status?:unknown;restart?:{ok?:unknown}} | null;
    if (!acknowledged(response)) throw new Error('restart acknowledgement invalid');
  } finally { before.close(); }
  while (deps.now() < deadline) {
    let after: RestartConnection | undefined;
    try {
      after = await deps.connect();
      if (/^[A-Za-z0-9_-]{1,128}$/.test(after.bootId) && after.bootId !== beforeBootId && await deps.ready()) {
        await after.request('health', {});
        if (after.alive() && deps.now() < deadline) return { version:1, attemptId, beforeBootId, afterBootId:after.bootId, ready:true };
      }
    } catch (error) {
      if (deps.now() >= deadline) throw error;
    } finally { after?.close(); }
    await deps.wait();
  }
  throw new Error('runtime restart completion deadline');
}

export function runtimeRestartDriverSource(): string {
  return `const attemptId=process.argv[2];if(!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId??''))throw new Error('invalid restart attempt');const deadline=setTimeout(()=>{process.stderr.write('runtime restart unconfirmed\\n');process.exit(1)},180000);const prove=${proveRuntimeRestart.toString()};const dependencies=${createRestartDriverDeps.toString()};dependencies().then(d=>prove(attemptId,d)).then(r=>{clearTimeout(deadline);process.stdout.write(JSON.stringify(r)+'\\n')}).catch(()=>{process.stderr.write('runtime restart unconfirmed\\n');process.exit(1)});`;
}

export async function proveManagementHealth(attemptId: string, deps: RestartDriverDeps): Promise<{ version: 1; attemptId: string; bootId: string; health: true }> {
  const connection = await deps.connect();
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(connection.bootId) || !await deps.ready()) throw new Error('management health identity unavailable');
    await connection.request('health', {});
    if (!connection.alive()) throw new Error('management health connection closed');
    return { version: 1, attemptId, bootId: connection.bootId, health: true };
  } finally { connection.close(); }
}
export function managementHealthDriverSource(): string {
  return `const attemptId=process.argv[2];if(!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId??''))throw new Error('invalid restart attempt');const deadline=setTimeout(()=>{process.stderr.write('management health unconfirmed\\n');process.exit(1)},45000);const prove=${proveManagementHealth.toString()};const dependencies=${createRestartDriverDeps.toString()};dependencies().then(d=>prove(attemptId,d)).then(r=>{clearTimeout(deadline);process.stdout.write(JSON.stringify(r))}).catch(()=>{process.stderr.write('management health unconfirmed\\n');process.exit(1)});`;
}
