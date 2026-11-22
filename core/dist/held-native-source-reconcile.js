import { projectAgentId } from "@octogee/shared/types/identity";
import { createHash } from "node:crypto";
import { snapshotConfigFingerprint } from "./broker-snapshot-fingerprint.js";
import { validateActivationManifest } from "./migration-activation-manifest.js";
function requireAcknowledgement(wanted, received) {
    if (wanted.migrationId !== received.migrationId || wanted.slug !== received.slug) {
        throw new Error("Held source acknowledged a different migration");
    }
}
function requireSnapshot(identity, snapshot) {
    if (snapshot.uid !== identity.uid || snapshot.gatewayId !== identity.gatewayId || snapshot.slug !== identity.slug ||
        snapshot.runtimeMutationFenced !== true || snapshot.status !== "complete" || snapshot.runtimeReset || snapshot.restoreAuthority) {
        throw new Error("Held source snapshot has different custody");
    }
}
async function drainHeldSource(identity, deps) {
    await deps.assertCurrent();
    const quiescence = await deps.client.quiesce();
    requireAcknowledgement(identity, quiescence);
    if (!quiescence.drained || quiescence.runningCount !== 0)
        throw new Error("Held source failed to drain");
}
function validateHeldSourceExport(identity, snapshot, exported, fingerprint) {
    const manifest = validateActivationManifest(exported, identity.slug);
    const actualRoster = [manifest.agentId, ...manifest.projectAgents.map(agent => agent.agentId)].sort();
    const expectedRoster = [...snapshot.agentIds].sort();
    const projectTokens = new Map((snapshot.projectAgents ?? []).filter(agent => agent.enabled && agent.token)
        .map(agent => [projectAgentId(identity.slug, agent.projectId), agent.token]));
    if (manifest.projectAgents.some(agent => projectTokens.get(agent.agentId) !== agent.mattermostAccount.botToken)) {
        throw new Error("Held source project identity differs from the broker snapshot");
    }
    if (manifest.appliedFingerprint !== fingerprint || manifest.mattermostAccount.botToken !== snapshot.coachToken ||
        actualRoster.length !== expectedRoster.length || actualRoster.some((id, i) => id !== expectedRoster[i])) {
        throw new Error("Held source activation export differs from its broker snapshot");
    }
    return expectedRoster;
}
export async function reconcileHeldNativeSource(identity, deps) {
    const { assertCurrent, readSnapshot, client } = deps;
    await assertCurrent();
    const snapshot = await readSnapshot();
    requireSnapshot(identity, snapshot);
    const fingerprint = snapshotConfigFingerprint(snapshot, new Date(deps.now()));
    await assertCurrent();
    try {
        const applied = await client.restore(snapshot);
        requireAcknowledgement(identity, applied);
        if (!applied.restored || !["config-patch", "byot-reassert", "context-files-reassert", "verify-channel-ready"].every(step => applied.steps.includes(step))) {
            throw new Error("Held source reconciliation did not apply the full configuration");
        }
    }
    finally {
        await drainHeldSource(identity, deps);
    }
    await assertCurrent();
    const flushed = await client.flush();
    requireAcknowledgement(identity, flushed);
    if (!flushed.ok || flushed.steps.some(step => step.status === "failed") ||
        !flushed.steps.some(step => step.name === "customer-files" && step.status === "done")) {
        throw new Error("Held source did not complete the Native return home flush");
    }
    await assertCurrent();
    const exported = await client.exportManifest();
    requireAcknowledgement(identity, exported);
    const expectedRoster = validateHeldSourceExport(identity, snapshot, exported.manifest, fingerprint);
    await assertCurrent();
    const current = await readSnapshot();
    requireSnapshot(identity, current);
    if (snapshotConfigFingerprint(current, new Date(deps.now())) !== fingerprint ||
        JSON.stringify([...current.agentIds].sort()) !== JSON.stringify(expectedRoster))
        throw new Error("Held source desired configuration changed during reconciliation");
    await assertCurrent();
    return { verifiedAt: deps.now(), appliedFingerprint: fingerprint,
        activationManifestSha256: createHash("sha256").update(JSON.stringify(exported.manifest)).digest("hex") };
}
