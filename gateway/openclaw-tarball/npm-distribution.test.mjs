import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const root = process.argv[2];
if (!root) throw new Error('Usage: node npm-distribution.test.mjs <extracted-or-installed-npm-root>');

for (const [format, bundled] of [['commonjs', false], ['esm', false], ['commonjs', true], ['esm', true]]) {
  const label = `${format}${bundled ? ' public bundle' : ' raw'}`;
  const load = (name) => {
    const packageRoot = path.resolve(root, 'node_modules', name);
    if (bundled && format === 'commonjs') return createRequire(path.resolve(root, 'package.json'))(name);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const entry = bundled ? manifest.exports['.'].import.default : `./dist/${format}/index.js`;
    return import(pathToFileURL(path.resolve(packageRoot, entry)).href);
  };
  const { Glob, glob, globStream, globStreamSync, globSync } = await load('glob');
  const { Minimatch } = await load('minimatch');
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-distribution-'));
  const populate = (dir, depth) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'file'), '');
    if (depth) for (const name of ['a', 'b']) populate(path.join(dir, name), depth - 1);
  };
  populate(tree, 5);
  test.after(() => fs.rmSync(tree, { recursive: true, force: true }));

  const cancelledWalk = () => {
    const controller = new AbortController();
    const reason = new Error('distribution cancellation control');
    let reads = 0;
    const count = () => { if (++reads === 1) controller.abort(reason); };
    return {
      options: { cwd: tree, signal: controller.signal, fs: {
        ...fs,
        readdir(...args) { count(); return fs.readdir(...args); },
        readdirSync(...args) { count(); return fs.readdirSync(...args); },
      } },
      reason,
      reads: () => reads,
    };
  };

  test(`${label}: cancelled async traversal admits no later directory reads`, { timeout: 5000 }, async () => {
    const walk = cancelledWalk();
    await assert.rejects(glob('**', walk.options), walk.reason);
    const settledReads = walk.reads();
    await delay(100);
    assert.equal(walk.reads(), settledReads);
  });

  test(`${label}: cancelled synchronous stream stops at the first read`, { timeout: 5000 }, async () => {
    const walk = cancelledWalk();
    const stream = globStreamSync('**', walk.options);
    await new Promise((resolve, reject) => {
      stream.on('error', (error) => {
        try { assert.equal(error, walk.reason); assert.equal(walk.reads(), 1); resolve(); }
        catch (failure) { reject(failure); }
      });
      stream.on('end', () => reject(new Error('Cancelled stream unexpectedly completed')));
      stream.resume();
    });
  });

  test(`${label}: paused stream resumes with all native matches`, { timeout: 5000 }, async () => {
    const stream = globStream('**', { cwd: tree });
    await delay(50);
    const found = [];
    for await (const item of stream) found.push(item);
    assert.deepEqual(new Set(found), new Set(globSync('**', { cwd: tree })));
  });

  test(`${label}: glob applies its embedded preprocessing bound`, () => {
    const walker = new Glob(Array(14).fill('**/../a/b').join('/'), {});
    assert.equal(walker.patterns.length, 10_000);
  });

  test(`${label}: globstar parent preprocessing respects the pattern limit`, () => {
    const matcher = new Minimatch(Array(8).fill('**/../a/b').join('/'), { optimizationLevel: 2, braceExpandMax: 64 });
    assert.equal(matcher.set.length, 64);
    const small = new Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2 });
    assert.equal(small.set.length, 4);
    assert.equal(small.match('../a/b/../c/d'), true);
    assert.equal(small.match('x/a/b/y/c/d'), true);
  });

  test(`${label}: large pattern sets skip quadratic deduplication and still match`, () => {
    assert.equal(new Minimatch('{x,*}/{0..9}', { optimizationLevel: 2 }).set.length, 10);
    const matcher = new Minimatch('{x,*}/{0..999}', { optimizationLevel: 2 });
    assert.equal(matcher.set.length, 2000);
    assert.equal(matcher.match('x/5'), true);
    assert.equal(matcher.match('y/999'), true);
    assert.equal(matcher.match('.y/5'), false);
  });
}
