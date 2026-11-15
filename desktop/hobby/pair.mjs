import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire('/usr/local/lib/node_modules/openclaw/package.json');
const { GatewayClient } = await import(require.resolve('openclaw/plugin-sdk/gateway-runtime'));

let connected;
let rejected;
const hello = new Promise((resolve, reject) => { connected = resolve; rejected = reject; });
const client = new GatewayClient({
  url: 'ws://127.0.0.1:18789', password: (await readFile('/home/node/runtime/password', 'utf8')).trim(),
  clientName: 'cli', mode: 'cli', role: 'operator', deviceIdentity: null,
  scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
  onHelloOk: connected, onConnectError: rejected,
});
const watchdog = setTimeout(() => rejected(new Error('gateway pairing connection timed out')), 30000);
client.start();
try {
  await hello;
  clearTimeout(watchdog);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const nodes = await client.request('node.list', {});
    if (nodes.nodes.some((node) => node.displayName === 'octogee-desktop' && node.connected && node.paired)) {
      console.log('Desktop node paired and connected');
      process.exitCode = 0;
      break;
    }
    const devices = await client.request('device.pair.list', {});
    for (const pending of devices.pending) {
      if (pending.displayName !== 'octogee-desktop') throw new Error('Unexpected device in isolated benchmark');
      await client.request('device.pair.approve', { requestId: pending.requestId });
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const nodes = await client.request('node.list', {});
  if (!nodes.nodes.some((node) => node.displayName === 'octogee-desktop' && node.connected && node.paired)) throw new Error('Desktop node did not become ready');
} finally {
  clearTimeout(watchdog);
  client.stop();
}
