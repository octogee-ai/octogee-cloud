const ENV_KEY = "OCTOGEE_ALLOW_LOCAL_ORIGINS";
const LOCALHOST_ORIGIN_RE = /^http:\/\/localhost:\d+$/;
export function localDevOriginsAllowed() {
    return process.env[ENV_KEY] === "true";
}
export function isAllowedLocalhostOrigin(origin) {
    return localDevOriginsAllowed() && LOCALHOST_ORIGIN_RE.test(origin);
}
export function isAllowedLocalhostHostname(hostname) {
    return localDevOriginsAllowed() && hostname === "localhost";
}
