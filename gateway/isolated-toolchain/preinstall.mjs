import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function prepareImageToolchain(root, lockSha256, groupsSha256) {
  const [lock, groups] = await Promise.all([
    readFile(path.join(root, 'package-lock.json')),
    readFile(path.join(root, 'groups.json')),
  ]);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(lockSha256) || !/^[a-f0-9]{64}$/.test(groupsSha256)
      || digest(lock) !== lockSha256 || digest(groups) !== groupsSha256) {
    throw new Error('preinstalled toolchain inputs differ from image pins');
  }
  const manifest = JSON.parse(groups);
  const commands = manifest.groups.filter(group => group.enabled && group.delivery === 'npm')
    .flatMap(group => group.commands ?? []).filter(command => command !== 'chromium');
  await mkdir(path.join(root, 'bin'), { recursive: true });
  for (const command of commands) {
    if (!/^[a-zA-Z0-9_-]+$/.test(command)) throw new Error('invalid toolchain command');
    const destination = path.join(root, 'bin', command);
    await rm(destination, { force: true });
    await symlink(`../node_modules/.bin/${command}`, destination);
  }
  const descriptor = {
    schemaVersion: 1, lockSha256, groupsSha256,
    bundleSha256: createHash('sha256').update(lock).update(groups).digest('hex'),
    commands: {
      claude: 'node_modules/.bin/claude', codex: 'node_modules/.bin/codex',
      chromium: 'node_modules/@sparticuz/chromium/build/index.js',
    },
  };
  await writeFile(path.join(root, '.toolchain-lock.json'), `${JSON.stringify(descriptor)}\n`);
  return descriptor;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await prepareImageToolchain(process.argv[2], process.env.BUILDER_TOOLCHAIN_LOCK_SHA256,
    process.env.BUILDER_TOOL_GROUPS_SHA256);
}
