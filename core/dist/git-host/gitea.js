import { randomBytes } from "node:crypto";
import { PROJECT_AGENT_REPO } from "@octogee/shared/types/project";
import { GATEWAY_KEY_TITLE, gatewayKeyTitle as ownerGatewayKeyTitle, giteaUsername, isManagedGatewayKeyTitle, publicKeyIdentity, projectRepoName, systemConfigRepoName, workspaceGiteaOrg, workspaceRepoName, } from "../gitea-naming.js";
import { placeholderEmail } from "../placeholder-email.js";
import { GITEA_PAGE_SIZE, createGiteaKeyAdminClient, runGiteaKeySweep } from "./gitea-key-sweep.js";
const BUILDERS_TEAM = "builders";
export const giteaNaming = {
    owner: workspaceGiteaOrg,
    repo(role) {
        switch (role.kind) {
            case "workspace":
                return workspaceRepoName();
            case "system-config":
                return systemConfigRepoName();
            case "project-coaches":
                return PROJECT_AGENT_REPO;
            case "project":
                return projectRepoName(role.projectSlug);
        }
    },
};
function repoCreation(workspaceSlug, role) {
    switch (role.kind) {
        case "workspace":
            return {
                op: "create-workspace-repo",
                body: {
                    name: giteaNaming.repo(role),
                    private: true,
                    description: `Octogee workspace for ${workspaceSlug}`,
                    auto_init: false,
                },
            };
        case "system-config":
            return {
                op: "create-system-config-repo",
                body: {
                    name: giteaNaming.repo(role),
                    private: true,
                    description: `Octogee gateway system config for ${workspaceSlug}`,
                    auto_init: false,
                },
            };
        case "project-coaches":
            return {
                op: "create-project-coach-repo",
                body: {
                    name: giteaNaming.repo(role),
                    private: true,
                    default_branch: "main",
                    description: `Octogee project agents for ${workspaceSlug}`,
                    auto_init: false,
                },
            };
        case "project":
            return {
                op: "create-project-repo",
                body: {
                    name: giteaNaming.repo(role),
                    private: true,
                    description: `Octogee project: ${role.projectSlug} for ${workspaceSlug}`,
                    auto_init: false,
                },
            };
    }
}
function publicKeysMatch(left, right) {
    return typeof left === "string" && publicKeyIdentity(left) === publicKeyIdentity(right);
}
function gatewayKeyTitle(pubKey, keyOwnerId) {
    return ownerGatewayKeyTitle(keyOwnerId ?? publicKeyIdentity(pubKey));
}
function isManagedGatewayKey(key) {
    return (typeof key.key === "string" &&
        typeof key.title === "string" &&
        isManagedGatewayKeyTitle(key.title));
}
function legacyGatewayKeyMatches(key, pubKey) {
    return key.title === GATEWAY_KEY_TITLE || key.title === gatewayKeyTitle(pubKey);
}
function ok(status, also = []) {
    return (status >= 200 && status < 300) || also.includes(status);
}
function fail(op, { status, json }) {
    const message = json && typeof json === "object" && "message" in json
        ? String(json.message)
        : "";
    throw new Error(`gitea-admin ${op} failed: ${status} ${message.slice(0, 200)}`);
}
function pinnedHostOf(apiBaseUrl) {
    try {
        return new URL(apiBaseUrl).host;
    }
    catch {
        return "";
    }
}
function assertPinnedHost(url, pinnedHost) {
    let host;
    try {
        host = new URL(url).host;
    }
    catch {
        throw new Error(`Invalid Gitea URL: ${url}`);
    }
    if (!pinnedHost || host !== pinnedHost) {
        throw new Error(`Refusing off-Gitea fetch: ${host} !== ${pinnedHost}`);
    }
}
function createGiteaAdmin(config) {
    const fetchImpl = (input, init) => (config.fetch ?? fetch)(input, init);
    const pinnedHost = pinnedHostOf(config.apiBaseUrl);
    async function send(method, path, body) {
        const url = `${config.apiBaseUrl}${path}`;
        assertPinnedHost(url, pinnedHost);
        return fetchImpl(url, {
            method,
            headers: {
                Authorization: `token ${config.token()}`,
                Accept: "application/json",
                ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
    }
    return {
        config,
        log: config.log ?? (() => undefined),
        send,
        async request(method, path, body) {
            const resp = await send(method, path, body);
            const json = resp.status === 204 || resp.status === 304 ? null : await resp.json().catch(() => null);
            return { status: resp.status, json };
        },
    };
}
async function tolerantDelete(api, path, label, operation) {
    const resp = await api.send("DELETE", path);
    if (resp.ok || resp.status === 404) {
        api.log(`[gitea] ${label} deleted (or already gone)`);
        return;
    }
    const body = await resp.text().catch(() => "");
    throw new Error(`gitea ${operation} failed: ${resp.status} ${body.slice(0, 200)}`);
}
async function readUserKeys(api, username) {
    const keys = [];
    for (let page = 1;; page += 1) {
        const response = await api.request("GET", `/users/${username}/keys?limit=${GITEA_PAGE_SIZE}&page=${page}`);
        if (page === 1 && response.status === 404)
            return [];
        if (!ok(response.status))
            fail("list-keys", response);
        if (!Array.isArray(response.json)) {
            throw new Error(`gitea-admin list-keys failed: ${response.status} invalid response`);
        }
        const pageKeys = response.json;
        keys.push(...pageKeys);
        if (pageKeys.length < GITEA_PAGE_SIZE)
            return keys;
    }
}
async function hasManagedKey(api, username, pubKey, title) {
    return (await readUserKeys(api, username)).some((key) => isManagedGatewayKey(key) &&
        (title === undefined || key.title === title) &&
        publicKeysMatch(key.key, pubKey));
}
async function registerUserKey(api, username, pubKey, { title, requireTitle }) {
    const registered = await api.request("POST", `/admin/users/${username}/keys`, {
        title,
        key: pubKey,
    });
    if (ok(registered.status))
        return;
    if (registered.status === 422 && await hasManagedKey(api, username, pubKey, requireTitle ? title : undefined))
        return;
    fail("register-key", registered);
}
async function deleteUserKey(api, username, key) {
    if (typeof key.id !== "number") {
        throw new Error("gitea-admin delete-key failed: registered key is missing its id");
    }
    const deleted = await api.request("DELETE", `/admin/users/${username}/keys/${key.id}`);
    if (deleted.status === 404)
        return false;
    if (!ok(deleted.status))
        fail("delete-key", deleted);
    return true;
}
async function restoreUserKeys(api, username, keys) {
    const failures = [];
    for (const key of keys) {
        try {
            const restored = await api.request("POST", `/admin/users/${username}/keys`, {
                title: key.title,
                key: key.key,
            });
            if (ok(restored.status))
                continue;
            if (restored.status === 422 && await hasManagedKey(api, username, key.key, key.title))
                continue;
            fail("restore-key", restored);
        }
        catch (error) {
            failures.push(error);
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, "gitea-admin predecessor key restoration failed");
    }
}
async function ensureBuildersTeam(api, slug) {
    const created = await api.request("POST", `/orgs/${slug}/teams`, {
        name: BUILDERS_TEAM,
        permission: "write",
        includes_all_repositories: true,
        can_create_org_repo: false,
        units: ["repo.code", "repo.issues", "repo.pulls", "repo.releases", "repo.wiki"],
    });
    if (ok(created.status)) {
        return created.json.id;
    }
    if (created.status !== 422)
        fail("create-team", created);
    const list = await api.request("GET", `/orgs/${slug}/teams`);
    if (!ok(list.status))
        fail("list-teams", list);
    const existing = list.json.find((t) => t.name === BUILDERS_TEAM);
    if (!existing) {
        throw new Error(`gitea-admin: '${BUILDERS_TEAM}' team missing after 422 for ${slug}`);
    }
    return existing.id;
}
function keysReplacedByOwner(existing, requestedKeyMatches, requestedTitle) {
    const staleOwnedKeys = existing.filter((item) => isManagedGatewayKey(item) &&
        item.title === requestedTitle &&
        !requestedKeyMatches.includes(item));
    return [...requestedKeyMatches, ...staleOwnedKeys];
}
async function registerGatewayKey(api, workspaceSlug, pubKey, keyOwnerId, takesHeldKey) {
    const username = giteaUsername(workspaceSlug);
    const created = await api.request("POST", "/admin/users", {
        username,
        email: placeholderEmail(workspaceSlug),
        password: randomBytes(32).toString("hex"),
        must_change_password: false,
        visibility: "private",
    });
    if (!ok(created.status, [409, 422]))
        fail("create-user", created);
    const existing = await readUserKeys(api, username);
    const requestedTitle = gatewayKeyTitle(pubKey, keyOwnerId);
    const requestedKeyMatches = existing.filter((key) => isManagedGatewayKey(key) && publicKeysMatch(key.key, pubKey));
    const claimsHeldKey = keyOwnerId !== undefined && takesHeldKey;
    if (requestedKeyMatches.some((key) => !claimsHeldKey || key.title === requestedTitle)) {
        return;
    }
    const keysToReplace = keyOwnerId === undefined ? [] : keysReplacedByOwner(existing, requestedKeyMatches, requestedTitle);
    const removed = [];
    try {
        for (const key of keysToReplace) {
            if (await deleteUserKey(api, username, key))
                removed.push(key);
        }
        await registerUserKey(api, username, pubKey, {
            title: requestedTitle,
            requireTitle: claimsHeldKey,
        });
    }
    catch (error) {
        if (await hasManagedKey(api, username, pubKey, claimsHeldKey ? requestedTitle : undefined).catch(() => false))
            return;
        if (removed.length === 0)
            throw error;
        try {
            await restoreUserKeys(api, username, removed);
        }
        catch (restoreError) {
            throw new AggregateError([error, restoreError], "gitea-admin key ownership transfer failed and predecessor key restoration failed");
        }
        throw error;
    }
}
async function releaseGatewayKey(api, workspaceSlug, pubKey, keyOwnerId) {
    const username = giteaUsername(workspaceSlug);
    const ownerTitle = keyOwnerId === undefined ? null : gatewayKeyTitle(pubKey, keyOwnerId);
    const matching = (await readUserKeys(api, username)).filter((key) => isManagedGatewayKey(key) &&
        publicKeysMatch(key.key, pubKey) &&
        (ownerTitle === null || key.title === ownerTitle || legacyGatewayKeyMatches(key, pubKey)));
    for (const key of matching) {
        await deleteUserKey(api, username, key);
    }
}
async function ensureWorkspaceOwner(api, workspaceSlug) {
    const org = await api.request("POST", "/orgs", { username: workspaceSlug, visibility: "private" });
    if (!ok(org.status, [422]))
        fail("create-org", org);
    const teamId = await ensureBuildersTeam(api, workspaceSlug);
    const member = await api.request("PUT", `/teams/${teamId}/members/${giteaUsername(workspaceSlug)}`);
    if (!ok(member.status, [204]))
        fail("add-member", member);
}
async function setRepoArchived(api, ref, archived) {
    const resp = await api.request("PATCH", `/repos/${ref.owner}/${ref.repo}`, { archived });
    if (!ok(resp.status, [404]))
        fail(archived ? "archive-repo" : "restore-repo", resp);
}
async function deleteRepo(api, ref) {
    await tolerantDelete(api, `/repos/${ref.owner}/${ref.repo}`, `repo ${ref.owner}/${ref.repo}`, `deleteRepo ${ref.owner}/${ref.repo}`);
}
async function eraseWorkspaceOwner(api, workspaceSlug, repos) {
    const owner = giteaNaming.owner(workspaceSlug);
    for (const repo of repos) {
        await deleteRepo(api, { owner, repo });
    }
    await tolerantDelete(api, `/orgs/${owner}`, `org ${owner}`, `deleteOrg ${owner}`);
    const username = giteaUsername(workspaceSlug);
    await tolerantDelete(api, `/admin/users/${username}`, `user ${username}`, `deleteGiteaUser ${username}`);
}
async function blockGiteaSignIn(api, workspaceSlug) {
    const username = giteaUsername(workspaceSlug);
    const updated = await api.request("PATCH", `/admin/users/${username}`, {
        login_name: username,
        source_id: 0,
        prohibit_login: true,
    });
    if (updated.status === 404) {
        api.log(`[gitea] user ${username} is gone, so it cannot sign in`);
        return;
    }
    if (!ok(updated.status))
        fail("block-sign-in", updated);
    api.log(`[gitea] user ${username} prohibited from signing in`);
}
export function createGiteaGitHost(config) {
    const api = createGiteaAdmin(config);
    return {
        kind: "managed",
        provider: "gitea",
        naming: giteaNaming,
        registerKey: (workspaceSlug, pubKey, keyOwnerId) => registerGatewayKey(api, workspaceSlug, pubKey, keyOwnerId, true),
        registerKeyUnlessHeld: (workspaceSlug, pubKey, keyOwnerId) => registerGatewayKey(api, workspaceSlug, pubKey, keyOwnerId, false),
        holdsKey: (workspaceSlug, pubKey, keyOwnerId) => hasManagedKey(api, giteaUsername(workspaceSlug), pubKey, gatewayKeyTitle(pubKey, keyOwnerId)),
        async listKeys(workspaceSlug) {
            return (await readUserKeys(api, giteaUsername(workspaceSlug)))
                .filter(isManagedGatewayKey)
                .map((key) => key.key.trim());
        },
        async primaryKey(workspaceSlug) {
            const managedKeys = (await readUserKeys(api, giteaUsername(workspaceSlug))).filter(isManagedGatewayKey);
            const legacyKey = managedKeys.find((key) => key.title === GATEWAY_KEY_TITLE);
            return (legacyKey ?? managedKeys[0])?.key?.trim() ?? null;
        },
        releaseKey: (workspaceSlug, pubKey, keyOwnerId) => releaseGatewayKey(api, workspaceSlug, pubKey, keyOwnerId),
        sweepKeys(input, state) {
            const gitea = createGiteaKeyAdminClient({
                apiUrl: config.apiBaseUrl,
                token: config.token(),
                fetchImpl: config.fetch,
            });
            return runGiteaKeySweep({ ...input, gitea }, state);
        },
        ensureOwner: (workspaceSlug) => ensureWorkspaceOwner(api, workspaceSlug),
        async ensureRepo(workspaceSlug, role) {
            const { op, body } = repoCreation(workspaceSlug, role);
            const resp = await api.request("POST", `/orgs/${giteaNaming.owner(workspaceSlug)}/repos`, body);
            if (!ok(resp.status, [409]))
                fail(op, resp);
        },
        async repoExists(ref) {
            const resp = await api.request("GET", `/repos/${ref.owner}/${ref.repo}`);
            if (resp.status === 404)
                return false;
            if (!ok(resp.status))
                fail("repo-exists", resp);
            return true;
        },
        archiveRepo: (ref) => setRepoArchived(api, ref, true),
        restoreRepo: (ref) => setRepoArchived(api, ref, false),
        deleteRepo: (ref) => deleteRepo(api, ref),
        eraseOwner: (workspaceSlug, repos) => eraseWorkspaceOwner(api, workspaceSlug, repos),
        async setUserPassword(workspaceSlug, password) {
            const username = giteaUsername(workspaceSlug);
            const updated = await api.request("PATCH", `/admin/users/${username}`, {
                login_name: username,
                source_id: 0,
                password,
                must_change_password: true,
            });
            if (!ok(updated.status))
                fail("set-password", updated);
            return username;
        },
        blockSignIn: (workspaceSlug) => blockGiteaSignIn(api, workspaceSlug),
    };
}
