import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
it('enforces launcher resource admission, source mount isolation and child failure/deadline behavior', () => {
 expect(() => execFileSync('python3', [fileURLToPath(new URL('./source-transfer-launcher.test.py', import.meta.url))], { stdio: 'pipe' })).not.toThrow();
});
