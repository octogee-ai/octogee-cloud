import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import * as tls from "node:tls";

export const MIGRATION_TLS_SERVER_NAME = "octogee-migration";
const OPENSSL_BIN = "/usr/bin/openssl";
const CERTIFICATE_PEM_SHAPE = /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n?$/u;
const CERTIFICATE_PEM_MAX_LENGTH = 8_192;
const OPENSSL_TIMEOUT_MS = 30_000;

export interface MigrationTlsEndpoint {
  certificatePem: string;
  close: () => Promise<void>;
}

export interface OpenMigrationTlsEndpointInput {
  dir: string;
  publicPort: number;
  upstreamPort: number;
  sourceIp?: string;
  log?: (message: string) => void;
}

export type OpenMigrationTlsEndpoint = (input: OpenMigrationTlsEndpointInput) => Promise<MigrationTlsEndpoint>;

export function isMigrationCertificatePem(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= CERTIFICATE_PEM_MAX_LENGTH &&
    CERTIFICATE_PEM_SHAPE.test(value);
}

function runOpenssl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(OPENSSL_BIN, args, { timeout: OPENSSL_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`openssl ${args[0]} failed: ${String(stderr).trim() || error.message}`));
      else resolve();
    });
  });
}

async function createMigrationCertificate(dir: string): Promise<{ keyPath: string; certPath: string }> {
  const keyPath = path.join(dir, "migration-tls.key");
  const certPath = path.join(dir, "migration-tls.crt");
  await runOpenssl([
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-days", "1", "-subj", `/CN=${MIGRATION_TLS_SERVER_NAME}`,
    "-addext", `subjectAltName=DNS:${MIGRATION_TLS_SERVER_NAME}`,
    "-keyout", keyPath, "-out", certPath,
  ]);
  await fs.chmod(keyPath, 0o600);
  return { keyPath, certPath };
}

function normalizePeerAddress(address: string | undefined): string | undefined {
  return address?.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

export function startMigrationTlsTerminator(input: {
  key: string;
  cert: string;
  publicPort: number;
  upstreamPort: number;
  sourceIp?: string;
  log?: (message: string) => void;
}): Promise<{ close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = tls.createServer(
    { key: input.key, cert: input.cert, minVersion: "TLSv1.3" },
    (secure) => {
      const peer = normalizePeerAddress(secure.remoteAddress);
      if (input.sourceIp !== undefined && peer !== input.sourceIp) {
        input.log?.(`[migration-tls] refused peer ${peer ?? "unknown"} (expected ${input.sourceIp})`);
        secure.destroy();
        return;
      }
      const upstream = net.connect({ host: "127.0.0.1", port: input.upstreamPort });
      sockets.add(secure);
      sockets.add(upstream);
      const end = () => {
        secure.destroy();
        upstream.destroy();
        sockets.delete(secure);
        sockets.delete(upstream);
      };
      secure.on("error", end);
      upstream.on("error", end);
      secure.on("close", end);
      upstream.on("close", end);
      secure.pipe(upstream).pipe(secure);
    },
  );
  server.on("tlsClientError", (error, socket) => {
    input.log?.(`[migration-tls] handshake refused from ${normalizePeerAddress(socket.remoteAddress) ?? "unknown"}: ${error.message}`);
  });
  const close = (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    return new Promise((done) => server.close(() => done()));
  };
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.publicPort, () => {
      server.off("error", reject);
      resolve({ close });
    });
  });
}

export const openMigrationTlsEndpoint: OpenMigrationTlsEndpoint = async (input) => {
  const { keyPath, certPath } = await createMigrationCertificate(input.dir);
  const [key, certificatePem] = await Promise.all([
    fs.readFile(keyPath, "utf8"),
    fs.readFile(certPath, "utf8"),
  ]);
  const terminator = await startMigrationTlsTerminator({
    key,
    cert: certificatePem,
    publicPort: input.publicPort,
    upstreamPort: input.upstreamPort,
    sourceIp: input.sourceIp,
    log: input.log,
  });
  return { certificatePem, close: terminator.close };
};

export function rsyncTlsConnectProgram(input: { certificatePath: string; host: string; port: number }): string {
  const address = net.isIPv6(input.host) ? `[${input.host}]` : input.host;
  return [
    OPENSSL_BIN, "s_client", "-quiet", "-nocommands", "-verify_return_error", "-verify_quiet", "-tls1_3",
    "-CAfile", input.certificatePath,
    "-verify_hostname", MIGRATION_TLS_SERVER_NAME,
    "-connect", `${address}:${input.port}`,
  ].join(" ");
}

export function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not reserve a loopback port for the rsync daemon"));
      });
    });
  });
}
