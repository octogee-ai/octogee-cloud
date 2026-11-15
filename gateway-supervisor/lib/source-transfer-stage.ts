import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { sourceTransferRsyncArgs } from "./source-transfer-rsync.js";
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { admitSourceTree, parseSourceTransferRequest, sharedMigrationExportPaths, sourcesForPushMode, SOURCE_TRANSFER_LIMITS } from './source-transfer-plan.js';
import { findPortableAgentStores, AGENT_SNAPSHOT_DIRNAME } from './agent-store-snapshot.js';
import { exportActivationManifestWithSecret } from './migration-activation-secrets.js';
import { writeActivationManifest } from './migration-activation-manifest.js';
import { rsyncTlsConnectProgram } from './migration-rsync-tls.js';
import { exportCodexStoreSnapshots } from './codex-store-snapshot.js';

export async function prepareSourceTransferStage(phase: string, scratch: string, executionId: string, podUid: string, root = '/home/node/.openclaw') {
 if (!scratch || !executionId || !/^\/tmp\/octogee-source-transfer-[A-Za-z0-9_-]+$/.test(scratch)) throw new Error('invalid private scratch');
 const request = parseSourceTransferRequest(JSON.parse(await fs.readFile(path.join(scratch, 'request.json'), 'utf8')), executionId, podUid);
 const sources = sourcesForPushMode(await sharedMigrationExportPaths(root, request.slug), request.slug, 'final');
 if (!sources.length) throw new Error('source export is empty');
 await admitSourceTree(root, request.slug, sources);
 await validateSourceConfigFiles(root);
 const stores = await findPortableAgentStores(sources);
 if (stores.some(store => readPostgresAgentAnchor(path.join(store.sourceAgentDir, 'openclaw-agent.sqlite')))) {
  throw new Error('PostgreSQL agent handoff requires a live source Gateway with agents.detach; retained-pod SQLite recovery cannot move it');
 }
 const manifest = await exportActivationManifestWithSecret(path.join(root, 'openclaw.json'), root, request.slug);
 if (stores.length > SOURCE_TRANSFER_LIMITS.maxStores) throw new Error('source exceeds store limit');
 const configPath = path.join(scratch, 'openclaw.json');
 const exportRoot = path.join(scratch, 'snapshots');
 const snapshots = stores.map(store => ({ agentId: store.agentId, relative: path.posix.join(store.agentDir, AGENT_SNAPSHOT_DIRNAME), repository: path.join(exportRoot, store.agentDir, AGENT_SNAPSHOT_DIRNAME) }));
 if (phase === 'plan') {
  await fs.writeFile(configPath, JSON.stringify({ plugins: { enabled: false }, agents: { ownership: 'explicit', entries: Object.fromEntries(stores.map(store => [store.agentId, { agentDir: store.sourceAgentDir }])) } }), { mode: 0o600 });
  for (const snapshot of snapshots) await fs.mkdir(snapshot.repository, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(scratch, 'plan.json'), JSON.stringify({ snapshots }), { mode: 0o600 });
  return;
 }
 if (phase !== 'finish') throw new Error('invalid transfer phase');
 for (let i = 0; i < snapshots.length; i++) {
  const snapshot = snapshots[i]!;
  const result = JSON.parse(await fs.readFile(path.join(scratch, `snapshot-${i}.json`), 'utf8'));
  validateSnapshotResult(result, snapshot.repository);
  sources.push({ cwd: exportRoot, path: snapshot.relative });
 }
 sources.push(...await exportCodexStoreSnapshots({ sources, exportRoot, log: console.log }));
 if (request.includeActivationManifest) sources.push(await writeActivationManifest(scratch, manifest));
 const passwordFile = path.join(scratch, 'rsync.pass');
 const certificatePath = path.join(scratch, 'target.crt');
 await fs.writeFile(passwordFile, `${request.transferKey}\n`, { mode: 0o600 });
 await fs.writeFile(certificatePath, request.targetCertificatePem, { mode: 0o600 });
 const host = request.targetHost.includes(':') ? `[${request.targetHost}]` : request.targetHost;
 const args = sourceTransferRsyncArgs(sources, passwordFile, `rsync://${request.transferUser}@${host}/state/`, 'final');
 await fs.writeFile(path.join(scratch, 'transfer.json'), JSON.stringify({ args, connectProgram: rsyncTlsConnectProgram({ certificatePath, host: request.targetHost, port: request.targetPort }) }), { mode: 0o600 });
}

function validateSnapshotResult(result: { ok?: unknown; snapshotPath?: unknown }, repository: string): void {
 if (result.ok !== true || typeof result.snapshotPath !== 'string' || path.dirname(result.snapshotPath) !== repository) throw new Error('snapshot publication failed');
}

async function validateSourceConfigFiles(root: string): Promise<void> {
 for (const relative of ['openclaw.json', 'applied-fingerprints.json', 'secrets/mattermost-accounts.json']) {
  const filename = path.join(root, relative);
  try {
   if (await fs.realpath(filename) !== filename) throw new Error('source config path is not canonical');
   const stat = await fs.lstat(filename);
   if (!stat.isFile() || stat.size > 1024 ** 2) throw new Error('source config exceeds bounds');
  } catch (error) {
   if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
 }
}
