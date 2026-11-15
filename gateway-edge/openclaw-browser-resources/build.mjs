import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generatorInputs, inputLabel, inputsDigest, stableSource } from './provenance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const source = path.resolve(process.argv[2] ?? '');
const expected = process.argv[3];
if (!expected || !/^[0-9a-f]{40}$/.test(expected)) throw new Error('Usage: node gateway-edge/openclaw-browser-resources/build.mjs OPENCLAW_CHECKOUT FULL_SOURCE_SHA');
const git = (...args) => execFileSync('/usr/bin/git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== expected || git('status', '--porcelain', '--untracked-files=no')) throw new Error('OpenClaw must be clean at the exact source SHA');
const current = JSON.parse(await readFile(path.join(root, 'gateway/openclaw-tarball/current.json'), 'utf8'));
if (current.sourceSha !== expected) process.stderr.write(`[browser-resources] current.json pins sourceSha ${current.sourceSha}; set it to ${expected} when the gateway objects come from this build\n`);

const entry = 'ui/src/lib/chat/browser-tab-preview.ts';
const aliases = { 'openclaw-browser-resources': entry, 'openclaw-english': 'ui/src/i18n/locales/en.ts' };
const requireSource = createRequire(path.join(source, 'package.json'));
const { compilerOptions } = JSON.parse(await readFile(path.join(source, 'tsconfig.json'), 'utf8'));
const { build } = await import(pathToFileURL(requireSource.resolve('esbuild')).href);
const adapters = { name: 'openclaw-browser-resources', setup(builder) {
  builder.onResolve({ filter: /^openclaw-/ }, ({ path: id }) => aliases[id] ? { path: path.join(source, aliases[id]) } : undefined);
  builder.onResolve({ filter: /(?:i18n\/index|i18n\/lib\/(?:lit-controller|translate|registry))\.ts$/ }, () => ({ path: path.join(here, 'i18n.ts') }));
} };
const output = path.join(root, 'gateway-edge/src/vendor/openclaw-browser-resources');
const result = await build({
  bundle: true, format: 'esm', target: 'es2022', platform: 'node', metafile: true, legalComments: 'eof', write: false,
  minifyIdentifiers: true, minifySyntax: true, minifyWhitespace: false,
  nodePaths: [path.join(source, 'ui/node_modules'), path.join(source, 'node_modules')],
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false, verbatimModuleSyntax: true, baseUrl: source, paths: compilerOptions.paths } },
  plugins: [adapters],
  entryPoints: [path.join(here, 'entry.ts')], outfile: path.join(output, 'index.js'),
});
const { inputs } = result.metafile;
const untransformed = Object.keys(inputs).filter(file => /\.(?:[jt]sx|css)$/.test(file));
if (untransformed.length) throw new Error(`Browser resources now import UI component inputs this generator does not transform: ${untransformed.join(', ')}`);

const packages = new Map();
for (const input of Object.keys(inputs)) {
  const marker = '/node_modules/';
  const start = input.lastIndexOf(marker);
  if (start < 0) continue;
  const parts = input.slice(start + marker.length).split('/');
  const name = parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/');
  const directory = path.resolve(input.slice(0, start + marker.length), name);
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  packages.set(`${pkg.name}@${pkg.version}`, directory);
}
const notices = [`OpenClaw source ${expected}\n\n${await readFile(path.join(source, 'LICENSE'), 'utf8')}`];
for (const [name, directory] of [...packages].sort()) {
  const license = (await readdir(directory)).find(file => /^(?:MIT-)?licen[sc]e(?:-[\w-]+)?(?:\.md|\.txt)?$/i.test(file));
  if (!license) throw new Error(`Missing license: ${name}`);
  notices.push(`${name}\n\n${await readFile(path.join(directory, license), 'utf8')}`);
}

const files = generatorInputs(Object.keys(inputs).filter(file => !file.includes(':')).map(file => inputLabel(file, source, root)));
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'index.ts'), '// @ts-nocheck\n' + stableSource(result.outputFiles[0].text, inputs, source, root));
await writeFile(path.join(output, 'LICENSES.txt'), notices.join('\n\n---\n\n'));
await writeFile(path.join(output, 'provenance.json'), JSON.stringify({ source: expected, inputs: { sha256: await inputsDigest(root, files), files }, entry, packages: [...packages.keys()].sort() }, null, 2) + '\n');
process.stderr.write(`[browser-resources] built from ${expected}\n`);
