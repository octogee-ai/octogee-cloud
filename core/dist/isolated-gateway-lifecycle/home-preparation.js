import { createHash } from "node:crypto";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { withCurrentSizingKey } from "../sizing-key.js";
import { HomeCopyFailure, homeCopyCapacity, isActiveHomeMigration, userHomeOwner, } from "./home.js";
import { IsolatedGatewayFenceError, checkPlacementOwner, } from "./inputs.js";
export class HomeComputeUnavailableError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "HomeComputeUnavailableError";
    }
}
const HOME_COPY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60_000;
const EXPIRED_HOME_AFTER_MS = 7 * 24 * 60 * 60_000;
const RECENT_RETAIN_MS = 24 * 60 * 60_000;
const LEASE_STATUSES_AFTER_REQUEST = new Set(["provisioning", "activating", "active", "returning"]);
export function assertHomePreparationAuthority(owner, sizingKey, request) {
    const lease = owner.activationLease;
    if (!accountAllowsInteractiveAccess({ accountLifecycle: owner.accountLifecycle ?? undefined }) || sizingKey !== request.sizingKey ||
        owner.gateway?.gatewayId !== request.sourceGatewayId || lease?.leaseId !== request.leaseId || lease.generation !== request.generation ||
        lease.status !== "requested" || lease.targetGatewayId !== undefined || lease.sourceAssignmentEpoch !== request.sourceAssignmentEpoch ||
        lease.entitlementTier !== request.sizingKey || lease.sizingTier !== request.sizingTier) {
        throw new IsolatedGatewayFenceError("home migration activation authority changed");
    }
}
function stored(value) {
    return value;
}
function assertNativeCopy(state) {
    const legacy = state;
    if (legacy.copy.targetFilesystem === "ext4" || legacy.target?.claim !== undefined || legacy.proof?.filesystem !== "btrfs") {
        throw new Error("home migration targets a cluster home; retired cluster home records need operator cleanup");
    }
}
function preparedMatches(prepared, wanted) {
    return prepared?.leaseId === wanted.leaseId && prepared.generation === wanted.generation && prepared.sizingKey === wanted.sizingKey;
}
class HomePreparationRun {
    deps;
    request;
    vmPolicy = null;
    step = "start";
    constructor(deps, request) {
        this.deps = deps;
        this.request = request;
    }
    get preparedFor() {
        return { leaseId: this.request.leaseId, generation: this.request.generation, sizingKey: this.request.sizingKey };
    }
    get policy() {
        if (!this.vmPolicy)
            throw new Error("home migration requires a VM tier policy");
        return this.vmPolicy;
    }
    async loadPolicy() {
        const profile = await this.deps.store.config.orchestrator.getSizingProfile(this.request.sizingKey);
        if (profile.isolation !== "isolated" || profile.computer.runtime !== "gce-vm")
            throw new IsolatedGatewayFenceError("home migration requires a VM tier policy");
        this.vmPolicy = profile.computer;
    }
    withCurrentTier(run) {
        return withCurrentSizingKey({ store: this.deps.store, readSizingKey: this.deps.readSizingKey, uid: this.request.uid, now: this.deps.now() }, ({ sizingKey, assertCurrent }) => run((owner) => {
            assertCurrent(owner);
            if (!owner)
                throw new IsolatedGatewayFenceError("home migration owner disappeared");
            assertHomePreparationAuthority(owner, sizingKey, this.request);
            return owner;
        }));
    }
    readUser(decide) {
        return this.withCurrentTier(async (assertOwner) => this.deps.store.transaction({ label: "builder-home-migration.read", readOnly: true }, async (tx) => {
            await this.deps.requireOwner(tx);
            return decide(await tx.users.records.get(this.request.uid), assertOwner);
        }));
    }
    async readOwner() {
        return this.readUser((owner, assertOwner) => assertOwner(owner));
    }
    async readOwnerUnlessPrepared() {
        return this.readUser((owner, assertOwner) => owner && this.preparedAndAllocated(owner) ? null : assertOwner(owner));
    }
    preparedAndAllocated(owner) {
        const state = userHomeOwner(owner).homeMigration;
        const lease = owner.activationLease;
        return state?.phase === "complete" && preparedMatches(state.preparedFor, this.preparedFor) &&
            lease?.leaseId === this.request.leaseId && lease.generation === this.request.generation && LEASE_STATUSES_AFTER_REQUEST.has(lease.status);
    }
    async effect(run) {
        await checkPlacementOwner(this.deps);
        return run(this.deps.home);
    }
    async transaction(label, update) {
        await this.withCurrentTier((assertOwner) => this.deps.store.transaction({ label: `builder-home-migration.${label}` }, async (tx) => {
            await this.deps.requireOwner(tx);
            const owner = assertOwner(await tx.users.records.get(this.request.uid));
            await tx.users.records.patch(this.request.uid, { home: update(userHomeOwner(owner)) }, { revision: owner.revision });
        }));
    }
    async save(state, home = {}) {
        await this.transaction("save", (owner) => {
            if (!isActiveHomeMigration(owner.homeMigration) || owner.homeMigration.id !== state.id)
                throw new IsolatedGatewayFenceError("home migration operation changed");
            return { ...home, homeMigration: stored(state) };
        });
    }
    async markPrepared() {
        await this.transaction("prepared", (owner) => {
            const current = owner.homeMigration;
            if (current && current.phase !== "complete")
                throw new IsolatedGatewayFenceError("home migration started before readiness was recorded");
            return { homeMigration: stored({ ...(current ?? {}), phase: "complete", preparedFor: this.preparedFor }) };
        });
        return { state: "ready" };
    }
    async removeExpiredHome(storage) {
        if (!storage || !Number.isSafeInteger(storage.admittedAt) || this.deps.now() - storage.admittedAt < EXPIRED_HOME_AFTER_MS)
            return;
        const previous = storage.retained[0];
        if (!previous)
            return;
        if (previous.disk.id === storage.disk.id)
            throw new Error("retained home cleanup cannot remove the primary home");
        if (!await this.effect((home) => home.removeStoppedHome(this.request.uid, previous)))
            return;
        await this.transaction("remove-expired-home", (owner) => {
            const current = owner.homeStorage;
            if (current?.disk.id !== storage.disk.id || current.retained[0]?.disk.id !== previous.disk.id)
                throw new IsolatedGatewayFenceError("retained home cleanup authority changed");
            return { homeStorage: stored({ ...current, retained: current.retained.slice(1) }) };
        });
    }
    async targetZone(source) {
        const existing = await this.effect((home) => home.nativeZone(this.request.uid));
        if (existing)
            return existing;
        const { nativeZones } = this.deps.home;
        const selected = nativeZones.includes(source.disk.zone) ? source.disk.zone : nativeZones[0];
        if (!selected)
            throw new Error("home migration has no native target zone");
        return selected;
    }
    async start(source) {
        await this.effect((home) => home.verifyStopped(this.request.uid, source));
        const key = [this.request.uid, source.disk.id, this.request.leaseId, this.request.generation, this.request.sizingKey].join(":");
        const id = `home-copy-${this.deps.home.environment}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
        const state = { id, tier: this.request.sizingKey, source, startedAt: this.deps.now(), phase: "copying", attempt: 1, copy: {
                operationId: id, ownerUid: this.request.uid, source: source.disk, sourceLayout: source.layout,
                targetZone: await this.targetZone(source),
                desiredGiB: this.policy.homeSizeGiB, subnetwork: this.deps.home.subnetwork,
            } };
        await this.transaction("start", (owner) => {
            const previous = owner.homeMigration;
            if (previous && previous.phase !== "complete" && (!isActiveHomeMigration(previous) || previous.id !== id)) {
                throw new IsolatedGatewayFenceError("another home migration is in progress");
            }
            return { homeMigration: stored(state) };
        });
        return state;
    }
    alreadyFits(state, source) {
        if (state && state.phase !== "complete")
            return false;
        if (source.disk.sizeGb <= this.policy.homeSizeGiB)
            return true;
        if (!isActiveHomeMigration(state))
            return false;
        return state.target?.id === source.disk.id && this.deps.now() - (state.completedAt ?? 0) < RECENT_RETAIN_MS;
    }
    async cancel(state) {
        if (!await this.effect((home) => home.copy.abort(state.copy)))
            return;
        await this.transaction("cancel", (owner) => {
            if (!isActiveHomeMigration(owner.homeMigration) || owner.homeMigration.id !== state.id)
                throw new IsolatedGatewayFenceError("home migration changed during cancellation");
            return { homeMigration: { clear: true } };
        });
    }
    async failed(state) {
        if (!await this.effect((home) => home.copy.abort(state.copy)))
            return;
        const attempts = state.attempt ?? 1;
        await this.save({ ...state, phase: attempts >= HOME_COPY_ATTEMPTS ? "blocked" : "retrying", retryAt: this.deps.now() + RETRY_DELAY_MS });
    }
    async retry(state, source) {
        if (this.deps.now() < (state.retryAt ?? 0))
            return this.inProgress();
        const next = { ...state, phase: "copying", attempt: (state.attempt ?? 1) + 1 };
        await this.save(next);
        this.step = "copying";
        return this.copy(next, source);
    }
    retainLargerHome(progress, source) {
        return progress.status !== "pending" && homeCopyCapacity({
            desiredGiB: this.policy.homeSizeGiB, sourceGiB: source.disk.sizeGb, usedBytes: progress.usedBytes,
        }) >= source.disk.sizeGb;
    }
    async copy(state, source) {
        await this.effect((home) => home.verifyStopped(this.request.uid, state.source));
        let result;
        try {
            result = await this.effect((home) => home.copy.advance(state.copy));
        }
        catch (error) {
            if (!(error instanceof HomeCopyFailure))
                throw error;
            await this.save({ ...state, phase: "failed", error: error.message });
            this.deps.log(`[home-migration] ${this.request.uid}: ${error.message}; cleaning failed copy resources before retry`);
            this.step = "failed";
            return this.inProgress();
        }
        if (this.retainLargerHome(result.progress, source)) {
            await this.save({ ...state, phase: "retaining" });
            this.step = "retaining";
        }
        else if (result.progress.status === "ready" && result.target) {
            await this.save({ ...state, phase: "releasing", target: result.target, proof: result.progress });
            this.step = "releasing";
        }
        return this.inProgress();
    }
    async retain(state, source) {
        if (!await this.effect((home) => home.copy.abort(state.copy)))
            return this.inProgress();
        await this.save({ ...state, phase: "complete", target: source.disk, completedAt: this.deps.now(), preparedFor: this.preparedFor }, {
            homeCapacity: { desiredGiB: this.policy.homeSizeGiB, allocatedGiB: source.disk.sizeGb, status: "shrink-pending", diskId: source.disk.id },
        });
        return { state: "ready" };
    }
    async release(state) {
        if (await this.effect((home) => home.copy.release(state.copy))) {
            await this.save({ ...state, phase: "adopting" });
            this.step = "adopting";
        }
        return this.inProgress();
    }
    async adopt(state) {
        const { target, proof } = state;
        if (!target || !proof)
            throw new Error("home migration has no verified target");
        assertNativeCopy(state);
        await this.readOwner();
        if (!await this.effect((home) => home.adopt({ uid: this.request.uid, target })))
            return this.inProgress();
        const homeCapacity = { desiredGiB: this.policy.homeSizeGiB, allocatedGiB: target.sizeGb, usedBytes: proof.usedBytes,
            status: target.sizeGb > this.policy.homeSizeGiB ? "shrink-pending" : "ready", diskId: target.id };
        await this.transaction("adopt", (owner) => {
            if (!isActiveHomeMigration(owner.homeMigration) || owner.homeMigration.id !== state.id)
                throw new IsolatedGatewayFenceError("home migration operation changed before activation");
            return {
                homeCapacity,
                homeDisk: stored(target),
                homeMigration: stored({ ...state, phase: "complete", completedAt: this.deps.now(), preparedFor: this.preparedFor }),
                homeStorage: stored({ runtime: "gce-vm", disk: target, layout: "portable", retained: [...(owner.homeStorage?.retained ?? []), state.source] }),
            };
        });
        this.deps.log(`[home-migration] ${this.request.uid}: verified native home ${target.id} (${target.sizeGb} GiB); previous home retained`);
        return { state: "ready" };
    }
    inProgress() {
        return { state: "in-progress", step: this.step };
    }
    get currentStep() {
        return this.step;
    }
    plan(owner) {
        const state = owner.homeMigration;
        if (state?.phase === "complete" && preparedMatches(state.preparedFor, this.preparedFor))
            return { state: "ready" };
        if (isActiveHomeMigration(state) && state.phase === "blocked")
            return this.blocked(state);
        return { state: "in-progress", step: !state || state.phase === "complete" || state.phase === "blocked" ? "start" : state.phase };
    }
    blocked(state) {
        return {
            state: "blocked",
            reason: `home migration requires operator repair after three failed copies; original retained: ${state.error}`,
            attempts: state.attempt ?? 1,
        };
    }
    async reconcile(owner) {
        const state = owner.homeMigration;
        if (isActiveHomeMigration(state) && state.phase !== "complete" && state.phase !== "blocked")
            this.step = state.phase;
        await this.removeExpiredHome(owner.homeStorage);
        const source = await this.effect((home) => home.inventory(this.request.uid, owner));
        if (!source && isActiveHomeMigration(state) && state.phase !== "complete") {
            throw new Error(`home migration ${state.id} is ${state.phase} but ${this.request.uid} has no home disk`);
        }
        if (!source || this.alreadyFits(state, source)) {
            return state?.phase === "complete" && preparedMatches(state.preparedFor, this.preparedFor) ? { state: "ready" } : this.markPrepared();
        }
        const active = isActiveHomeMigration(state) && state.phase !== "complete" ? state : await this.start(source);
        this.step = active.phase === "blocked" ? "start" : active.phase;
        if (active.source.disk.id !== source.disk.id && active.phase !== "adopting")
            throw new Error("home migration source changed; original disks retained");
        if (active.tier !== this.request.sizingKey && active.phase !== "adopting") {
            await this.cancel(active);
            return { state: "in-progress", step: "start" };
        }
        return this.advance(active, source);
    }
    async advance(state, source) {
        switch (state.phase) {
            case "failed":
                await this.failed(state);
                return this.inProgress();
            case "blocked": return this.blocked(state);
            case "retrying": return this.retry(state, source);
            case "copying": return this.copy(state, source);
            case "retaining": return this.retain(state, source);
            case "releasing": return this.release(state);
            case "adopting": return this.adopt(state);
            default: throw new Error("invalid home migration phase");
        }
    }
}
export async function prepareIsolatedHome(deps, request, mode = "apply") {
    await checkPlacementOwner(deps);
    const run = new HomePreparationRun(deps, request);
    const owner = await run.readOwnerUnlessPrepared();
    if (!owner)
        return { state: "ready" };
    await run.loadPolicy();
    if (mode === "plan")
        return run.plan(userHomeOwner(owner));
    try {
        return await run.reconcile(userHomeOwner(owner));
    }
    catch (error) {
        if (!(error instanceof HomeComputeUnavailableError))
            throw error;
        deps.log(`[home-migration] ${request.uid}: compute unavailable at ${run.currentStep} (${error.code}): ${error.message}`);
        return { state: "in-progress", step: run.currentStep, lastError: { code: error.code } };
    }
}
export function homePreparationReady(preparation) {
    if (preparation.state === "blocked")
        throw new Error(preparation.reason);
    return preparation.state === "ready";
}
