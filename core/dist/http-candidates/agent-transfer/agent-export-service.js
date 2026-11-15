import { exportDigest } from "./agent-export-snapshot.js";
export function agentExportApproval(record) {
    return exportDigest({ kind: record.kind, id: record.id, uid: record.uid, slug: record.slug, gatewayId: record.gatewayId, source: record.source, destination: record.destination, changes: record.changes, sourceDigest: record.sourceDigest, assetIdentity: record.assetIdentity, createdAt: record.createdAt });
}
function assertSource(current, original) {
    if (exportDigest(current) !== exportDigest(original))
        throw new Error("authored export source authority changed");
}
function changes(snapshot, destination) {
    return snapshot.files.map(file => {
        const conflict = destination.files.find(existing => existing.path.startsWith(`${file.path}/`) || file.path.startsWith(`${existing.path}/`) && existing.type !== "tree" || existing.path === file.path && (existing.type !== "blob" || !["100644", "100755"].includes(existing.mode)));
        if (conflict)
            throw new Error(`destination path conflict: ${file.path}`);
        return { path: file.path, action: destination.files.some(existing => existing.path === file.path) ? "overwrite" : "add", size: file.size };
    });
}
export class AgentExportService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async preview(agentId, repo) {
        const source = await this.deps.authorize(agentId);
        const snapshot = await this.deps.capture(source);
        const destination = await this.deps.destination(repo);
        assertSource(await this.deps.authorize(agentId), source);
        const { files: _files, ...target } = destination;
        const record = { kind: "authored-agent-export", id: this.deps.id(), uid: source.uid, slug: source.slug, gatewayId: source.gatewayId,
            source, destination: target, status: "previewed", changes: changes(snapshot, destination), sourceDigest: snapshot.digest, assetIdentity: snapshot.assetIdentity,
            createdAt: this.deps.now().toISOString(), updatedAt: this.deps.now().toISOString(), approvalHash: "" };
        record.approvalHash = agentExportApproval(record);
        await this.deps.put(record);
        await this.deps.putSnapshot(record.id, snapshot);
        return record;
    }
    async apply(id, approvalHash) {
        const record = await this.deps.get(id);
        if (record?.kind !== "authored-agent-export" || record.id !== id || record.approvalHash !== approvalHash)
            throw new Error("invalid authored export approval");
        if (record.status === "complete")
            return record;
        if (record.expectedCommit && await this.deps.readHead(record) === record.expectedCommit)
            return this.complete(record);
        if (Date.parse(record.createdAt) + 24 * 60 * 60_000 <= this.deps.now().getTime())
            throw new Error("authored export preview expired");
        assertSource(await this.deps.authorize(record.source.agentId), record.source);
        const current = await this.deps.capture(record.source);
        if (current.digest !== record.sourceDigest || current.assetIdentity !== record.assetIdentity)
            throw new Error("authored export source content changed; preview again");
        const snapshot = await this.savedSnapshot(record);
        if (await this.deps.readHead(record) !== record.destination.head)
            throw new Error("destination changed; preview again");
        assertSource(await this.deps.authorize(record.source.agentId), record.source);
        await this.prepare(record, snapshot);
        if (await this.deps.readHead(record) !== record.destination.head)
            throw new Error("destination changed before publication; preview again");
        assertSource(await this.deps.authorize(record.source.agentId), record.source);
        await this.publishAndVerify(record);
        return this.complete(record);
    }
    async publishAndVerify(record) {
        try {
            await this.deps.publish(record, async () => { assertSource(await this.deps.authorize(record.source.agentId), record.source); });
        }
        catch (error) {
            if (await this.deps.readHead(record) !== record.expectedCommit)
                throw error;
        }
        if (await this.deps.readHead(record) !== record.expectedCommit)
            throw new Error("export publication is not confirmed; retry to check its commit");
    }
    async prepare(record, snapshot) {
        if (!record.expectedCommit) {
            record.expectedCommit = await this.deps.prepareCommit(record, snapshot);
            if (!/^[a-f0-9]{40}$/u.test(record.expectedCommit))
                throw new Error("invalid export commit identity");
            record.status = "publishing";
            record.updatedAt = this.deps.now().toISOString();
            await this.deps.put(record);
        }
    }
    async savedSnapshot(record) {
        const snapshot = await this.deps.getSnapshot(record.id);
        if (snapshot.digest !== record.sourceDigest || snapshot.assetIdentity !== record.assetIdentity || exportDigest(snapshot.files) !== snapshot.digest)
            throw new Error("authored export snapshot changed");
        return snapshot;
    }
    async complete(record) {
        record.status = "complete";
        record.updatedAt = this.deps.now().toISOString();
        record.commitUrl = `https://github.com/${record.destination.owner}/${record.destination.repo}/commit/${record.expectedCommit}`;
        await this.deps.put(record);
        return record;
    }
}
export async function withinAgentExportDeadline(operation, signal) {
    let expire;
    const deadline = new Promise((_resolve, reject) => {
        expire = () => reject(Object.assign(new Error("Export request deadline reached. Retry to check any publication receipt."), { status: 504, code: "export_unconfirmed" }));
        if (signal.aborted)
            expire();
        else
            signal.addEventListener("abort", expire, { once: true });
    });
    try {
        return await Promise.race([operation, deadline]);
    }
    finally {
        signal.removeEventListener("abort", expire);
    }
}
