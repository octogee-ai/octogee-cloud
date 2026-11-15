import { exportDigest, type AgentExportSnapshot } from "./agent-export-snapshot.js";
export interface AgentExportSource { uid: string; slug: string; gatewayId: string; epoch: number; agentId: string; project: string | null }
export interface AgentExportDestination { owner: string; repo: string; branch: string; head: string; tree: string; files: Array<{ path: string; mode: string; type: string; sha: string }> }
export interface AgentExportRecord {
  kind: "authored-agent-export"; id: string; uid: string; slug: string; gatewayId: string;
  source: AgentExportSource; destination: Omit<AgentExportDestination, "files">;
  status: "previewed" | "publishing" | "complete";
  changes: Array<{ path: string; action: "add" | "overwrite"; size: number }>;
  sourceDigest: string; assetIdentity: string; approvalHash: string;
  createdAt: string; updatedAt: string; expectedCommit?: string; commitUrl?: string;
}
export interface AgentExportDeps {
  authorize(agentId: string): Promise<AgentExportSource>;
  capture(source: AgentExportSource): Promise<AgentExportSnapshot>;
  destination(repo: { owner: string; repo: string }): Promise<AgentExportDestination>;
  prepareCommit(record: AgentExportRecord, snapshot: AgentExportSnapshot): Promise<string>;
  readHead(record: AgentExportRecord): Promise<string>;
  publish(record: AgentExportRecord, assertCurrent: () => Promise<void>): Promise<void>;
  put(record: AgentExportRecord): Promise<void>;
  get(id: string): Promise<AgentExportRecord | null>;
  putSnapshot(id: string, snapshot: AgentExportSnapshot): Promise<void>;
  getSnapshot(id: string): Promise<AgentExportSnapshot>;
  now(): Date;
  id(): string;
}
export function agentExportApproval(record: AgentExportRecord): string {
  return exportDigest({ kind: record.kind, id: record.id, uid: record.uid, slug: record.slug, gatewayId: record.gatewayId, source: record.source, destination: record.destination, changes: record.changes, sourceDigest: record.sourceDigest, assetIdentity: record.assetIdentity, createdAt: record.createdAt });
}
function assertSource(current: AgentExportSource, original: AgentExportSource): void {
  if (exportDigest(current) !== exportDigest(original)) throw new Error("authored export source authority changed");
}
function changes(snapshot: AgentExportSnapshot, destination: AgentExportDestination): AgentExportRecord["changes"] {
  return snapshot.files.map(file => {
    const conflict = destination.files.find(existing => existing.path.startsWith(`${file.path}/`) || file.path.startsWith(`${existing.path}/`) && existing.type !== "tree" || existing.path === file.path && (existing.type !== "blob" || !["100644", "100755"].includes(existing.mode)));
    if (conflict) throw new Error(`destination path conflict: ${file.path}`);
    return { path: file.path, action: destination.files.some(existing => existing.path === file.path) ? "overwrite" : "add", size: file.size };
  });
}
export class AgentExportService {
  constructor(private readonly deps: AgentExportDeps) {}
  async preview(agentId: string, repo: { owner: string; repo: string }): Promise<AgentExportRecord> {
    const source = await this.deps.authorize(agentId);
    const snapshot = await this.deps.capture(source);
    const destination = await this.deps.destination(repo);
    assertSource(await this.deps.authorize(agentId), source);
    const { files: _files, ...target } = destination;
    const record: AgentExportRecord = { kind: "authored-agent-export", id: this.deps.id(), uid: source.uid, slug: source.slug, gatewayId: source.gatewayId,
      source, destination: target, status: "previewed", changes: changes(snapshot, destination), sourceDigest: snapshot.digest, assetIdentity: snapshot.assetIdentity,
      createdAt: this.deps.now().toISOString(), updatedAt: this.deps.now().toISOString(), approvalHash: "" };
    record.approvalHash = agentExportApproval(record);
    await this.deps.put(record);
    await this.deps.putSnapshot(record.id, snapshot);
    return record;
  }
  async apply(id: string, approvalHash: string): Promise<AgentExportRecord> {
    const record = await this.deps.get(id);
    if (record?.kind !== "authored-agent-export" || record.id !== id || record.approvalHash !== approvalHash) throw new Error("invalid authored export approval");
    if (record.status === "complete") return record;
    if (record.expectedCommit && await this.deps.readHead(record) === record.expectedCommit) return this.complete(record);
    if (Date.parse(record.createdAt) + 24 * 60 * 60_000 <= this.deps.now().getTime()) throw new Error("authored export preview expired");
    assertSource(await this.deps.authorize(record.source.agentId), record.source);
    const current = await this.deps.capture(record.source);
    if (current.digest !== record.sourceDigest || current.assetIdentity !== record.assetIdentity) throw new Error("authored export source content changed; preview again");
    const snapshot = await this.savedSnapshot(record);
    if (await this.deps.readHead(record) !== record.destination.head) throw new Error("destination changed; preview again");
    assertSource(await this.deps.authorize(record.source.agentId), record.source);
    await this.prepare(record, snapshot);
    if (await this.deps.readHead(record) !== record.destination.head) throw new Error("destination changed before publication; preview again");
    assertSource(await this.deps.authorize(record.source.agentId), record.source);
    await this.publishAndVerify(record);
    return this.complete(record);
  }
  private async publishAndVerify(record: AgentExportRecord): Promise<void> {
    try { await this.deps.publish(record, async () => { assertSource(await this.deps.authorize(record.source.agentId), record.source); }); }
    catch (error) { if (await this.deps.readHead(record) !== record.expectedCommit) throw error; }
    if (await this.deps.readHead(record) !== record.expectedCommit) throw new Error("export publication is not confirmed; retry to check its commit");
  }
  private async prepare(record: AgentExportRecord, snapshot: AgentExportSnapshot): Promise<void> {
    if (!record.expectedCommit) {
      record.expectedCommit = await this.deps.prepareCommit(record, snapshot);
      if (!/^[a-f0-9]{40}$/u.test(record.expectedCommit)) throw new Error("invalid export commit identity");
      record.status = "publishing"; record.updatedAt = this.deps.now().toISOString();
      await this.deps.put(record);
    }
  }
  private async savedSnapshot(record: AgentExportRecord): Promise<AgentExportSnapshot> {
    const snapshot = await this.deps.getSnapshot(record.id);
    if (snapshot.digest !== record.sourceDigest || snapshot.assetIdentity !== record.assetIdentity || exportDigest(snapshot.files) !== snapshot.digest) throw new Error("authored export snapshot changed");
    return snapshot;
  }
  private async complete(record: AgentExportRecord): Promise<AgentExportRecord> {
    record.status = "complete"; record.updatedAt = this.deps.now().toISOString();
    record.commitUrl = `https://github.com/${record.destination.owner}/${record.destination.repo}/commit/${record.expectedCommit}`;
    await this.deps.put(record);
    return record;
  }
}

export async function withinAgentExportDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let expire!: () => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    expire = () => reject(Object.assign(new Error("Export request deadline reached. Retry to check any publication receipt."), { status: 504, code: "export_unconfirmed" }));
    if (signal.aborted) expire(); else signal.addEventListener("abort", expire, { once: true });
  });
  try { return await Promise.race([operation, deadline]); }
  finally { signal.removeEventListener("abort", expire); }
}
