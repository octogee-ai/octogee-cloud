import { describe, expect, it, vi } from "vitest";
import {
  computeInstanceFromPayload,
  createGceIdentityReviewer,
  createIssuerDispatchingReviewer,
  isGoogleIssuedJwt,
  parseGatewayVmIdentity,
} from "../gce-identity-review.js";
import type { Reviewer } from "../token-review.js";

const EXPECTED = {
  projectId: "octogee",
  serviceAccountEmail: "octogee-computer-test@octogee.iam.gserviceaccount.com",
};

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: "octogee-api",
    email: EXPECTED.serviceAccountEmail,
    email_verified: true,
    google: {
      compute_engine: {
        project_id: "octogee",
        zone: "us-west1-b",
        instance_id: "4242",
        instance_name: "octogee-gw-b-mama-3-abc-hobby",
      },
    },
    ...overrides,
  };
}

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

describe("isGoogleIssuedJwt", () => {
  it("recognises Google's issuer and nothing else", () => {
    expect(isGoogleIssuedJwt(jwt({ iss: "https://accounts.google.com" }))).toBe(true);
    expect(isGoogleIssuedJwt(jwt({ iss: "accounts.google.com" }))).toBe(true);
    expect(isGoogleIssuedJwt(jwt({ iss: "https://kubernetes.default.svc" }))).toBe(false);
    expect(isGoogleIssuedJwt("not.a.jwt.at.all")).toBe(false);
    expect(isGoogleIssuedJwt("a.b")).toBe(false);
  });
});

describe("computeInstanceFromPayload", () => {
  it("extracts the instance identity when the SA, project, and verified email match", () => {
    expect(computeInstanceFromPayload(payload(), EXPECTED)).toEqual({
      projectId: "octogee",
      zone: "us-west1-b",
      instanceId: "4242",
      instanceName: "octogee-gw-b-mama-3-abc-hobby",
    });
  });

  it("rejects another service account, an unverified email, another project, or a token without instance claims", () => {
    expect(computeInstanceFromPayload(payload({ email: "someone-else@octogee.iam.gserviceaccount.com" }), EXPECTED)).toBeNull();
    expect(computeInstanceFromPayload(payload({ email_verified: false }), EXPECTED)).toBeNull();
    expect(computeInstanceFromPayload(payload({ google: { compute_engine: { project_id: "evil", zone: "z", instance_id: "1", instance_name: "n" } } }), EXPECTED)).toBeNull();
    expect(computeInstanceFromPayload(payload({ google: undefined }), EXPECTED)).toBeNull();
    expect(computeInstanceFromPayload(payload({ google: { compute_engine: { project_id: "octogee", zone: "z", instance_name: "n" } } }), EXPECTED)).toBeNull();
  });
});

describe("createGceIdentityReviewer", () => {
  const options = { ...EXPECTED, audience: "octogee-api", namespace: "octogee-test" };

  it("reviews a verified GCE identity token as the VM SA bound to its instance", async () => {
    const verify = vi.fn(async () => payload());
    const review = await createGceIdentityReviewer({ ...options, verify })(jwt(payload()));
    expect(verify).toHaveBeenCalledWith(jwt(payload()), "octogee-api");
    expect(review).toEqual({
      authenticated: true,
      saName: "octogee-computer-test",
      namespace: "octogee-test",
      audiences: ["octogee-api"],
      podName: "octogee-gw-b-mama-3-abc-hobby",
      podUid: "4242",
      computeInstance: {
        projectId: "octogee",
        zone: "us-west1-b",
        instanceId: "4242",
        instanceName: "octogee-gw-b-mama-3-abc-hobby",
      },
    });
  });

  it("fails closed when verification throws, returns nothing, or the issuer is not Google", async () => {
    expect(await createGceIdentityReviewer({ ...options, verify: async () => { throw new Error("bad sig"); } })("x.y.z")).toEqual({ authenticated: false });
    expect(await createGceIdentityReviewer({ ...options, verify: async () => null })("x.y.z")).toEqual({ authenticated: false });
    expect(await createGceIdentityReviewer({ ...options, verify: async () => payload({ iss: "https://evil.example" }) })("x.y.z")).toEqual({ authenticated: false });
  });
});

describe("createIssuerDispatchingReviewer", () => {
  it("sends Google-issued tokens to the GCE reviewer and everything else to Kubernetes", async () => {
    const kubernetes = vi.fn<Reviewer>(async () => ({ authenticated: false }));
    const gce = vi.fn<Reviewer>(async () => ({ authenticated: false }));
    const reviewer = createIssuerDispatchingReviewer({ kubernetes, gce });
    await reviewer(jwt({ iss: "https://accounts.google.com" }));
    await reviewer(jwt({ iss: "https://container.googleapis.com/v1/projects/x/locations/y/clusters/z" }));
    await reviewer("malformed");
    expect(gce).toHaveBeenCalledTimes(1);
    expect(kubernetes).toHaveBeenCalledTimes(2);
  });

  it("forwards a fresh-review request to the selected reviewer", async () => {
    const kubernetes = vi.fn<Reviewer>(async () => ({ authenticated: false }));
    const gce = vi.fn<Reviewer>(async () => ({ authenticated: false }));
    const reviewer = createIssuerDispatchingReviewer({ kubernetes, gce });
    const token = jwt({ iss: "https://container.googleapis.com/v1/projects/x/locations/y/clusters/z" });
    await reviewer(token, { fresh: true });
    expect(kubernetes).toHaveBeenCalledWith(token, { fresh: true });
  });
});

describe("parseGatewayVmIdentity", () => {
  it("is off when neither variable is set, on when both are, and loud when only one is", () => {
    expect(parseGatewayVmIdentity({})).toBeNull();
    expect(parseGatewayVmIdentity({
      GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL: " sa@p.iam.gserviceaccount.com ",
      GATEWAY_COMPUTER_PROJECT_ID: "p",
    })).toEqual({ serviceAccountEmail: "sa@p.iam.gserviceaccount.com", projectId: "p" });
    expect(() => parseGatewayVmIdentity({ GATEWAY_COMPUTER_PROJECT_ID: "p" })).toThrow(/set together/);
  });
});
