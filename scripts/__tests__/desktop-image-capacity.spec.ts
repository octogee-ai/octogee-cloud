import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function start(failures: number, error: string, advance = 1) {
  const directory = mkdtempSync(path.join(tmpdir(), 'desktop-capacity-'));
  temporary.push(directory);
  const counter = path.join(directory, 'counter'), calls = path.join(directory, 'calls');
  writeFileSync(counter, '0');
  writeFileSync(calls, '');
  const result = spawnSync('bash', ['-c', `
    source "$HELPER"
    gcloud() {
      local count
      count=$(cat "$COUNTER")
      count=$((count + 1))
      printf '%s' "$count" > "$COUNTER"
      printf '%s\\n' "$*" >> "$CALLS"
      if (( count <= FAILURES )); then printf '%s\\n' "$FAILURE" >&2; return 1; fi
    }
    sleep() { SECONDS=$((SECONDS + ADVANCE)); }
    start_instance_with_capacity_retry proof-vm --zone us-central1-b --project firebase-test --quiet
  `], { encoding: 'utf8', env: { ...process.env, HELPER: path.resolve(__dirname, '../../desktop/image/zones.sh'), COUNTER: counter, CALLS: calls, FAILURES: String(failures), FAILURE: error, ADVANCE: String(advance) } });
  return { ...result, attempts: Number(readFileSync(counter, 'utf8')), calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
}
it('retries transient capacity exhaustion on the same stopped VM and zone', () => {
  const result = start(1, 'ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS');
  expect(result.status).toBe(0);
  expect(result.attempts).toBe(2);
  expect(result.calls).toEqual(Array(2).fill('compute instances start proof-vm --zone us-central1-b --project firebase-test --quiet'));
});
it('returns permanent VM start errors without retrying', () => {
  const result = start(100, 'PERMISSION_DENIED');
  expect(result.status).toBe(1);
  expect(result.attempts).toBe(1);
  expect(result.stderr).toContain('PERMISSION_DENIED');
});
it('ends a capacity retry when its bounded restart deadline expires', () => {
  const result = start(100, 'ZONE_RESOURCE_POOL_EXHAUSTED', 300);
  expect(result.status).toBe(1);
  expect(result.attempts).toBeLessThanOrEqual(2);
  expect(result.stderr).toContain('ZONE_RESOURCE_POOL_EXHAUSTED');
});
