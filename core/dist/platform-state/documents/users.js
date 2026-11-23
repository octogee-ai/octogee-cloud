import { GATEWAY_PROFILES } from "@octogee/shared/types/glm";
import { MalformedRecordError } from "../errors.js";
export const GATEWAY_STATE_STORE_KEY = "_gateway-state";
export const GATEWAY_STATE_KIND = "gateway-state";
export const AUXILIARY_STORE_KEY_PREFIX = "_gateway-";
export const AUXILIARY_STORED_KIND = "gateway-auxiliary";
export const USER_ROLES = ["user", "admin"];
export const MANAGERS = ["cowboy", "operator"];
export const AUXILIARY_FAMILIES = ["workboard", "logbook", "team-reports"];
export const LEASE_STATUSES = [
    "requested",
    "provisioning",
    "activating",
    "active",
    "returning",
    "parked",
    "failed",
];
export const SLUG_PATH = "provisioning.openclaw.slug";
export const MATTERMOST_USER_ID_PATH = "mattermost.userId";
export const USER_ACTIVATION_LEASE_PATH = "provisioning.openclaw.activationLease";
export const AGENT_IDS_PATH = "provisioning.openclaw.agentIds";
export const ACTIVATED_AGENTS_PATH = "provisioning.openclaw.activatedAgents";
export const ADMITTED_STEP = "complete";
export const PROVISIONING_PATHS = {
    status: "provisioning.status",
    startedAt: "provisioning.startedAt",
    gitRepoUrl: "provisioning.git.repoUrl",
    gitCreatedAt: "provisioning.git.createdAt",
};
export const USER_MIRROR_PATHS = {
    gatewayId: "provisioning.openclaw.gatewayId",
    gatewayAssignedAt: "provisioning.openclaw.gatewayAssignedAt",
    gatewayProfile: "provisioning.openclaw.gatewayProfile",
    controlUiEnabled: "provisioning.openclaw.controlUiEnabled",
};
export const OPENCLAW_PATHS = {
    status: "provisioning.openclaw.status",
    version: "provisioning.openclaw.version",
    agentId: "provisioning.openclaw.agentId",
    customerDir: "provisioning.openclaw.customerDir",
    provisionedAt: "provisioning.openclaw.provisionedAt",
    mounted: "provisioning.openclaw.mounted",
    managedBy: "provisioning.openclaw.managedBy",
    greeting: "provisioning.openclaw.greeting",
    toolchain: "provisioning.openclaw.toolchain",
};
export const USER_FENCE_PATHS = {
    restoreFence: "provisioning.openclaw.restoreFence",
    sourceTransferFence: "provisioning.openclaw.sourceTransferFence",
    computerRecovery: "provisioning.computerRecovery",
    migration: "provisioning.openclaw.migration",
    pendingNativeSchedulerRetirement: "provisioning.pendingNativeSchedulerRetirement",
    runtimeReset: "provisioning.openclaw.runtimeReset",
};
export const HOME_PATHS = {
    computer: "provisioning.computer",
    homeCheckpoint: "provisioning.homeCheckpoint",
    homeDisk: "provisioning.homeDisk",
    homeArchive: "provisioning.homeArchive",
    homeStorage: "provisioning.homeStorage",
    homeMigration: "provisioning.homeMigration",
    homeErasure: "provisioning.homeErasure",
    homeCapacity: "provisioning.homeCapacity",
    projectStorageNativeBoot: "provisioning.projectStorage.nativeBoot",
};
export const TOP_LEVEL_PATHS = {
    slug: SLUG_PATH,
    mattermostUserId: MATTERMOST_USER_ID_PATH,
    workspaceId: "workspaceId",
    accountLifecycle: "accountLifecycle",
    scheduleCheckpoint: "scheduleCheckpoint",
    workspaceCheckpoint: "workspaceCheckpoint",
};
export const PATCH_GROUPS = {
    provisioning: PROVISIONING_PATHS,
    openclaw: OPENCLAW_PATHS,
    home: HOME_PATHS,
};
export const userKey = (uid) => ({ aggregate: "builder", key: uid });
export const agentStoreKey = (uid, storeKey) => ({ aggregate: "agent-store", key: `${uid}/${storeKey}` });
export function isMap(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
export function present(fields) {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
export function productValue(data, path) {
    let value = data;
    for (const segment of path.split(".")) {
        if (!isMap(value))
            return undefined;
        value = value[segment];
    }
    return value;
}
export class StoredFields {
    record;
    data;
    constructor(record, data) {
        this.record = record;
        this.data = data;
    }
    malformed(path, expected) {
        return new MalformedRecordError(this.record, `${path} is not ${expected}`);
    }
    value(path) {
        const segments = path.split(".");
        let value = this.data;
        for (let index = 0; index < segments.length; index += 1) {
            if (value === undefined)
                return undefined;
            if (!isMap(value))
                throw this.malformed(segments.slice(0, index).join("."), "a map");
            value = value[segments[index]];
        }
        return value;
    }
    typed(path, expected, accepts) {
        const value = this.value(path);
        if (value === undefined)
            return undefined;
        if (!accepts(value))
            throw this.malformed(path, expected);
        return value;
    }
    string(path) {
        return this.typed(path, "a string", (value) => typeof value === "string");
    }
    number(path) {
        return this.typed(path, "a number", (value) => typeof value === "number");
    }
    boolean(path) {
        return this.typed(path, "a boolean", (value) => typeof value === "boolean");
    }
    oneOf(path, allowed) {
        return this.typed(path, `one of ${allowed.join(", ")}`, (value) => allowed.includes(value));
    }
    map(path) {
        return this.typed(path, "a map", (value) => isMap(value));
    }
    maps(path) {
        return this.typed(path, "a list of maps", (value) => Array.isArray(value) && value.every(isMap));
    }
    strings(path) {
        return this.typed(path, "a list of strings", (value) => Array.isArray(value) && value.every((item) => typeof item === "string")) ?? [];
    }
    requiredString(path) {
        const value = this.string(path);
        if (value === undefined)
            throw this.malformed(path, "a string");
        return value;
    }
    requiredNumber(path) {
        const value = this.number(path);
        if (value === undefined)
            throw this.malformed(path, "a number");
        return value;
    }
    requiredOneOf(path, allowed) {
        const value = this.oneOf(path, allowed);
        if (value === undefined)
            throw this.malformed(path, `one of ${allowed.join(", ")}`);
        return value;
    }
}
export function userRoleFromData(uid, config) {
    if (config === undefined)
        return null;
    return new StoredFields(userKey(uid), config).oneOf("role", USER_ROLES) ?? null;
}
export function decodePersona(data) {
    const vibe = productValue(data, "onboarding.vibe");
    const timeZone = productValue(data, "preferences.timeZone");
    if (vibe === undefined && timeZone === undefined)
        return null;
    return present({ vibe, timeZone });
}
export function decodeSlug(fields, data) {
    const username = productValue(data, "username");
    return fields.string(SLUG_PATH) ?? (typeof username === "string" ? username : null);
}
export function decodeActivationLease(fields) {
    const lease = fields.map(USER_ACTIVATION_LEASE_PATH);
    if (lease === undefined)
        return null;
    fields.requiredString(`${USER_ACTIVATION_LEASE_PATH}.leaseId`);
    fields.requiredNumber(`${USER_ACTIVATION_LEASE_PATH}.generation`);
    fields.requiredOneOf(`${USER_ACTIVATION_LEASE_PATH}.status`, LEASE_STATUSES);
    return lease;
}
export function decodeGatewayMirror(fields) {
    const gatewayId = fields.string(USER_MIRROR_PATHS.gatewayId);
    if (gatewayId === undefined)
        return null;
    return present({
        gatewayId,
        gatewayAssignedAt: fields.number(USER_MIRROR_PATHS.gatewayAssignedAt),
        gatewayProfile: fields.oneOf(USER_MIRROR_PATHS.gatewayProfile, GATEWAY_PROFILES),
        controlUiEnabled: fields.boolean(USER_MIRROR_PATHS.controlUiEnabled),
    });
}
export function userRecordFromData(uid, data, updatedAt, role) {
    const fields = new StoredFields(userKey(uid), data);
    return {
        uid,
        slug: decodeSlug(fields, data),
        mattermostUserId: fields.string(MATTERMOST_USER_ID_PATH) ?? null,
        admitted: data.onboardingStep === ADMITTED_STEP,
        persona: decodePersona(data),
        workspaceId: fields.string(TOP_LEVEL_PATHS.workspaceId) ?? null,
        role,
        createdAt: fields.number("createdAt") ?? null,
        updatedAt,
        provisioning: present({
            status: fields.string(PROVISIONING_PATHS.status),
            startedAt: fields.number(PROVISIONING_PATHS.startedAt),
            gitRepoUrl: fields.string(PROVISIONING_PATHS.gitRepoUrl),
            gitCreatedAt: fields.number(PROVISIONING_PATHS.gitCreatedAt),
        }),
        gateway: decodeGatewayMirror(fields),
        openclaw: present({
            status: fields.string(OPENCLAW_PATHS.status),
            version: fields.string(OPENCLAW_PATHS.version),
            agentId: fields.string(OPENCLAW_PATHS.agentId),
            customerDir: fields.string(OPENCLAW_PATHS.customerDir),
            provisionedAt: fields.number(OPENCLAW_PATHS.provisionedAt),
            mounted: fields.boolean(OPENCLAW_PATHS.mounted),
            managedBy: fields.oneOf(OPENCLAW_PATHS.managedBy, MANAGERS),
            greeting: fields.map(OPENCLAW_PATHS.greeting),
            toolchain: fields.map(OPENCLAW_PATHS.toolchain),
        }),
        agents: {
            agentIds: fields.strings(AGENT_IDS_PATH),
            activatedAgents: fields.strings(ACTIVATED_AGENTS_PATH),
        },
        accountLifecycle: fields.map(TOP_LEVEL_PATHS.accountLifecycle) ?? null,
        activationLease: decodeActivationLease(fields),
        ...present({ scheduleCheckpoint: fields.map(TOP_LEVEL_PATHS.scheduleCheckpoint) }),
        ...present({ workspaceCheckpoint: fields.map(TOP_LEVEL_PATHS.workspaceCheckpoint) }),
        fences: present({
            restoreFence: fields.map(USER_FENCE_PATHS.restoreFence),
            sourceTransferFence: fields.map(USER_FENCE_PATHS.sourceTransferFence),
            computerRecovery: fields.map(USER_FENCE_PATHS.computerRecovery),
            migration: fields.map(USER_FENCE_PATHS.migration),
            pendingNativeSchedulerRetirement: fields.map(USER_FENCE_PATHS.pendingNativeSchedulerRetirement),
            runtimeReset: fields.map(USER_FENCE_PATHS.runtimeReset),
        }),
        home: present({
            computer: fields.map(HOME_PATHS.computer),
            homeCheckpoint: fields.map(HOME_PATHS.homeCheckpoint),
            homeDisk: fields.map(HOME_PATHS.homeDisk),
            homeArchive: fields.map(HOME_PATHS.homeArchive),
            homeStorage: fields.map(HOME_PATHS.homeStorage),
            homeMigration: fields.map(HOME_PATHS.homeMigration),
            homeErasure: fields.maps(HOME_PATHS.homeErasure),
            homeCapacity: fields.map(HOME_PATHS.homeCapacity),
            projectStorageNativeBoot: fields.boolean(HOME_PATHS.projectStorageNativeBoot),
        }),
    };
}
export function mappedGroup(group, paths, groupName) {
    const fields = {};
    for (const [key, value] of Object.entries(group)) {
        if (!Object.hasOwn(paths, key))
            throw new TypeError(`user patch ${groupName}.${key} has no stored field`);
        fields[paths[key]] = value;
    }
    return fields;
}
export function userPatchPaths(patch) {
    const fields = {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || key === "role")
            continue;
        if (Object.hasOwn(TOP_LEVEL_PATHS, key)) {
            fields[TOP_LEVEL_PATHS[key]] = value;
        }
        else if (Object.hasOwn(PATCH_GROUPS, key)) {
            Object.assign(fields, mappedGroup(value, PATCH_GROUPS[key], key));
        }
        else {
            throw new TypeError(`user patch ${key} has no stored field`);
        }
    }
    return fields;
}
export function auxiliaryFamilyOf(storeKey) {
    return AUXILIARY_FAMILIES.find((family) => storeKey === `${AUXILIARY_STORE_KEY_PREFIX}${family}`) ?? null;
}
export function agentStoreKeyOf(record) {
    if (record.kind === GATEWAY_STATE_KIND)
        return GATEWAY_STATE_STORE_KEY;
    if (record.kind === "auxiliary")
        return `${AUXILIARY_STORE_KEY_PREFIX}${record.family}`;
    if (record.agentId.startsWith(AUXILIARY_STORE_KEY_PREFIX)) {
        throw new TypeError(`agent store id ${record.agentId} collides with the gateway store keys`);
    }
    return record.agentId;
}
export function agentStoreFromData(uid, storeKey, data) {
    const key = agentStoreKey(uid, storeKey);
    const fields = new StoredFields(key, data);
    const common = {
        storeId: fields.requiredString("storeId"),
        schema: fields.requiredString("schema"),
        gatewayId: fields.string("gatewayId") ?? null,
        generation: fields.number("generation") ?? null,
        assignmentEpoch: fields.number("assignmentEpoch") ?? null,
        recordedAt: fields.requiredNumber("recordedAt"),
    };
    if (storeKey === GATEWAY_STATE_STORE_KEY) {
        if (fields.string("kind") !== GATEWAY_STATE_KIND)
            throw new MalformedRecordError(key, "kind is not gateway-state");
        return { kind: GATEWAY_STATE_KIND, ...common };
    }
    const family = auxiliaryFamilyOf(storeKey);
    if (family !== null) {
        if (fields.string("kind") !== AUXILIARY_STORED_KIND || fields.string("family") !== family) {
            throw new MalformedRecordError(key, `kind and family do not name the ${family} auxiliary store`);
        }
        return { kind: "auxiliary", family, ...common };
    }
    if (storeKey.startsWith(AUXILIARY_STORE_KEY_PREFIX))
        throw new MalformedRecordError(key, "names no known gateway store");
    if (fields.string("agentId") !== storeKey)
        throw new MalformedRecordError(key, "agentId does not match the store key");
    return { kind: "agent", agentId: storeKey, ...common };
}
