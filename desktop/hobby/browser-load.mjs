import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const count = Number(process.env.BENCH_TABS ?? 8);
const durations = [];
let populatedTab;
for (let i = 0; i < count; i++) {
  const start = performance.now();
  const response = await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent('http://127.0.0.1:7777/fixture')}`, { method: 'PUT' });
  assert.equal(response.ok, true);
  const tab = await response.json();
  populatedTab = tab.id;
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const result = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('CDP evaluation timed out')), 30000);
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(deadline);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `new Promise(resolve => setTimeout(() => { const table = document.createElement('table'); for (let i=0; i<1000; i++) { const row = table.insertRow(); row.insertCell().textContent = 'Project task '+i; row.insertCell().textContent = 'Ready to build'; } document.body.append(table); resolve(table.rows.length); }, 500))`, awaitPromise: true, returnByValue: true } }));
  const evaluated = await result;
  assert.equal(evaluated.result.value, 1000);
  ws.close();
  durations.push(Math.round(performance.now() - start));
}
assert.ok(populatedTab);
assert.equal((await fetch(`http://127.0.0.1:9222/json/activate/${populatedTab}`)).ok, true);
execFileSync('/usr/bin/wmctrl', ['-xa', 'chromium'], { env: { ...process.env, DISPLAY: ':0' } });
const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
await writeFile('/home/node/results/browser-load.json', JSON.stringify({ addedTabs: count, totalPageTabs: tabs.filter((tab) => tab.type === 'page').length, durationsMs: durations }, null, 2));
console.log(JSON.stringify({ addedTabs: count, durationsMs: durations }));
