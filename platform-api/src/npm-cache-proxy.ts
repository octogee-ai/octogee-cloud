import { GoogleAuth } from "google-auth-library";

import { internalFetch } from "../../gateway-edge/src/lib/internal-fetch.js";
import { logger } from "../../gateway-edge/src/middleware/logging.js";
import {
  NPM_CACHE_CAPABILITY_AUDIENCE,
  type NpmCacheCapabilityAuthorization,
} from "./lib/npm-cache-capabilities.js";
import { createNpmCacheProxyApp } from "./npm-cache-proxy-app.js";

const PORT = Number(process.env.PORT ?? "3005");
const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";
const OCTOGEE_API_URL = process.env.OCTOGEE_API_URL ??
  `http://octogee-api.${NAMESPACE}.svc.cluster.local:3001`;
const UPSTREAM_REGISTRY_URL = process.env.NPM_CACHE_UPSTREAM_REGISTRY_URL;
if (!UPSTREAM_REGISTRY_URL) {
  throw new Error("NPM_CACHE_UPSTREAM_REGISTRY_URL is required");
}

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
let authClient: ReturnType<typeof auth.getClient> | undefined;

async function authorizeCapability(token: string): Promise<NpmCacheCapabilityAuthorization | null> {
  const response = await internalFetch(
    `${OCTOGEE_API_URL.replace(/\/$/u, "")}/internal/fleet/npm-cache-authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(5_000),
    },
    { requireProjectedToken: true },
  );
  if (response.status === 403) return null;
  if (!response.ok) throw new Error(`npm cache authorization failed: HTTP ${response.status}`);
  const payload = await response.json() as { authorization?: NpmCacheCapabilityAuthorization };
  return payload.authorization?.audience === NPM_CACHE_CAPABILITY_AUDIENCE
    ? payload.authorization
    : null;
}

async function artifactRegistryAccessToken(): Promise<string> {
  authClient ??= auth.getClient().catch((error) => {
    authClient = undefined;
    throw error;
  });
  const client = await authClient;
  const result = await client.getAccessToken();
  const token = typeof result === "string" ? result : result.token;
  if (!token) throw new Error("artifact registry access token unavailable");
  return token;
}

const app = createNpmCacheProxyApp({
  authorizeCapability,
  artifactRegistryAccessToken,
  upstreamRegistryUrl: UPSTREAM_REGISTRY_URL,
  reportEvent: (event) => logger.info("npm-cache-proxy request", { ...event }),
});

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    logger.info("npm-cache-proxy boot", {
      port: PORT,
      namespace: NAMESPACE,
      sha: process.env.BUILD_SHA ?? "unknown",
    });
  });
}

export default app;
