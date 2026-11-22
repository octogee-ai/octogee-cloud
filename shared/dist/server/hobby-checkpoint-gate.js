import { randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { isValidGatewayId } from "../types/glm.js";
import { isValidUsername } from "../types/identity.js";
import { isUserOwnerUid } from "../types/user-identity.js";
const CLAIM_PATH = "/var/run/octogee/checkpoint-claim/claim.json";
const LIVE_OWNER_PATH = "/var/run/octogee/checkpoint-owner/owner.json";
const RECOVERY_PATH = "/var/run/octogee/checkpoint-credentials/recovery.json";
const RESTORED_ENV_PATH = "/proc/gvisor/spec_environ";
const POD_UID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SNAPSHOT_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
function validClaimOwner(claim) {
    return claim.assignmentEpoch === 0 && isValidGatewayId(claim.gatewayId) && claim.slotId === claim.gatewayId &&
        typeof claim.podUid === "string" && POD_UID.test(claim.podUid) && isUserOwnerUid(claim.uid) && isValidUsername(claim.slug);
}
function validRecoveryClaim(value) {
    if (!value || typeof value !== "object")
        return false;
    const recovery = value;
    return typeof recovery.attemptId === "string" && /^[0-9a-f]{64}$/.test(recovery.attemptId) &&
        (recovery.phase === "seal" || recovery.phase === "install") && typeof recovery.gatewayImageTag === "string" &&
        /^[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$/.test(recovery.gatewayImageTag);
}
function parseClaim(value) {
    if (!value || typeof value !== "object")
        return null;
    const claim = value;
    if (!validClaimOwner(claim) || claim.recovery !== undefined)
        return null;
    if (claim.version === 1 && claim.mode === undefined &&
        typeof claim.snapshotName === "string" && SNAPSHOT_NAME.test(claim.snapshotName))
        return claim;
    if (claim.version === 2 && claim.mode === "live" && claim.snapshotName === undefined &&
        typeof claim.namespace === "string" && SNAPSHOT_NAME.test(claim.namespace))
        return claim;
    return null;
}
export function readCheckpointRestore(boot, fresh, receipt) {
    const claim = parseClaim(receipt);
    if (claim?.version !== 1 || boot.OCTOGEE_CHECKPOINT_SNAPSHOT || !boot.POD_UID ||
        !POD_UID.test(boot.POD_UID) || boot.POD_UID === fresh.POD_UID ||
        !boot.K8S_NAMESPACE || boot.K8S_NAMESPACE !== fresh.K8S_NAMESPACE)
        return null;
    if (boot.GATEWAY_ID !== claim.gatewayId || fresh.GATEWAY_ID !== claim.gatewayId ||
        boot.OCTOGEE_CHECKPOINT_SLOT_ID !== claim.slotId || fresh.OCTOGEE_CHECKPOINT_SLOT_ID !== claim.slotId ||
        fresh.OCTOGEE_CHECKPOINT_SNAPSHOT !== claim.snapshotName || fresh.POD_UID !== claim.podUid)
        return null;
    return claim;
}
function restoreEnvironment(body) {
    return Object.fromEntries(body.split("\0").filter(line => line.includes("=")).map(line => {
        const delimiter = line.indexOf("=");
        return [line.slice(0, delimiter), line.slice(delimiter + 1)];
    }));
}
export async function readMountedCheckpointClaim() {
    try {
        const claim = parseClaim(JSON.parse(await readFile(CLAIM_PATH, "utf8")));
        if (!claim)
            throw new Error("Invalid gateway checkpoint claim projection");
        return claim;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
async function readMountedRecovery(claim) {
    let value;
    try {
        value = JSON.parse(await readFile(RECOVERY_PATH, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    const projection = value;
    if (!validRecoveryClaim(value) || projection.uid !== claim.uid || projection.slug !== claim.slug ||
        projection.assignmentEpoch !== claim.assignmentEpoch || projection.namespace !== claim.namespace ||
        projection.gatewayId !== claim.gatewayId || projection.slotId !== claim.slotId || projection.podUid !== claim.podUid) {
        throw new Error("Hobby retained recovery projection does not match this exact owner and Pod");
    }
    return { attemptId: value.attemptId, phase: value.phase, gatewayImageTag: value.gatewayImageTag };
}
async function rememberLiveOwner(claim) {
    const owner = JSON.stringify([claim.uid, claim.slug, claim.assignmentEpoch, claim.slotId, claim.podUid, claim.namespace]);
    if (claim.recovery) {
        if (await readFile(LIVE_OWNER_PATH, "utf8") !== owner)
            throw new Error("Hobby retained recovery owner latch changed");
        return;
    }
    const staged = `${LIVE_OWNER_PATH}.${randomUUID()}`;
    await writeFile(staged, owner, { mode: 0o600, flag: "wx" });
    try {
        await link(staged, LIVE_OWNER_PATH);
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        if (await readFile(LIVE_OWNER_PATH, "utf8") !== owner)
            throw new Error("Live standby is already bound to another owner");
    }
    finally {
        await unlink(staged);
    }
}
function assertLiveCheckpointClaim(boot, claim) {
    if (claim.version !== 2 || claim.namespace !== boot.K8S_NAMESPACE || claim.podUid !== boot.POD_UID ||
        claim.gatewayId !== boot.GATEWAY_ID || claim.slotId !== boot.OCTOGEE_CHECKPOINT_SLOT_ID) {
        throw new Error("Gateway live standby does not match this exact claimed pod");
    }
}
export function checkpointDesktop(claim, boot) {
    if (claim.version === 1)
        return boot.GATEWAY_COMPUTER_DESKTOP;
    if (claim.recovery) {
        if (boot.GATEWAY_RUNTIME_KIND !== "cluster" || boot.GATEWAY_COMPUTER_DESKTOP !== "x11") {
            throw new Error("Hobby retained recovery requires the original isolated Pod runtime");
        }
        return "none";
    }
    if (boot.GATEWAY_COMPUTER_DESKTOP !== "none")
        throw new Error("Hobby live standby must be headless");
    return "none";
}
async function admitLiveCheckpoint(boot, receipt, prefix, state) {
    assertLiveCheckpointClaim(boot, receipt);
    const recovery = await readMountedRecovery(receipt);
    if (!recovery && boot.GATEWAY_COMPUTER_DESKTOP === "x11" && !state.sealed)
        return null;
    const sealed = state.sealed;
    if (sealed && (recovery?.attemptId !== sealed.attemptId || recovery.gatewayImageTag !== sealed.gatewayImageTag)) {
        throw new Error("Hobby live recovery claim changed after seal");
    }
    const authorized = recovery ? { ...receipt, recovery } : receipt;
    checkpointDesktop(authorized, boot);
    await rememberLiveOwner(authorized);
    if (recovery?.phase !== "seal") {
        await checkpointGatewayCredentials();
        return authorized;
    }
    if (!sealed) {
        state.sealed = recovery;
        await writeFile(`${prefix}-recovery-sealed`, JSON.stringify([recovery.attemptId, authorized.podUid, recovery.gatewayImageTag]), { mode: 0o600 });
    }
    return null;
}
export async function waitForCheckpointClaim(role) {
    const boot = process.env;
    const prefix = `/tmp/octogee-hobby-checkpoint-${role}`;
    const live = boot.OCTOGEE_CHECKPOINT_MODE === "live";
    if (live && boot.OCTOGEE_CHECKPOINT_SNAPSHOT)
        throw new Error("Live standby cannot restore a snapshot");
    if (boot.OCTOGEE_CHECKPOINT_SNAPSHOT) {
        return resumeClaimedCheckpoint(boot, prefix);
    }
    const podUid = boot.POD_UID;
    if (!boot.OCTOGEE_CHECKPOINT_SLOT_ID || boot.OCTOGEE_CHECKPOINT_SLOT_ID !== boot.GATEWAY_ID ||
        !podUid || !POD_UID.test(podUid))
        throw new Error("Expected the original unclaimed gateway checkpoint process");
    await writeFile(`${prefix}-prepared`, podUid, { mode: 0o600 });
    const state = {};
    for (;;) {
        const receipt = await readMountedCheckpointClaim();
        if (receipt !== null) {
            if (live) {
                const admitted = await admitLiveCheckpoint(boot, receipt, prefix, state);
                if (admitted)
                    return admitted;
                await setTimeout(500);
                continue;
            }
            const current = restoreEnvironment(await readFile(RESTORED_ENV_PATH, "utf8"));
            const claim = readCheckpointRestore(boot, current, receipt);
            if (!claim)
                throw new Error("Gateway checkpoint does not match this restored slot and pod");
            await checkpointGatewayCredentials();
            await writeFile(`${prefix}-restored`, claim.podUid, { mode: 0o600 });
            return claim;
        }
        await setTimeout(500);
    }
}
export function matchesRestartedCheckpoint(env, claim, restoredPodUid) {
    return claim?.version === 1 && env.POD_UID === claim.podUid && restoredPodUid === claim.podUid &&
        env.GATEWAY_ID === claim.gatewayId && env.OCTOGEE_CHECKPOINT_SLOT_ID === claim.slotId &&
        env.OCTOGEE_CHECKPOINT_SNAPSHOT === claim.snapshotName;
}
async function resumeClaimedCheckpoint(env, prefix) {
    const claim = await readMountedCheckpointClaim();
    const restoredPodUid = await readFile(`${prefix}-restored`, "utf8").catch((error) => {
        if (error.code === "ENOENT")
            return "";
        throw error;
    });
    if (!matchesRestartedCheckpoint(env, claim, restoredPodUid)) {
        throw new Error("Expected previous checkpoint restoration in the same admitted pod");
    }
    await checkpointGatewayCredentials();
    return claim;
}
async function readCheckpointCredentials() {
    const [token, agentStoreDsn] = await Promise.all([
        readFile("/var/run/octogee/checkpoint-credentials/token", "utf8"),
        readFile("/var/run/octogee/checkpoint-credentials/agent-store-dsn", "utf8"),
    ]);
    return { token, agentStoreDsn };
}
export async function assertRetainedHobbySeal(attemptId, role) {
    const boot = process.env;
    const claim = await readMountedCheckpointClaim();
    if (!claim)
        throw new Error("Hobby retained seal has no original claim");
    assertLiveCheckpointClaim(boot, claim);
    const recovery = await readMountedRecovery(claim);
    if (recovery?.phase !== "seal" || recovery.attemptId !== attemptId) {
        throw new Error("Hobby retained seal is unavailable");
    }
    await rememberLiveOwner({ ...claim, recovery });
    const markerPath = `/tmp/octogee-hobby-checkpoint-${role}-recovery-sealed`;
    const expected = JSON.stringify([attemptId, claim.podUid, recovery.gatewayImageTag]);
    if (await readFile(markerPath, "utf8") !== expected)
        throw new Error("Hobby retained seal role is not confirmed");
    return recovery;
}
export async function checkpointGatewayCredentials(read = readCheckpointCredentials, wait = () => setTimeout(500)) {
    for (;;) {
        try {
            const credentials = await read();
            const token = credentials.token.trim();
            const agentStoreDsn = credentials.agentStoreDsn.trim();
            if (!token || !agentStoreDsn) {
                throw new Error("Gateway checkpoint credentials are unavailable");
            }
            return { token, agentStoreDsn };
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        await wait();
    }
}
export async function initializeCheckpointEdge(isSidecar) {
    const env = process.env;
    if (!env.OCTOGEE_CHECKPOINT_SLOT_ID)
        return;
    if (!isSidecar)
        throw new Error("A gateway checkpoint requires a private edge sidecar");
    const claim = await waitForCheckpointClaim("edge");
    const credentials = await checkpointGatewayCredentials();
    env.POD_UID = claim.podUid;
    if (claim.version === 2) {
        env.GATEWAY_COMPUTER_DESKTOP = checkpointDesktop(claim, env);
        if (claim.recovery)
            env.GATEWAY_IMAGE_TAG = claim.recovery.gatewayImageTag;
    }
    env.OPENCLAW_GATEWAY_TOKEN = credentials.token;
    env.OPENCLAW_AGENT_STORE_DSN = credentials.agentStoreDsn;
    process.stderr.write("[hobby-checkpoint] edge claim and credentials ready\n");
}
