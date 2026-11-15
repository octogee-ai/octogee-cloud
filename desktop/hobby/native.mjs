import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire('/usr/local/lib/node_modules/openclaw/package.json');
const { GatewayClient } = await import(require.resolve('openclaw/plugin-sdk/gateway-runtime'));

const COMPUTER_ACT = 'computer.act';
const timings = [];
let connected;
let rejected;
const hello = new Promise((resolve, reject) => { connected = resolve; rejected = reject; });
const client = new GatewayClient({
  url: 'ws://127.0.0.1:18789',
  password: (await readFile('/home/node/runtime/password', 'utf8')).trim(),
  clientName: 'cli', mode: 'cli', role: 'operator', deviceIdentity: null,
  scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
  onHelloOk: connected, onConnectError: rejected,
});
const watchdog = setTimeout(() => rejected(new Error('gateway connection timed out')), 30000);
client.start();
await hello;
clearTimeout(watchdog);
const executionId = randomUUID();
let node;
async function invoke(command, params) {
  const start = performance.now();
  const result = await client.request('node.invoke', {
    nodeId: node.nodeId, command, params: { executionId, ...params },
    idempotencyKey: randomUUID(), timeoutMs: 30000,
  });
  assert.notEqual(result.ok, false, JSON.stringify(result));
  const payload = result.payload ?? JSON.parse(result.payloadJSON);
  timings.push({ command, action: params.action, durationMs: Math.round(performance.now() - start) });
  assert.notEqual(payload.isError, true, JSON.stringify(payload));
  return payload;
}
try {
  const listed = await client.request('node.list', {});
  node = listed.nodes.find((value) => value.displayName === 'octogee-desktop' && value.connected);
  assert.ok(node, 'desktop node must connect');
  assert.equal(node.paired, true);
  for (let i = 0; i < 10; i++) {
    const snapshot = await invoke('screen.snapshot', {});
    assert.ok(snapshot.displayFrameId);
  }
  if (process.env.BENCH_NATIVE_KEEP_PAGE !== '1') {
    await invoke(COMPUTER_ACT, { action: 'key', keys: 'ctrl+l' });
    await invoke(COMPUTER_ACT, { action: 'type', text: 'http://127.0.0.1:7777/fixture' });
    await invoke(COMPUTER_ACT, { action: 'key', keys: 'Return' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const windows = await invoke(COMPUTER_ACT, { action: 'list_windows' });
  const browser = windows.details.windows.find((window) => window.title.includes('Hobby benchmark fixture'));
  assert.ok(browser, 'native computer keyboard must navigate Chromium');
  const tree = await invoke(COMPUTER_ACT, { action: 'get_window_state', windowRef: browser.windowRef, includeScreenshot: false });
  assert.equal(tree.details.degraded ?? false, false);
  assert.ok(tree.observation.elements.length >= Number(process.env.BENCH_MIN_ACCESSIBILITY_ELEMENTS ?? 1), 'browser accessibility elements must exist at the requested page size');
  const shot = await invoke('screen.snapshot', {});
  const pointer = { displayFrameId: shot.displayFrameId, refWidth: shot.width, x: Math.floor(shot.width * 0.9), y: Math.floor(shot.height * 0.9) };
  await invoke(COMPUTER_ACT, { action: 'mouse_move', ...pointer });
  await invoke(COMPUTER_ACT, { action: 'left_click', ...pointer });
  console.log(JSON.stringify({ ok: true, accessibilityElements: tree.observation.elements.length, timings }));
  await writeFile('/home/node/results/native.json', JSON.stringify({ ok: true, accessibilityElements: tree.observation.elements.length, timings }, null, 2));
} finally {
  if (node) await invoke(COMPUTER_ACT, { action: '__close_execution', reason: 'benchmark-complete' });
  client.stop();
}
