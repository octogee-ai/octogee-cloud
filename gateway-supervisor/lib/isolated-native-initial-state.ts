import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const INITIAL_STATE = '.builder-native-initial-state.json';
const DATABASE_FILES = new Set(['openclaw.sqlite', 'openclaw.sqlite.seal', 'openclaw.sqlite-wal', 'openclaw.sqlite-shm', 'openclaw.sqlite-journal']);

function fingerprintClient(stateDir: string): string | null {
  const hash = createHash('sha256');
  const clientDir = path.join(stateDir, 'client');
  try {
    const client = fs.lstatSync(clientDir);
    if (!client.isDirectory()) return null;
    hash.update(JSON.stringify(['client', client.dev, client.ino]));
    for (const entry of fs.readdirSync(clientDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile()) return null;
      const bytes = fs.readFileSync(path.join(clientDir, entry.name));
      if ((entry.name.endsWith('-wal') || entry.name.endsWith('-journal')) && bytes.length !== 0) return null;
      hash.update(JSON.stringify([entry.name, bytes.length])).update(bytes);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return 'client-absent';
  }
  return hash.digest('hex');
}

function fingerprint(stateDir: string): string | null {
  if (!fs.lstatSync(stateDir).isDirectory()) return null;
  const directory = path.join(stateDir, 'state');
  if (!fs.lstatSync(directory).isDirectory()) return null;
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (!entries.some(entry => entry.name === 'openclaw.sqlite') ||
    entries.some(entry => !entry.isFile() || !DATABASE_FILES.has(entry.name))) return null;
  const root = fs.statSync(directory);
  const hash = createHash('sha256').update(JSON.stringify([fs.realpathSync(stateDir), root.dev, root.ino]));
  for (const entry of entries) {
    const bytes = fs.readFileSync(path.join(directory, entry.name));
    if ((entry.name.endsWith('-wal') || entry.name.endsWith('-journal')) && bytes.length !== 0) return null;
    hash.update(JSON.stringify([entry.name, bytes.length])).update(bytes);
  }
  const client = fingerprintClient(stateDir);
  return client === null ? null : hash.update(client).digest('hex');
}

export function recordIsolatedNativeInitialState(stateDir: string, podUid: string | undefined): void {
  if (!podUid) return;
  const sha256 = fingerprint(stateDir);
  if (!sha256) throw new Error('Fresh Native host state is not closed and canonical');
  const file = path.join(stateDir, INITIAL_STATE), temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 2, podUid, sha256 }), { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

const MAX_INITIAL_STATE_BYTES = 1024;

function readInitialState(file: string): unknown {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_INITIAL_STATE_BYTES) return null;
    const contents = Buffer.alloc(MAX_INITIAL_STATE_BYTES + 1);
    let size = 0;
    while (size < contents.length) {
      const read = fs.readSync(fd, contents, size, contents.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (size > MAX_INITIAL_STATE_BYTES) return null;
    return JSON.parse(contents.toString('utf8', 0, size));
  } finally {
    fs.closeSync(fd);
  }
}

export function isolatedNativeInitialStateMatches(stateDir: string, podUid: string | undefined): boolean {
  if (!podUid) return false;
  try {
    const initial = readInitialState(path.join(stateDir, INITIAL_STATE)) as {
      version?: unknown;
      podUid?: unknown;
      sha256?: unknown;
    } | null;
    return initial?.version === 2 && initial.podUid === podUid &&
      typeof initial.sha256 === 'string' && /^[a-f0-9]{64}$/.test(initial.sha256) &&
      initial.sha256 === fingerprint(stateDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof SyntaxError || code === 'ENOENT' || code === 'ELOOP') return false;
    throw error;
  }
}
