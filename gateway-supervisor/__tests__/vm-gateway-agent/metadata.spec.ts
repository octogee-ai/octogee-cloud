import { expect, it, vi } from "vitest";
import { createMetadataClient, METADATA_BASE } from "../../lib/vm-gateway-agent/metadata";

it("mints the VM access token with the email scope so GKE TokenReview can resolve the service account by email", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ access_token: "ya29.fixture", expires_in: 3599, token_type: "Bearer" })) as unknown as typeof fetch;
  await expect(createMetadataClient(fetchImpl).accessToken()).resolves.toBe("ya29.fixture");
  const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
  const requested = new URL(url);
  expect(`${requested.origin}${requested.pathname}`).toBe(`${METADATA_BASE}/instance/service-accounts/default/token`);
  expect(requested.searchParams.get("scopes")?.split(",")).toEqual([
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
  ]);
  expect((init.headers as Record<string, string>)["Metadata-Flavor"]).toBe("Google");
});

it("reads whether GCE has announced this Spot VM's preemption, long-polling for the change once it has an answer", async () => {
  const answers = ["FALSE", "TRUE\n"];
  const fetchImpl = vi.fn(async () => new Response(answers.shift()!)) as unknown as typeof fetch;
  const metadata = createMetadataClient(fetchImpl);

  await expect(metadata.preempted(false)).resolves.toBe(false);
  await expect(metadata.preempted(true)).resolves.toBe(true);

  const [[first, firstInit], [second]] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
  expect(first).toBe(`${METADATA_BASE}/instance/preempted`);
  expect((firstInit.headers as Record<string, string>)["Metadata-Flavor"]).toBe("Google");
  const watched = new URL(second);
  expect(`${watched.origin}${watched.pathname}`).toBe(`${METADATA_BASE}/instance/preempted`);
  expect(watched.searchParams.get("wait_for_change")).toBe("true");
  expect(Number(watched.searchParams.get("timeout_sec"))).toBeGreaterThan(0);
});

it("fails loudly when the metadata server will not say whether the VM is preempted", async () => {
  const fetchImpl = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  await expect(createMetadataClient(fetchImpl).preempted(false)).rejects.toThrow(/metadata instance\/preempted: HTTP 503/);
});
