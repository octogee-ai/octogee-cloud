import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { isIP } from 'node:net';
import { agentIdBelongsToSlug } from '@octogee/shared/types/agent-models';
import { isValidUsername } from '@octogee/shared/types/identity';
import { isMigrationCertificatePem } from './migration-rsync-tls.js';
import { isCodexDatabase, isCodexTemporaryDirectory } from './codex-store-snapshot.js';

export const SOURCE_TRANSFER_LIMITS = { maxStores: 2, maxBytes: 256 * 1024 ** 2, maxFiles: 16384, scratchBytes: 512 * 1024 ** 2, lifetimeSeconds: 600 } as const;
export interface TransferSource { cwd: string; path: string }
export interface SourceTransferRequest {
 version: 1; executionId: string; operationId: string; claimStartedAt: number; migrationId: string; uid: string; slug: string;
 sourceGatewayId: string; sourcePodUid: string; assignmentEpoch: number; mode: 'final'; includeActivationManifest: boolean;
 resourceAdmission: { observedAt: number; sourceMemoryMax: number; sourceMemoryCurrent: number };
 targetHost: string; targetPort: number; targetCertificatePem: string; transferUser: string; transferKey: string;
}
const fields = ['version','executionId','operationId','claimStartedAt','migrationId','uid','slug','sourceGatewayId','sourcePodUid','assignmentEpoch','mode','includeActivationManifest','targetHost','targetPort','targetCertificatePem','transferUser','transferKey','resourceAdmission'];
function validateTransferIdentities(r: Record<string, unknown>): void {
 for (const k of ['executionId','operationId','migrationId','uid','sourceGatewayId','sourcePodUid','transferUser']) {
  if (typeof r[k] !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(r[k])) throw new Error('invalid transfer identity');
 }
 for (const k of ['claimStartedAt','assignmentEpoch']) {
  if (!Number.isSafeInteger(r[k]) || (r[k] as number) < 1) throw new Error('invalid transfer epoch');
 }
 if (typeof r.slug !== 'string' || !isValidUsername(r.slug) || !(r.sourceGatewayId as string).startsWith('shared-')) throw new Error('invalid source identity');
}
function validateTransferTarget(r: Record<string, unknown>): void {
 if (typeof r.includeActivationManifest !== 'boolean' || typeof r.targetHost !== 'string' || !isIP(r.targetHost) || !Number.isInteger(r.targetPort) || (r.targetPort as number) < 1 || (r.targetPort as number) > 65535 || !isMigrationCertificatePem(r.targetCertificatePem)) throw new Error('invalid transfer target');
 if (typeof r.transferKey !== 'string' || r.transferKey.length < 1 || r.transferKey.length > 4096 || /[\r\n\0]/.test(r.transferKey)) throw new Error('invalid transfer credential');
}
export function parseSourceTransferRequest(value: unknown, executionId: string, podUid: string): SourceTransferRequest {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid transfer request');
 const r = value as Record<string, unknown>;
 if (Object.keys(r).length !== fields.length || fields.some(k => !(k in r))) throw new Error('invalid transfer fields');
 validateTransferIdentities(r);
 validateTransferTarget(r);
 validateResourceAdmission(r.resourceAdmission);
 if (r.version !== 1 || r.mode !== 'final' || r.executionId !== executionId || r.sourcePodUid !== podUid) throw new Error('transfer authority mismatch');
 return r as unknown as SourceTransferRequest;
}
export function sharedMigrationAgentIds(stateDir: string, slug: string): string[] {
 if (!isValidUsername(slug)) throw new Error('invalid user slug');
 const ids = new Set([`octogee-${slug}-coach`]);
 const dir = path.join(stateDir, 'agents');
 if (fs.existsSync(dir) && !fs.lstatSync(dir).isDirectory()) throw new Error('agent root is not a directory');
 if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  if (!agentIdBelongsToSlug(entry.name, slug)) continue;
  if (!entry.isDirectory()) throw new Error('owned agent state is not a directory');
  ids.add(entry.name);
 }
 return [...ids].sort();
}
export async function sharedMigrationExportPaths(root: string, slug: string): Promise<TransferSource[]> {
 const { userFileStatePaths } = await import('./user-file-state.js');
 const candidates = [...sharedMigrationAgentIds(root, slug).map(id => ({ cwd: root, path: path.join('agents', id) })), ...await userFileStatePaths(root, slug)];
 const result: TransferSource[] = [];
 for (const source of candidates) { try { await fsp.lstat(path.join(source.cwd, source.path)); result.push(source); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
 return result;
}
export function sourcesForPushMode(sources: TransferSource[], slug: string, mode?: string): TransferSource[] {
 const key = path.join('customer-keys', slug);
 if (mode === 'keys') return sources.filter(s => s.path === key);
 if (mode === 'pre' || mode === 'final') return sources.filter(s => s.path !== key);
 return sources;
}
export async function admitSourceTree(root: string, slug: string, sources: TransferSource[], limits: { maxBytes?: number; maxFiles?: number } = {}): Promise<{ bytes: number; files: number }> {
 let bytes = 0, files = 0, entries = 0;
 const canonical = await fsp.realpath(root);
 if (canonical !== path.resolve(root)) throw new Error('source root is not canonical');
 async function walk(file: string): Promise<void> {
  entries++;
  if (entries > (limits.maxFiles ?? SOURCE_TRANSFER_LIMITS.maxFiles)) throw new Error('source exceeds entry limit');
  const relative = path.relative(canonical, file).split(path.sep).join('/');
  if (isCodexTemporaryDirectory(relative)) return;
  const stat = await fsp.lstat(file);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('unsupported source file type');
  if (stat.isDirectory()) {
   for (const child of await fsp.readdir(file)) { await walk(path.join(file, child)); }
   return;
  }
  if (isCodexDatabase(relative.replace(/-(?:wal|shm|journal)$/, ''))) return;
  bytes += stat.size; files++;
  if (bytes > (limits.maxBytes ?? SOURCE_TRANSFER_LIMITS.maxBytes) || files > (limits.maxFiles ?? SOURCE_TRANSFER_LIMITS.maxFiles)) throw new Error('source exceeds transfer limits');
 }
 for (const source of sources) {
  const parts = source.path.split(path.sep);
  const owned = (parts.length === 2 && ['customers','git-metadata','customer-keys'].includes(parts[0]!) && parts[1] === slug) || (parts.length === 2 && parts[0] === 'agents' && agentIdBelongsToSlug(parts[1]!, slug));
  if (path.resolve(source.cwd) !== canonical || !owned || parts.some(p => p === '..' || p === '.')) throw new Error('foreign source path');
  for (let i = 1; i <= parts.length; i++) if (!(await fsp.lstat(path.join(canonical, ...parts.slice(0, i)))).isDirectory()) throw new Error('source ancestor is not a directory');
  await walk(path.join(canonical, source.path));
 }
 return { bytes, files };
}

function validateResourceAdmission(value: unknown): void {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('missing resource admission');
 const r = value as Record<string, unknown>;
 const keys = ['observedAt', 'sourceMemoryMax', 'sourceMemoryCurrent'];
 if (Object.keys(r).length !== keys.length) throw new Error('invalid resource admission');
 for (const key of keys) if (!Number.isSafeInteger(r[key]) || (r[key] as number) < 0) throw new Error('invalid resource admission');
 if ((r.sourceMemoryMax as number) - (r.sourceMemoryCurrent as number) < 4096 * 1024 ** 2) throw new Error('insufficient source headroom');
}
