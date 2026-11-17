import { logger } from "../http/logging.js";
import { containsAsciiControlCharacter } from "@octogee/shared/types/text-validation";
export const GITEA_URL = process.env.GITEA_URL ||
    `http://octogee-gitea-http.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:3000`;
function giteaEndpoint(path, query = "") {
    const url = new URL(GITEA_URL);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
        throw new Error("Invalid GITEA_URL configuration");
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/v1/${path}`;
    url.search = query;
    return url.href;
}
function giteaName(name) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === "." || name === "..") {
        throw new Error("Invalid Gitea name");
    }
    return encodeURIComponent(name);
}
function encodeGiteaPathSegment(segment) {
    if (segment.includes("\\") || containsAsciiControlCharacter(segment) || segment.split("/").some((part) => part === "." || part === "..")) {
        throw new Error("Invalid Gitea API path");
    }
    return encodeURIComponent(segment);
}
function giteaContentPath(org, repo, filePath) {
    const base = `repos/${giteaName(org)}/${giteaName(repo)}/contents`;
    return filePath === undefined ? base : `${base}/${filePath.split("/").map(encodeGiteaPathSegment).join("/")}`;
}
export function getToken() {
    const token = process.env.GITEA_TOKEN;
    if (!token)
        throw new Error("GITEA_TOKEN not configured");
    return token;
}
async function giteaFetch({ token, org, path, method, body, allow404, sudo, }) {
    // Defense at the impersonation sink: the Sudo header carries a privileged identity,
    // so reject anything that isn't a clean Gitea username (no CRLF/space → no header
    // injection), regardless of how callers derived it.
    if (sudo !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sudo)) {
        throw new Error(`Refusing Gitea Sudo with unsafe identity: ${JSON.stringify(sudo)}`);
    }
    const queryStart = path.indexOf("?");
    const endpoint = queryStart === -1 ? path : path.slice(0, queryStart);
    const query = queryStart === -1 ? "" : path.slice(queryStart);
    const [repo, ...parts] = endpoint.split("/");
    const segments = [giteaName(org), giteaName(repo), ...parts.map((part) => encodeGiteaPathSegment(decodeURIComponent(part)))];
    const url = giteaEndpoint(`repos/${segments.join("/")}`, query);
    const resp = await fetch(url, {
        method,
        redirect: "error",
        headers: {
            Authorization: `token ${token}`,
            Accept: "application/json",
            ...(sudo ? { Sudo: sudo } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!resp.ok) {
        if (allow404 && resp.status === 404)
            return null;
        const text = await resp.text().catch(() => "");
        if (resp.status !== 404) {
            logger.error(`Gitea API error: ${resp.status} ${method} ${url}`, {
                response: text.slice(0, 500),
            });
        }
        throw new Error(`Gitea API ${resp.status}`);
    }
    if (resp.status === 204 || resp.status === 304)
        return null;
    return resp.json();
}
export async function giteaApi(org, path, method = "GET", body) {
    return giteaFetch({ token: getToken(), org, path, method, body, allow404: false });
}
export async function giteaApiAs(token, org, path, method = "GET", body) {
    return giteaFetch({ token, org, path, method, body, allow404: false });
}
async function giteaApiAllowNotFound(org, path, method = "GET", body) {
    return giteaFetch({ token: getToken(), org, path, method, body, allow404: true });
}
export async function giteaApiAsAllowNotFound(token, org, path, method = "GET", body) {
    return giteaFetch({ token, org, path, method, body, allow404: true });
}
// First-party impersonation: act on Gitea AS the workspace user via the platform
// admin token + Sudo header — Gitea enforces the impersonated user's repo ACL
// (validated live, PLATFORM-CREDENTIAL-BROKERING-SPEC §Tier 1). Replaces the
// per-user PAT: nothing to mint, store, or rotate. `sudoUser` is the gitea
// username, e.g. `ws-${slug}`.
export async function giteaApiAsUser(sudoUser, org, path, method = "GET", body) {
    return giteaFetch({
        token: getToken(),
        org,
        path,
        method,
        body,
        allow404: false,
        sudo: sudoUser,
    });
}
export async function giteaApiAsUserAllowNotFound(sudoUser, org, path, method = "GET", body) {
    return giteaFetch({
        token: getToken(),
        org,
        path,
        method,
        body,
        allow404: true,
        sudo: sudoUser,
    });
}
export async function giteaDeleteRepo(org, repo) {
    await giteaApiAllowNotFound(org, repo, "DELETE");
}
export async function giteaGetRepo(org, repo) {
    return giteaApiAllowNotFound(org, repo);
}
export async function giteaDeleteVerifiedRepo(org, repo) {
    const existing = await giteaGetRepo(org, repo);
    if (existing === null)
        return;
    assertExpectedRepo(existing, org, repo);
    await giteaDeleteRepo(org, repo);
    const remaining = await giteaGetRepo(org, repo);
    if (remaining !== null) {
        throw new Error(`Gitea repo ${org}/${repo} still exists after deletion`);
    }
}
function assertExpectedRepo(value, org, repo) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Gitea returned an invalid repo for ${org}/${repo}`);
    }
    const record = value;
    const owner = record.owner;
    const ownerName = owner && typeof owner === "object" && !Array.isArray(owner)
        ? owner.login ?? owner.username
        : undefined;
    if (record.name !== repo || ownerName !== org) {
        throw new Error(`Gitea repo binding mismatch for ${org}/${repo}`);
    }
}
async function giteaAdminFetch(method, path, body, allow404, quietErrorStatuses = []) {
    const url = giteaEndpoint(path);
    const resp = await fetch(url, {
        method,
        redirect: "error",
        headers: {
            Authorization: `token ${getToken()}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!resp.ok) {
        if (allow404 && resp.status === 404)
            return null;
        const text = await resp.text().catch(() => "");
        if (!quietErrorStatuses.includes(resp.status)) {
            logger.error(`Gitea admin error: ${resp.status} ${method} ${url}`, {
                response: text.slice(0, 500),
            });
        }
        const err = new Error(`Gitea API ${resp.status}: ${text.slice(0, 200)}`);
        err.status = resp.status;
        throw err;
    }
    return resp.json();
}
export async function createProjectGiteaRepo(org, repoName, description, privateRepo) {
    const repoPath = `repos/${giteaName(org)}/${giteaName(repoName)}`;
    const path = `orgs/${giteaName(org)}/repos`;
    try {
        await giteaAdminFetch("POST", path, {
            name: repoName,
            description,
            private: privateRepo,
            auto_init: true,
            default_branch: "main",
        }, false, [409]);
        return true;
    }
    catch (err) {
        if (err?.status === 409) {
            const existing = await giteaAdminFetch("GET", repoPath, undefined, true);
            if (existing === null) {
                throw new Error(`Gitea repo conflict without existing repo for ${org}/${repoName}`);
            }
            assertExpectedRepo(existing, org, repoName);
            const record = existing;
            if (record.private !== privateRepo || record.default_branch !== "main") {
                throw new Error(`Gitea repo configuration mismatch for ${org}/${repoName}`);
            }
            return false;
        }
        throw err;
    }
}
export async function giteaWriteFile(org, repoName, filePath, content, commitMessage) {
    const path = giteaContentPath(org, repoName, filePath);
    const existing = await giteaAdminFetch("GET", path, undefined, true);
    if (existing !== null)
        return;
    await giteaAdminFetch("POST", path, {
        message: commitMessage,
        content: Buffer.from(content, "utf-8").toString("base64"),
        branch: "main",
    }, false);
}
export async function giteaWriteFiles(org, repoName, files, commitMessage) {
    const absent = [];
    for (const file of files) {
        const existing = await giteaAdminFetch("GET", giteaContentPath(org, repoName, file.path), undefined, true);
        if (existing === null)
            absent.push(file);
        else
            logger.info("Repository seed preserved an existing file", { org, repoName, path: file.path });
    }
    if (absent.length === 0)
        return;
    await giteaCreateFiles(giteaContentPath(org, repoName), absent, commitMessage);
}
export async function giteaWriteFilesIfAllAbsent(org, repoName, files, commitMessage) {
    if (files.length === 0)
        return;
    for (const file of files) {
        const existing = await giteaAdminFetch("GET", giteaContentPath(org, repoName, file.path), undefined, true);
        if (existing !== null)
            return;
    }
    await giteaCreateFiles(giteaContentPath(org, repoName), files, commitMessage);
}
async function giteaCreateFiles(contentsPath, files, commitMessage) {
    await giteaAdminFetch("POST", contentsPath, {
        message: commitMessage,
        branch: "main",
        files: files.map((file) => ({
            operation: "create",
            path: file.path,
            content: (typeof file.content === "string" ? Buffer.from(file.content, "utf-8") : file.content).toString("base64"),
        })),
    }, false);
}
