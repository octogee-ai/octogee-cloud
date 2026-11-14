import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const specifications = ["src/agent-store-postgres.integration.spec.ts", "src/agent-store-recovery.integration.spec.ts", "src/agent-store-handoff.integration.spec.ts", "src/agent-store-credential-retirement.integration.spec.ts", "src/agent-store-reset.integration.spec.ts", "src/platform-state/postgres/__tests__/migrate.integration.spec.ts", "src/platform-state/postgres/__tests__/neutral-stored-names.integration.spec.ts", "src/platform-state/postgres/__tests__/transaction.integration.spec.ts", "src/platform-state/postgres/__tests__/records.integration.spec.ts", "src/platform-state/postgres/__tests__/journal.integration.spec.ts", "src/platform-state/postgres/__tests__/watch.integration.spec.ts", "src/platform-state/postgres/__tests__/expiry.integration.spec.ts", "src/platform-state/postgres/__tests__/users.integration.spec.ts", "src/platform-state/postgres/__tests__/user-fences.integration.spec.ts", "src/platform-state/postgres/__tests__/user-queries.integration.spec.ts", "src/platform-state/postgres/__tests__/user-subcollections.integration.spec.ts", "src/platform-state/postgres/__tests__/user-accounts.integration.spec.ts", "src/platform-state-user-accounts.integration.spec.ts", "src/platform-user-admin.integration.spec.ts", "src/platform-state/postgres/__tests__/users-watch.integration.spec.ts", "src/platform-state/postgres/__tests__/workspaces.integration.spec.ts", "src/platform-state/postgres/__tests__/secrets.integration.spec.ts", "src/platform-state/postgres/__tests__/runtime-secret-store.integration.spec.ts", "src/model-broker-usage-ledger.integration.spec.ts", "src/platform-state/postgres/__tests__/jobs.integration.spec.ts", "src/platform-state/postgres/__tests__/gateways.integration.spec.ts", "src/platform-state/postgres/__tests__/fleet-registry.integration.spec.ts", "src/platform-state/postgres/__tests__/controller-state.integration.spec.ts", "src/platform-state/postgres/__tests__/migration-tasks.integration.spec.ts", "src/platform-state/postgres/__tests__/config.integration.spec.ts"];

export function runCorePostgresChecks() {
  const bin = "/usr/lib/postgresql/16/bin";
  const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
  const server = (command, args) => process.getuid?.() === 0
    ? run("/usr/sbin/runuser", ["-u", "postgres", "--", join(bin, command), ...args])
    : run(join(bin, command), args);
  const version = run(join(bin, "postgres"), ["--version"], { encoding: "utf8", stdio: "pipe" });
  if (!/^postgres \(PostgreSQL\) 16\./.test(version)) throw new Error("Core CI requires PostgreSQL 16");
  for (const spec of specifications) {
    if (!existsSync(join(root, "core", spec))) throw new Error(`Missing required PostgreSQL test: ${spec}`);
  }
  const directory = mkdtempSync(join(tmpdir(), "oc-pg-"));
  const data = join(directory, "data");
  const socket = join(directory, "socket");
  let started = false;
  let stopped = false;
  try {
    mkdirSync(socket, { mode: 0o700 });
    if (process.getuid?.() === 0) run("chown", ["-R", "postgres:postgres", directory]);
    server("initdb", ["-D", data, "--username=postgres", "--auth-local=trust", "--auth-host=reject", "--encoding=UTF8", "--no-locale"]);
    appendFileSync(join(data, "postgresql.conf"), `\nlisten_addresses = ''\nunix_socket_directories = '${socket.replaceAll("'", "''")}'\nunix_socket_permissions = 0700\n`);
    server("pg_ctl", ["-D", data, "-l", join(directory, "server.log"), "-w", "-t", "30", "start"]);
    started = true;
    const connection = ["-h", socket, "-U", "postgres", "-v", "ON_ERROR_STOP=1"];
    run(join(bin, "psql"), [...connection, "-d", "postgres", "-c", "CREATE ROLE octogee_ci_admin LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS"]);
    run(join(bin, "createdb"), ["-h", socket, "-U", "postgres", "-O", "octogee_ci_admin", "octogee_ci"]);
    run(join(bin, "psql"), [...connection, "-d", "octogee_ci", "-c", "CREATE EXTENSION vector; CREATE EXTENSION unaccent; CREATE EXTENSION pg_trgm"]);
    const dsn = new URL("postgresql://octogee_ci_admin@localhost/octogee_ci");
    dsn.searchParams.set("host", socket);
    const env = { ...process.env, OCTOGEE_TEST_POSTGRES_DSN: dsn.href };
    const preflight = run(join(bin, "psql"), [dsn.href, "-v", "ON_ERROR_STOP=1", "-At", "-c", `SELECT current_user = 'octogee_ci_admin'
      AND current_setting('server_version_num')::int BETWEEN 160000 AND 169999
      AND NOT rolsuper AND rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls
      AND (SELECT datdba FROM pg_database WHERE datname = current_database()) = oid
      AND (SELECT extversion FROM pg_extension WHERE extname = 'vector') = '0.8.7'
      FROM pg_roles WHERE rolname = current_user`], { env, encoding: "utf8", stdio: "pipe" });
    if (preflight.trim() !== "t") throw new Error("Core PostgreSQL CI requires a non-superuser CREATEROLE database owner and pgvector 0.8.7");
    const { sourceSha } = JSON.parse(readFileSync(join(root, "infra/gateway/openclaw-tarball/current.json"), "utf8"));
    if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("Invalid pinned Native source SHA");
    const checkout = join(directory, "native");
    run("git", ["init", "--quiet", checkout]);
    run("git", ["-C", checkout, "fetch", "--depth=1", "https://github.com/ceckert/openclaw.git", sourceSha], {
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    run("git", ["-C", checkout, "checkout", "--detach", sourceSha]);
    run("corepack", ["pnpm", "--filter", ".", "install", "--frozen-lockfile", "--ignore-scripts"], { cwd: checkout, env });
    run(process.execPath, [join(root, "scripts/ops/qualify-agent-store-routines.mjs"), checkout], { env });
    const failures = [];
    try { run("git", ["diff", "--exit-code", "--", "core/src/agent-store-routines.json"]); }
    catch (error) { failures.push(`Qualified Native catalog drift: ${error.message}`); }
    try { run("npm", ["test", "--", ...specifications, "--maxWorkers=1", "--no-file-parallelism"], { cwd: join(root, "core"), env }); }
    catch (error) { failures.push(`PostgreSQL integration failed: ${error.message}`); }
    if (failures.length) throw new Error(failures.join("\n"));
  } finally {
    try {
      if (started || existsSync(join(data, "postmaster.pid"))) server("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]);
      stopped = true;
    } finally {
      if (stopped) rmSync(directory, { recursive: true, force: true });
      else console.error(`PostgreSQL cleanup failed; retained private cluster at ${directory}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) runCorePostgresChecks();
