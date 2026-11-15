const ENV_KEY = "OCTOGEE_ALLOW_LOCAL_ORIGINS";
const LOCALHOST_ORIGIN_RE = /^http:\/\/localhost:\d+$/;

export function localDevOriginsAllowed(): boolean {
  return process.env[ENV_KEY] === "true";
}

export function isAllowedLocalhostOrigin(origin: string): boolean {
  return localDevOriginsAllowed() && LOCALHOST_ORIGIN_RE.test(origin);
}

export function isAllowedLocalhostHostname(hostname: string): boolean {
  return localDevOriginsAllowed() && hostname === "localhost";
}
