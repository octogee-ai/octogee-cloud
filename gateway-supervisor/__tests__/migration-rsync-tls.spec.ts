import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  isMigrationCertificatePem,
  MIGRATION_TLS_SERVER_NAME,
  openMigrationTlsEndpoint,
  reserveLoopbackPort,
  rsyncTlsConnectProgram,
  type MigrationTlsEndpoint,
} from "../lib/migration-rsync-tls.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function echoUpstream(): Promise<number> {
  const server = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}

async function endpoint(sourceIp?: string): Promise<{ endpoint: MigrationTlsEndpoint; port: number; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migration-tls-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const port = await reserveLoopbackPort();
  const opened = await openMigrationTlsEndpoint({
    dir,
    publicPort: port,
    upstreamPort: await echoUpstream(),
    sourceIp,
  });
  cleanups.push(opened.close);
  return { endpoint: opened, port, dir };
}

function exchange(port: number, ca: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port,
      ca,
      servername: MIGRATION_TLS_SERVER_NAME,
      minVersion: "TLSv1.3",
    }, () => socket.write(message));
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (received.length >= message.length) socket.end();
    });
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
  });
}

describe("migration rsync TLS endpoint", () => {
  it("tunnels a client pinned to the migration certificate through to the loopback daemon", async () => {
    const { endpoint: opened, port } = await endpoint("127.0.0.1");

    await expect(exchange(port, opened.certificatePem, "@RSYNCD: 32.0\n")).resolves.toBe("@RSYNCD: 32.0\n");
    expect(isMigrationCertificatePem(opened.certificatePem)).toBe(true);
  });

  it("refuses a client pinned to a different certificate", async () => {
    const { port } = await endpoint();
    const { endpoint: other } = await endpoint();

    await expect(exchange(port, other.certificatePem, "hello")).rejects.toThrow();
  });

  it("drops a peer that is not the migration source", async () => {
    const { endpoint: opened, port } = await endpoint("10.1.0.10");

    await expect(exchange(port, opened.certificatePem, "hello")).resolves.toBe("");
  });

  it.runIf(process.platform === "linux")("carries a byte stream through the exact openssl connect program rsync runs", async () => {
    const { endpoint: opened, port, dir } = await endpoint();
    const certificatePath = path.join(dir, "pinned.crt");
    await fs.writeFile(certificatePath, opened.certificatePem);
    const program = rsyncTlsConnectProgram({ certificatePath, host: "127.0.0.1", port });

    const child = spawn("sh", ["-c", `exec ${program}`], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("Q\nR\n")) child.kill();
    });
    child.stdin.write("Q\nR\n");
    await new Promise((resolve) => child.on("close", resolve));

    expect(output).toBe("Q\nR\n");
  });
});

describe("rsyncTlsConnectProgram", () => {
  it("pins the certificate and server name and brackets an IPv6 target", () => {
    expect(rsyncTlsConnectProgram({ certificatePath: "/tmp/m/target.crt", host: "10.1.0.20", port: 30873 })).toBe(
      "/usr/bin/openssl s_client -quiet -nocommands -verify_return_error -verify_quiet -tls1_3 " +
      "-CAfile /tmp/m/target.crt -verify_hostname octogee-migration -connect 10.1.0.20:30873",
    );
    expect(rsyncTlsConnectProgram({ certificatePath: "/c.crt", host: "fd00::20", port: 30873 }))
      .toContain("-connect [fd00::20]:30873");
  });
});

describe("isMigrationCertificatePem", () => {
  it("accepts only a bounded single PEM certificate", () => {
    expect(isMigrationCertificatePem("-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n")).toBe(true);
    expect(isMigrationCertificatePem("-----BEGIN CERTIFICATE-----\n$(reboot)\n-----END CERTIFICATE-----\n")).toBe(false);
    expect(isMigrationCertificatePem(`-----BEGIN CERTIFICATE-----\n${"A".repeat(9_000)}\n-----END CERTIFICATE-----\n`)).toBe(false);
    expect(isMigrationCertificatePem(undefined)).toBe(false);
  });
});
