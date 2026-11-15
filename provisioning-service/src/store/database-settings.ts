import { isIP } from "node:net";
import type pg from "pg";

const SSL_MODES = ["disable", "require", "verify-full"] as const;
const PREFIX = "PROVISIONING_DB_";

export type DatabaseSslMode = (typeof SSL_MODES)[number];

export interface DatabaseSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: DatabaseSslMode;
  caCertificate?: string;
  tlsServerIdentity?: string;
  poolMax: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

function present(environment: Environment, name: string): string | undefined {
  const value = environment[`${PREFIX}${name}`];
  return value === undefined || value === "" ? undefined : value;
}

function required(environment: Environment, name: string): string {
  const value = present(environment, name);
  if (value === undefined) throw new Error(`${PREFIX}${name} is required`);
  return value;
}

function positiveInteger(environment: Environment, name: string, fallback: number, maximum: number): number {
  const value = present(environment, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${PREFIX}${name} must be an integer from 1 to ${maximum}, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function databaseSettingsFromEnvironment(environment: Environment): DatabaseSettings {
  const host = required(environment, "HOST");
  const mode = required(environment, "SSLMODE");
  const sslMode = SSL_MODES.find((candidate) => candidate === mode);
  if (sslMode === undefined) throw new Error(`${PREFIX}SSLMODE must be one of ${SSL_MODES.join(", ")}, got ${JSON.stringify(mode)}`);
  const caCertificate = present(environment, "CA_CERT");
  const tlsServerIdentity = present(environment, "TLS_SERVER_IDENTITY");
  if (caCertificate !== undefined && sslMode !== "verify-full") {
    throw new Error(`${PREFIX}CA_CERT only applies with ${PREFIX}SSLMODE=verify-full, got ${sslMode}`);
  }
  if (tlsServerIdentity !== undefined && (sslMode !== "verify-full" || isIP(host) === 0)) {
    throw new Error(`${PREFIX}TLS_SERVER_IDENTITY requires verify-full and an IP address in ${PREFIX}HOST`);
  }
  return {
    host,
    port: positiveInteger(environment, "PORT", 5432, 65_535),
    database: required(environment, "NAME"),
    user: required(environment, "USER"),
    password: required(environment, "PASSWORD"),
    sslMode,
    ...(caCertificate === undefined ? {} : { caCertificate }),
    ...(tlsServerIdentity === undefined ? {} : { tlsServerIdentity }),
    poolMax: positiveInteger(environment, "POOL_MAX", 10, 1_000),
  };
}

function sslOptions(settings: DatabaseSettings): pg.PoolConfig["ssl"] {
  switch (settings.sslMode) {
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-full": {
      const identity = settings.tlsServerIdentity ?? settings.host;
      return {
        rejectUnauthorized: true,
        host: identity,
        ...(settings.tlsServerIdentity !== undefined && isIP(identity) === 0 ? { servername: identity } : {}),
        ...(settings.caCertificate === undefined ? {} : { ca: settings.caCertificate }),
      };
    }
  }
}

export function databaseConnection(settings: DatabaseSettings): pg.ClientConfig & { max: number } {
  return {
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: settings.password,
    ssl: sslOptions(settings),
    max: settings.poolMax,
    connectionTimeoutMillis: 10_000,
    lock_timeout: 5_000,
    statement_timeout: 60_000,
    idle_in_transaction_session_timeout: 30_000,
  };
}
