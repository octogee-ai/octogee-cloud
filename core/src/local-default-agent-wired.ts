import * as fs from "node:fs";
import * as path from "node:path";
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_RE,
  parseAgentId,
} from "@octogee/shared/types/identity";
import { PROJECT_AGENT_WORKSPACE_PARTS } from "@octogee/shared/types/project";
import { isSqliteVolatileArtifactPath } from "./agent-store-inventory.js";

// Mirrors userDefaultAgentId in fleet-http-migration.ts — the agent agent-id convention.
// Inlined to keep this module node:fs-only (importable into gateway-edge + scripts alike).
const userDefaultAgentId = (slug: string): string => `octogee-${slug}-coach`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Slug validity = the shared username contract (USERNAME_RE + 2..24 length), single-sourced —
// a local copy of this regex had drifted to a 3-char minimum, making valid 2-char users
// invisible to the observers below (never mounted-reported, never evicted). USERNAME_RE matches
// only [a-z0-9] + single hyphens, so it also rules out path traversal (no ., /, \).
function isSafeSlug(value: string): boolean {
  return (
    value.length >= USERNAME_MIN_LENGTH &&
    value.length <= USERNAME_MAX_LENGTH &&
    USERNAME_RE.test(value)
  );
}

function isMattermostAccountBinding(binding: unknown, agentId: string, accountId: string): boolean {
  if (!isRecord(binding) || binding.agentId !== agentId || !isRecord(binding.match)) return false;
  return binding.match.channel === "mattermost" && binding.match.accountId === accountId;
}

export interface OpenclawConfig {
  agents?: {
    defaults?: Record<string, unknown>;
    list?: Array<unknown>;
    entries?: Record<string, unknown>;
  };
  channels?: { mattermost?: { accounts?: Record<string, unknown> } };
  bindings?: Array<unknown>;
  session?: Record<string, unknown>;
}

/** Read + parse the openclaw config once; null on any read/parse failure. */
export function readOpenclawConfig(configPath: string): OpenclawConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as OpenclawConfig;
  } catch {
    return null;
  }
}

export function hasReadableOpenclawConfig(configPath: string): boolean {
  return readOpenclawConfig(configPath) !== null;
}

const CONFIGURED_AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PORTABLE_CONFIGURED_AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isSafeConfiguredAgentId(value: unknown): value is string {
  return typeof value === "string" && CONFIGURED_AGENT_ID_RE.test(value);
}

export function isPortableConfiguredAgentId(value: unknown): value is string {
  return isSafeConfiguredAgentId(value) && PORTABLE_CONFIGURED_AGENT_ID_RE.test(value);
}

function assertPortableConfiguredAgentId(value: unknown): asserts value is string {
  if (!isPortableConfiguredAgentId(value)) {
    throw new Error(`configured user agent id is not a portable canonical id: ${String(value)}`);
  }
}

export function configuredSafeAgentIds(configPath: string): string[] {
  const config = readOpenclawConfig(configPath);
  return config ? configuredSafeAgentIdsFromConfig(config) : [];
}

export function configuredSafeAgentIdsFromConfig(config: OpenclawConfig): string[] {
  const ids = new Set<string>();
  for (const entry of config.agents?.list ?? []) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    if (isSafeConfiguredAgentId(entry.id)) ids.add(entry.id);
  }
  for (const id of Object.keys(config.agents?.entries ?? {})) {
    if (isSafeConfiguredAgentId(id)) ids.add(id);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

export interface ConfiguredUserPortableStatePath {
  relativePath: string;
  kind: "directory" | "file";
}

export interface ConfiguredUserPortableStatePlan {
  agentIds: string[];
  agentDirs: string[];
  sessionStorePaths: string[];
  paths: ConfiguredUserPortableStatePath[];
}

function recordValue(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  return value;
}

function configuredAgentRecords(
  config: OpenclawConfig,
  agentId: string,
): Array<Record<string, unknown>> {
  const keyedEntries = config.agents?.entries;
  if (keyedEntries !== undefined) {
    const entry = keyedEntries[agentId];
    return entry === undefined || entry === null
      ? []
      : [recordValue(entry, `agents.entries.${agentId}`)];
  }
  const records: Array<Record<string, unknown>> = [];
  for (const entry of config.agents?.list ?? []) {
    if (!isRecord(entry) || entry.id !== agentId) continue;
    records.push(entry);
  }
  if (records.length > 1) {
    throw new Error(`configured user agent ${agentId} appears more than once in agents.list`);
  }
  return records;
}

function configuredPathField(
  records: readonly Record<string, unknown>[],
  field: "agentDir" | "workspace",
  context: string,
): string | undefined {
  for (const record of records) {
    if (!Object.hasOwn(record, field)) continue;
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${context}.${field} must be a non-empty string`);
    }
    return value;
  }
  return undefined;
}

function configuredDefaultAgent(
  records: readonly Record<string, unknown>[],
  agentId: string,
): boolean {
  for (const record of records) {
    if (!Object.hasOwn(record, "default")) continue;
    if (typeof record.default !== "boolean") {
      throw new Error(`configured user agent ${agentId}.default must be a boolean`);
    }
    if (record.default) return true;
  }
  return false;
}

function portableRelativePath(stateDir: string, absolutePath: string, context: string): string {
  const root = path.resolve(stateDir);
  const resolved = path.resolve(absolutePath);
  const relative = path.relative(root, resolved);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${context} is outside the user OpenClaw state root`);
  }
  const segments = relative.split(path.sep);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${context} is not a portable user state path`);
  }
  return segments.join("/");
}

function resolveExplicitPortablePath(
  value: string,
  stateDir: string,
  context: string,
): string {
  if (
    value.trim() !== value ||
    !path.isAbsolute(value) ||
    value.startsWith("~") ||
    value.includes("{") ||
    value.includes("}") ||
    value.split(/[\\/]/u).includes("..")
  ) {
    throw new Error(`${context} is not an absolute portable user state path`);
  }
  return portableRelativePath(stateDir, value, context);
}

function defaultPortablePath(stateDir: string, ...segments: string[]): string {
  return portableRelativePath(stateDir, path.join(path.resolve(stateDir), ...segments), "default path");
}

function defaultWorkspace(
  stateDir: string,
  agentId: string,
  isDefault: boolean,
  defaultWorkspacePath: string | undefined,
): string {
  if (defaultWorkspacePath !== undefined && isDefault) return defaultWorkspacePath;
  return defaultPortablePath(stateDir, isDefault ? "workspace" : `workspace-${agentId}`);
}

function configuredDefaultWorkspace(config: OpenclawConfig, stateDir: string): string | undefined {
  const defaults = config.agents?.defaults;
  if (defaults === undefined) return undefined;
  const record = recordValue(defaults, "agents.defaults");
  if (!Object.hasOwn(record, "workspace")) return undefined;
  const workspace = record.workspace;
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("agents.defaults.workspace must be a non-empty string");
  }
  const relative = resolveExplicitPortablePath(workspace, stateDir, "agents.defaults.workspace");
  if (relative !== "workspace") {
    throw new Error("agents.defaults.workspace must be the canonical user workspace");
  }
  return relative;
}

function assertPortableAgentDir(relativePath: string, agentId: string): void {
  if (!relativePath.startsWith(`agents/${agentId}/`)) {
    throw new Error(`configured user agent ${agentId}.agentDir is outside its canonical agent root`);
  }
}

function platformManagedWorkspaces(agentId: string): string[] {
  const parsed = parseAgentId(agentId);
  if (parsed.kind === "coach") return [`customers/${parsed.username}`];
  if (parsed.kind === "project") return [
    `customers/${parsed.username}/projects/${parsed.project}`,
    ["customers", parsed.username, ...PROJECT_AGENT_WORKSPACE_PARTS, parsed.project].join("/"),
  ];
  return [];
}

function assertPortableWorkspace(
  relativePath: string,
  agentId: string,
  isDefault: boolean,
): void {
  const allowed = new Set([
    `workspace-${agentId}`,
    `workspaces/${agentId}`,
    ...(isDefault || agentId === "main" ? ["workspace"] : []),
    ...platformManagedWorkspaces(agentId),
  ]);
  if (!allowed.has(relativePath)) {
    throw new Error(`configured user agent ${agentId}.workspace is outside its canonical workspace root`);
  }
}

function assertPortableSessionStore(relativePath: string, agentId: string): void {
  if (relativePath !== `agents/${agentId}/sessions/sessions.json`) {
    throw new Error(`session.store for ${agentId} is outside its canonical session root`);
  }
}

function configuredSessionStoreTemplate(config: OpenclawConfig): string | undefined {
  const session = config.session;
  if (session === undefined) return undefined;
  const record = recordValue(session, "session");
  if (!Object.hasOwn(record, "store")) return undefined;
  const store = record.store;
  if (
    typeof store !== "string" ||
    store.length === 0 ||
    !store.includes("{agentId}") ||
    store.replaceAll("{agentId}", "").includes("{") ||
    store.replaceAll("{agentId}", "").includes("}")
  ) {
    throw new Error("session.store must be an absolute {agentId} User state template");
  }
  return store;
}

function declaredUserAgentIds(config: OpenclawConfig): string[] {
  const agents = config.agents;
  if (agents?.entries !== undefined) {
    const agentIds: string[] = [];
    for (const [agentId, entry] of Object.entries(agents.entries ?? {})) {
      if (entry === null || entry === undefined) continue;
      assertPortableConfiguredAgentId(agentId);
      agentIds.push(agentId);
    }
    return agentIds.sort((left, right) => left.localeCompare(right));
  }
  const agentIds: string[] = [];
  for (const entry of agents?.list ?? []) {
    if (!isRecord(entry)) throw new Error("configured user agents.list entry must be an object");
    assertPortableConfiguredAgentId(entry.id);
    agentIds.push(entry.id);
  }
  return agentIds
    .filter((agentId, index, ids) => ids.indexOf(agentId) === index)
    .sort((left, right) => left.localeCompare(right));
}

function configuredUserAgentIds(config: OpenclawConfig): string[] {
  const declared = declaredUserAgentIds(config);
  return declared.length === 0 ? ["main"] : declared;
}

function dedupePortableStatePaths(
  paths: readonly ConfiguredUserPortableStatePath[],
): ConfiguredUserPortableStatePath[] {
  const directories = paths
    .filter((item) => item.kind === "directory")
    .sort((left, right) =>
      left.relativePath.length - right.relativePath.length ||
      left.relativePath.localeCompare(right.relativePath),
    );
  const retainedDirectories: ConfiguredUserPortableStatePath[] = [];
  for (const directory of directories) {
    if (retainedDirectories.some((parent) =>
      directory.relativePath === parent.relativePath ||
      directory.relativePath.startsWith(`${parent.relativePath}/`))) {
      continue;
    }
    retainedDirectories.push(directory);
  }
  const retainedFiles = paths
    .filter((item) => item.kind === "file")
    .filter((file, index, files) =>
      files.findIndex((candidate) => candidate.relativePath === file.relativePath) === index)
    .filter((file) => !retainedDirectories.some((directory) =>
      file.relativePath.startsWith(`${directory.relativePath}/`)))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return [...retainedDirectories, ...retainedFiles]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function configuredUserPortableStatePlanFromConfig(
  config: OpenclawConfig,
  stateDir: string,
): ConfiguredUserPortableStatePlan {
  if (!path.isAbsolute(stateDir)) {
    throw new Error("User OpenClaw state root must be absolute");
  }
  const agentIds = configuredUserAgentIds(config);
  const defaultWorkspacePath = configuredDefaultWorkspace(config, stateDir);
  const sessionStoreTemplate = configuredSessionStoreTemplate(config);
  const declaredDefaultAgentIds = agentIds.filter((agentId) =>
    configuredDefaultAgent(configuredAgentRecords(config, agentId), agentId));
  if (declaredDefaultAgentIds.length > 1) {
    throw new Error("configured user roster has more than one default agent");
  }
  const defaultAgentId = declaredDefaultAgentIds[0] ?? (agentIds.length === 1 ? agentIds[0] : null);
  if (defaultWorkspacePath !== undefined && defaultAgentId === null && agentIds.some((agentId) =>
    configuredPathField(configuredAgentRecords(config, agentId), "workspace", `configured user agent ${agentId}`) === undefined)) {
    throw new Error("agents.defaults.workspace requires a unique default user agent");
  }
  const paths: ConfiguredUserPortableStatePath[] = [];
  const agentDirs = new Set<string>();
  const sessionStorePaths = new Set<string>();
  for (const agentId of agentIds) {
    const records = configuredAgentRecords(config, agentId);
    const isDefault = defaultAgentId === agentId;
    const explicitAgentDir = configuredPathField(records, "agentDir", `configured user agent ${agentId}`);
    const agentDir = explicitAgentDir === undefined
      ? defaultPortablePath(stateDir, "agents", agentId, "agent")
      : resolveExplicitPortablePath(explicitAgentDir, stateDir, `configured user agent ${agentId}.agentDir`);
    assertPortableAgentDir(agentDir, agentId);
    const explicitWorkspace = configuredPathField(records, "workspace", `configured user agent ${agentId}`);
    const workspace = explicitWorkspace === undefined
      ? defaultWorkspace(
        stateDir,
        agentId,
        isDefault,
        defaultWorkspacePath,
      )
      : resolveExplicitPortablePath(explicitWorkspace, stateDir, `configured user agent ${agentId}.workspace`);
    assertPortableWorkspace(workspace, agentId, isDefault);
    const defaultAgentRoot = defaultPortablePath(stateDir, "agents", agentId);
    paths.push(
      { relativePath: defaultAgentRoot, kind: "directory" },
      { relativePath: agentDir, kind: "directory" },
      { relativePath: workspace, kind: "directory" },
      { relativePath: defaultPortablePath(stateDir, "memory", `${agentId}.sqlite`), kind: "file" },
    );
    agentDirs.add(agentDir);
    const sessionStore = sessionStoreTemplate === undefined
      ? defaultPortablePath(stateDir, "agents", agentId, "sessions", "sessions.json")
      : resolveExplicitPortablePath(
        sessionStoreTemplate.replaceAll("{agentId}", agentId),
        stateDir,
        `session.store for ${agentId}`,
      );
    assertPortableSessionStore(sessionStore, agentId);
    sessionStorePaths.add(sessionStore);
    paths.push({ relativePath: path.posix.dirname(sessionStore), kind: "directory" });
  }
  return {
    agentIds,
    agentDirs: [...agentDirs].sort((left, right) => left.localeCompare(right)),
    sessionStorePaths: [...sessionStorePaths].sort((left, right) => left.localeCompare(right)),
    paths: dedupePortableStatePaths(paths),
  };
}

export function configuredUserPortableStatePlan(
  configPath: string,
  stateDir: string,
): ConfiguredUserPortableStatePlan {
  const config = readOpenclawConfig(configPath);
  if (config === null) throw new Error("configured user openclaw config is unreadable");
  return configuredUserPortableStatePlanFromConfig(config, stateDir);
}

export function configuredUserStatePlanAllowsEntry(
  raw: string,
  plan: ConfiguredUserPortableStatePlan,
): boolean {
  const entry = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  return plan.paths.some((item) => {
    if (item.kind === "directory") {
      return entry === item.relativePath || entry.startsWith(`${item.relativePath}/`) ||
        (raw.endsWith("/") && item.relativePath.startsWith(`${entry}/`));
    }
    return entry === item.relativePath ||
      (raw.endsWith("/") && item.relativePath.startsWith(`${entry}/`));
  });
}

function existingPathOrNull(absolutePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertNoSymlinkPathPrefix(stateDir: string, relativePath: string): boolean {
  let current = path.resolve(stateDir);
  const root = existingPathOrNull(current);
  if (root === null) return false;
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("User OpenClaw state root is not a real directory");
  }
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const entry = existingPathOrNull(current);
    if (entry === null) return false;
    if (entry.isSymbolicLink()) {
      throw new Error(`configured user durable state path contains a symlink: ${relativePath}`);
    }
  }
  return true;
}

// Symlinks inside a portable tree ride the carry as symlinks (rsync -a) and are
// digested by target, so a user workspace with node_modules/.bin stays
// portable; only sockets, fifos, and devices are unrepresentable.
function assertPortableStateTree(absolutePath: string, relativePath: string, stat = fs.lstatSync(absolutePath)): void {
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`configured user durable state path is not regular: ${relativePath}`);
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    const childPath = path.join(absolutePath, entry.name);
    const childStat = lstatUnlessVolatileEntryVanished(childPath, entry.name);
    if (childStat !== null) assertPortableStateTree(childPath, `${relativePath}/${entry.name}`, childStat);
  }
}

const SQLITE_SIDECAR_SHAPE = /\.sqlite-(?:wal|shm|journal)$/u;

function isVolatileStateEntry(name: string): boolean {
  return name.endsWith(".lock") || SQLITE_SIDECAR_SHAPE.test(name) || isSqliteVolatileArtifactPath(name);
}

function lstatUnlessVolatileEntryVanished(absolutePath: string, name: string): fs.Stats | null {
  try {
    return fs.lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && isVolatileStateEntry(name)) return null;
    throw error;
  }
}

export function assertConfiguredUserPortableStatePlanOnDisk(
  stateDir: string,
  plan: ConfiguredUserPortableStatePlan,
): void {
  for (const item of plan.paths) {
    if (!assertNoSymlinkPathPrefix(stateDir, item.relativePath)) continue;
    const absolutePath = path.join(path.resolve(stateDir), item.relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (item.kind === "directory" && !stat.isDirectory()) {
      throw new Error(`configured user durable state directory is not a directory: ${item.relativePath}`);
    }
    if (item.kind === "file" && !stat.isFile()) {
      throw new Error(`configured user durable state file is not a file: ${item.relativePath}`);
    }
    assertPortableStateTree(absolutePath, item.relativePath);
  }
}

/**
 * True iff `slug`'s agent is fully wired in an already-parsed config: its agent
 * agent is in `agents.list` or keyed `agents.entries`, its `{slug}-coach` Mattermost account exists, and
 * a Mattermost binding references both the agent agent and that account. Pure:
 * callers that check many slugs parse the config once (see readOpenclawConfig).
 */
export function defaultAgentWiredInParsedConfig(config: OpenclawConfig, slug: string): boolean {
  if (!isSafeSlug(slug)) return false;
  const agentId = userDefaultAgentId(slug);
  const accountId = `${slug}-coach`;
  const agents = config.agents?.list;
  const entries = config.agents?.entries;
  const accounts = config.channels?.mattermost?.accounts;
  const bindings = config.bindings;
  return Boolean(
    (isRecord(entries)
      ? Object.prototype.hasOwnProperty.call(entries, agentId)
      : Array.isArray(agents) && agents.some((entry) => isRecord(entry) && entry.id === agentId)) &&
      accounts &&
      Object.prototype.hasOwnProperty.call(accounts, accountId) &&
      Array.isArray(bindings) &&
      bindings.some((binding) => isMattermostAccountBinding(binding, agentId, accountId)),
  );
}

/** Convenience single-slug check (reads + parses the config per call). */
export function userDefaultAgentWiredInOpenclawConfig(configPath: string, slug: string): boolean {
  const config = readOpenclawConfig(configPath);
  return config ? defaultAgentWiredInParsedConfig(config, slug) : false;
}

// The mount-completion marker the reconcile's mount direction keys off (vs bare default-agent-wiring)
// to close the post-config wedge. Single-writer: a pod earns its own marker as ensure's last
// step. It must not be INHERITED, or it falsely marks an incomplete mount done. Two inheritance
// paths are blocked: (1) Gitea — it lives under .system/, which workspaceGitignore() excludes,
// so a roll's re-clone never carries it; (2) migration — writeMigratingInPin clears it on
// import, so the target re-earns it after cutover. See DECISIONS.md "Fleet placement is a
// level-triggered reconcile".
const MOUNTED_MARKER_REL = path.join(".system", ".mounted");

function mountedMarkerPath(usersDir: string, slug: string): string {
  return path.join(usersDir, slug, MOUNTED_MARKER_REL);
}

/** True iff the slug's mount-completion marker is present (the LAST step a successful
 *  ensure writes). Never throws — an absent dir/marker is simply false. */
export function hasMountedMarker(usersDir: string, slug: string): boolean {
  return fs.existsSync(mountedMarkerPath(usersDir, slug));
}

/** Stamp the mount-completion marker — the LAST step of a successful ensure, written only
 *  after the user is fully provisioned. Ensures .system/ exists first. */
export function writeMountedMarker(usersDir: string, slug: string): void {
  const markerPath = mountedMarkerPath(usersDir, slug);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, "");
}

export function clearMountedMarker(usersDir: string, slug: string): void {
  fs.rmSync(mountedMarkerPath(usersDir, slug), { force: true });
}

// The migrating-in pin guards a freshly-imported user (default-agent-wired on the target before
// cutover makes it desired-there) from the reconcile's EVICT direction only. Time-bounded by
// mtime so it needs no explicit clear (post-cutover the slug is desired anyway; a failed-
// migration orphan self-expires for lazy eviction). Under .system/.
const MIGRATING_IN_MARKER_REL = path.join(".system", ".migrating-in");

// Also keep a process-local TTL pin. During restore, cloneWorkspaceRepo intentionally removes
// and recreates customers/<slug>, which can erase the disk pin while the reconcile loop is
// still running. The process pin covers that short same-pod window; the disk pin remains the
// restart/health signal.
const migratingInProcessPins = new Map<string, { root: string; slug: string; atMs: number }>();

function migratingInPinPath(usersDir: string, slug: string): string {
  return path.join(usersDir, slug, MIGRATING_IN_MARKER_REL);
}

function processPinKey(usersDir: string, slug: string): string {
  return `${path.resolve(usersDir)}\0${slug}`;
}

function pruneAndCheckProcessPin(usersDir: string, slug: string, ttlMs: number): boolean {
  const key = processPinKey(usersDir, slug);
  const pin = migratingInProcessPins.get(key);
  if (!pin) return false;
  if (Date.now() - pin.atMs < ttlMs) return true;
  migratingInProcessPins.delete(key);
  return false;
}

function listProcessPinnedSlugs(usersDir: string, ttlMs: number): string[] {
  const root = path.resolve(usersDir);
  const slugs: string[] = [];
  for (const [key, pin] of migratingInProcessPins) {
    if (pin.root !== root) continue;
    if (Date.now() - pin.atMs >= ttlMs) {
      migratingInProcessPins.delete(key);
      continue;
    }
    if (isSafeSlug(pin.slug)) slugs.push(pin.slug);
  }
  return slugs;
}

export function _resetMigratingInProcessPinsForTests(): void {
  migratingInProcessPins.clear();
}

/** True iff a migrating-in pin exists for the slug AND is newer than ttlMs. Never throws. */
export function isMigratingInPinned(usersDir: string, slug: string, ttlMs: number): boolean {
  if (pruneAndCheckProcessPin(usersDir, slug, ttlMs)) return true;
  try {
    const ageMs = Date.now() - fs.statSync(migratingInPinPath(usersDir, slug)).mtimeMs;
    return ageMs < ttlMs;
  } catch {
    return false;
  }
}

/**
 * Stamp the migrating-in pin (import handler, before activation). Ensures .system/ exists.
 * Also clears any .mounted marker that rode in on the migration tarball: an import is NOT a
 * completed mount on THIS pod, so the target must re-earn its own marker after cutover rather
 * than inherit the source's — keeping .mounted single-writer (a pod's own ensure) and the
 * post-config wedge guard intact.
 */
export function writeMigratingInPin(usersDir: string, slug: string): void {
  const root = path.resolve(usersDir);
  const pinPath = migratingInPinPath(usersDir, slug);
  fs.mkdirSync(path.dirname(pinPath), { recursive: true });
  fs.rmSync(mountedMarkerPath(usersDir, slug), { force: true });
  fs.writeFileSync(pinPath, "");
  migratingInProcessPins.set(processPinKey(usersDir, slug), { root, slug, atMs: Date.now() });
}

export function clearMigratingInPin(usersDir: string, slug: string): void {
  fs.rmSync(migratingInPinPath(usersDir, slug), { force: true });
  migratingInProcessPins.delete(processPinKey(usersDir, slug));
}

export function listMigratingInSlugs(usersDir: string, ttlMs: number): string[] {
  const slugs = new Set<string>(listProcessPinnedSlugs(usersDir, ttlMs));
  for (const slug of listLocalUserDirs(usersDir)) {
    if (isMigratingInPinned(usersDir, slug, ttlMs)) slugs.add(slug);
  }
  return [...slugs].sort((a, b) => a.localeCompare(b));
}

/**
 * Raw on-disk user dirs (safe-slug-named directories under usersDir), WITHOUT the
 * default-agent-wired filter. The reconcile's evict direction observes this — so a partial/junk dir
 * left by a mount that died before its config patch is still drained once it's unassigned
 * (default-agent-wired presence would never see it). Never throws — a missing dir is [].
 */
export function listLocalUserDirs(usersDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(usersDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(isSafeSlug)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The pod's honest mounted set, read WITHOUT Firestore: user dirs present on the
 * PVC whose agent is wired. The fleet controller polls this via /health and intersects it with the
 * assigned roster on the trusted side; the chat-proxy uses it to reconcile agents.
 */
export function listLocalDefaultAgentWiredSlugs(
  usersDir: string,
  isDefaultAgentWired: (slug: string) => boolean,
): string[] {
  return listLocalUserDirs(usersDir).filter((slug) => isDefaultAgentWired(slug));
}
