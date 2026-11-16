import { GATEWAY_KEY_TITLE, gatewayKeyTitle, giteaUsername, isManagedGatewayKeyTitle, publicKeyIdentity, } from "../gitea-naming.js";
export const GITEA_PAGE_SIZE = 50;
function emptyTotals() {
    return { managed: 0, live: 0, legacy: 0, young: 0, stale: 0, deleted: 0, legacyStale: 0, legacyDeleted: 0 };
}
function classifyKey(key, liveTitles, cutoff) {
    if (!isManagedGatewayKeyTitle(key.title))
        return "unmanaged";
    if (liveTitles.has(key.title))
        return "live";
    if (key.title === GATEWAY_KEY_TITLE || key.title === gatewayKeyTitle(publicKeyIdentity(key.key))) {
        return "legacy";
    }
    if (key.createdAt === null || key.createdAt > cutoff)
        return "young";
    return "stale";
}
function createPacer(deps, state) {
    let calls = 0;
    return {
        get calls() {
            return calls;
        },
        get remaining() {
            return deps.maxCallsPerTick - calls;
        },
        async call(fn) {
            if (state.lastCallAt !== null) {
                const wait = state.lastCallAt + deps.minCallIntervalMs - deps.now();
                if (wait > 0)
                    await deps.sleep(wait);
            }
            calls += 1;
            try {
                return await fn();
            }
            finally {
                state.lastCallAt = deps.now();
            }
        },
    };
}
async function readAllPages(pacer, readPage) {
    const items = [];
    for (let page = 1;; page += 1) {
        const pageItems = await pacer.call(() => readPage(page));
        items.push(...pageItems);
        if (pageItems.length < GITEA_PAGE_SIZE)
            return items;
    }
}
function censusLine(census) {
    return `managed=${census.managed} live=${census.live} legacy=${census.legacy} young=${census.young} stale=${census.stale} deleted=${census.deleted} legacyStale=${census.legacyStale} legacyDeleted=${census.legacyDeleted}`;
}
function modeLine(deps) {
    return `(${deps.mode})`;
}
function deletableLegacyKeys(username, keys, classes, cutoff) {
    if (!username.startsWith(giteaUsername("")))
        return [];
    const liveMaterial = new Set(keys.filter((key) => classes.get(key) === "live").map((key) => publicKeyIdentity(key.key)));
    return keys.filter((key) => classes.get(key) === "legacy" &&
        key.createdAt !== null &&
        key.createdAt <= cutoff &&
        !liveMaterial.has(publicKeyIdentity(key.key)));
}
async function deleteKeys(deps, pacer, username, keys) {
    let deleted = 0;
    for (const key of keys) {
        if (pacer.remaining < 1)
            break;
        if (await pacer.call(() => deps.gitea.deleteUserKey(username, key.id)))
            deleted += 1;
    }
    return deleted;
}
function shouldLogUser(deps, census) {
    if (census.managed === 0)
        return false;
    if (deps.mode === "dry-run")
        return true;
    return census.stale > 0 || census.legacyStale > 0;
}
async function sweepUser(deps, pacer, username, snapshot) {
    const keys = await readAllPages(pacer, (page) => deps.gitea.listUserKeys(username, page));
    const census = { username, ...emptyTotals() };
    const classes = new Map();
    for (const key of keys) {
        const keyClass = classifyKey(key, snapshot.liveTitles, snapshot.cutoff);
        classes.set(key, keyClass);
        if (keyClass === "unmanaged")
            continue;
        census.managed += 1;
        census[keyClass] += 1;
    }
    const legacy = deletableLegacyKeys(username, keys, classes, snapshot.cutoff);
    census.legacyStale = legacy.length;
    if (deps.mode === "enforce") {
        census.deleted = await deleteKeys(deps, pacer, username, keys.filter((key) => classes.get(key) === "stale"));
        if (census.deleted === census.stale)
            census.legacyDeleted = await deleteKeys(deps, pacer, username, legacy);
    }
    const finished = deps.mode === "dry-run" ||
        (census.deleted === census.stale && census.legacyDeleted === census.legacyStale);
    if (shouldLogUser(deps, census)) {
        deps.log(`[gitea-key-gc] ${username} ${censusLine(census)} ${modeLine(deps)}`);
    }
    return { census, finished };
}
function addCensus(totals, census, finished) {
    totals.deleted += census.deleted;
    totals.legacyDeleted += census.legacyDeleted;
    if (!finished)
        return;
    totals.legacyStale += census.legacyStale;
    totals.managed += census.managed;
    totals.live += census.live;
    totals.legacy += census.legacy;
    totals.young += census.young;
    totals.stale += census.stale;
}
async function startPass(pacer, deps) {
    const usernames = await readAllPages(pacer, (page) => deps.gitea.listUsernames(page));
    return { usernames, next: 0, totals: emptyTotals() };
}
export async function runGiteaKeySweep(deps, state) {
    const snapshotAt = deps.now();
    const holders = await deps.readLiveKeyHolders();
    const snapshot = {
        liveTitles: new Set([...holders.owners].map((owner) => gatewayKeyTitle(owner))),
        cutoff: snapshotAt - deps.graceMs,
    };
    const pacer = createPacer(deps, state);
    state.pass ??= await startPass(pacer, deps);
    const pass = state.pass;
    const users = [];
    while (pass.next < pass.usernames.length && pacer.remaining > 0) {
        const username = pass.usernames[pass.next];
        const { census, finished } = await sweepUser(deps, pacer, username, snapshot);
        users.push(census);
        addCensus(pass.totals, census, finished);
        if (!finished)
            break;
        pass.next += 1;
    }
    const passCompleted = pass.next >= pass.usernames.length;
    if (passCompleted) {
        deps.log(`[gitea-key-gc] pass complete users=${pass.usernames.length} ${censusLine(pass.totals)} ${modeLine(deps)}`);
        state.pass = null;
    }
    return { users, passCompleted, calls: pacer.calls };
}
function parseCreatedAt(value) {
    if (typeof value !== "string")
        return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function toKeyRecord(raw) {
    const key = raw;
    if (typeof key.id !== "number" || typeof key.title !== "string" || typeof key.key !== "string") {
        throw new Error("gitea list keys returned a key without id, title, or key");
    }
    return { id: key.id, title: key.title, key: key.key, createdAt: parseCreatedAt(key.created_at) };
}
function toUsername(raw) {
    const login = raw.login;
    if (typeof login !== "string" || !login)
        throw new Error("gitea list users returned a user without login");
    return login;
}
export function createGiteaKeyAdminClient(deps) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const headers = { Authorization: `token ${deps.token}`, Accept: "application/json" };
    async function getArray(path, op) {
        const resp = await fetchImpl(`${deps.apiUrl}${path}`, { method: "GET", headers });
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            throw new Error(`gitea ${op} failed: ${resp.status} ${body.slice(0, 200)}`);
        }
        const json = await resp.json();
        if (!Array.isArray(json))
            throw new Error(`gitea ${op} failed: response is not an array`);
        return json;
    }
    return {
        async listUsernames(page) {
            const users = await getArray(`/admin/users?limit=${GITEA_PAGE_SIZE}&page=${page}`, "list users");
            return users.map(toUsername);
        },
        async listUserKeys(username, page) {
            const keys = await getArray(`/users/${encodeURIComponent(username)}/keys?limit=${GITEA_PAGE_SIZE}&page=${page}`, `list keys for ${username}`);
            return keys.map(toKeyRecord);
        },
        async deleteUserKey(username, keyId) {
            const resp = await fetchImpl(`${deps.apiUrl}/admin/users/${encodeURIComponent(username)}/keys/${keyId}`, { method: "DELETE", headers });
            if (resp.status === 404)
                return false;
            if (resp.ok)
                return true;
            const body = await resp.text().catch(() => "");
            throw new Error(`gitea delete key ${keyId} for ${username} failed: ${resp.status} ${body.slice(0, 200)}`);
        },
    };
}
