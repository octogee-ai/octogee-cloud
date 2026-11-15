import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const service = join(root, "provisioning-service");

export function runProvisioningServicePostgresChecks() {
  const bin = "/usr/lib/postgresql/16/bin";
  const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
  const server = (command, args) => process.getuid?.() === 0
    ? run("/usr/sbin/runuser", ["-u", "postgres", "--", join(bin, command), ...args])
    : run(join(bin, command), args);
  const version = run(join(bin, "postgres"), ["--version"], { encoding: "utf8", stdio: "pipe" });
  if (!/^postgres \(PostgreSQL\) 16\./.test(version)) throw new Error("The provisioning service checks require PostgreSQL 16");
  const directory = mkdtempSync(join(tmpdir(), "ps-pg-"));
  const data = join(directory, "data");
  const socket = join(directory, "socket");
  let started = false;
  let stopped = false;
  try {
    mkdirSync(socket, { mode: 0o700 });
    if (process.getuid?.() === 0) run("chown", ["-R", "postgres:postgres", directory]);
    server("initdb", ["-D", data, "--username=postgres", "--auth-local=trust", "--auth-host=reject", "--encoding=UTF8", "--no-locale"]);
    appendFileSync(join(data, "postgresql.conf"), `\nlisten_addresses = ''\nunix_socket_directories = '${socket.replaceAll("'", "''")}'\nunix_socket_permissions = 0700\nmax_connections = 300\n`);
    server("pg_ctl", ["-D", data, "-l", join(directory, "server.log"), "-w", "-t", "30", "start"]);
    started = true;
    const connection = ["-h", socket, "-U", "postgres", "-v", "ON_ERROR_STOP=1"];
    run(join(bin, "psql"), [...connection, "-d", "postgres", "-c", "CREATE ROLE provisioning_ci LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"]);
    run(join(bin, "createdb"), ["-h", socket, "-U", "postgres", "-O", "provisioning_ci", "provisioning_ci"]);
    const dsn = new URL("postgresql://provisioning_ci@localhost/provisioning_ci");
    dsn.searchParams.set("host", socket);
    const env = { ...process.env, OCTOGEE_TEST_POSTGRES_DSN: dsn.href };
    const failures = [];
    try { run("npm", ["test", "--", "--maxWorkers=1", "--no-file-parallelism"], { cwd: service, env }); }
    catch (error) { failures.push(`Provisioning service tests failed: ${error.message}`); }
    try { run("npm", ["run", "conformance"], { cwd: service, env }); }
    catch (error) { failures.push(`Provisioning conformance suite failed: ${error.message}`); }
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

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) runProvisioningServicePostgresChecks();
