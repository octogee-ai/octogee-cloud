import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ documents: new Map<string, Record<string, unknown>>() }));

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.documents, { serializeTransactions: true }) };
});

const { platformStateStore } = await import("@octogee/core/identity/platform-state-store");
const { mintTicket, TicketCapExceededError, HourlyMintQuotaExceededError, _testInternal } = await import("../lib/gateway-ticket.js");

const VOICE_CAP = _testInternal.POLICIES["voice-ws"].perUidCap as number;
const VOICE_QUOTA = _testInternal.POLICIES["voice-ws"].hourlyQuota as number;
const tickets = platformStateStore.access.gatewayTickets;

async function recordVoiceMints(count: number, now: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await tickets.recordMint({ uid: "u1", purpose: "voice-ws", mintedAt: now - i * 1000, expiresAt: now + _testInternal.HOURLY_WINDOW_MS });
  }
}

describe("mintTicket", () => {
  beforeEach(() => {
    h.documents.clear();
  });

  it("stores the ticket under a fresh UUID with uid, gatewayId, purpose and a future expiry", async () => {
    const t = await mintTicket({ uid: "u1", gatewayId: "gw-walter", purpose: "openclaw-ws" });
    expect(t.ticket).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.purpose).toBe("openclaw-ws");
    const stored = await tickets.get(t.ticket);
    expect(stored).toMatchObject({ ticketId: t.ticket, uid: "u1", gatewayId: "gw-walter", grant: { purpose: "openclaw-ws" } });
    expect(stored!.expiresAt).toBeGreaterThan(Date.now());
    expect(stored!.expiresAt).toBe(t.expiresAt);
  });

  it("round-trips an opaque feature payload", async () => {
    const t = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "openclaw-ws", payload: { session: "dashboard" } });
    expect((await tickets.get(t.ticket))?.grant).toMatchObject({ payload: { session: "dashboard" } });
    expect(t.payload).toMatchObject({ session: "dashboard" });
  });

  it("two mints return distinct UUID ticket ids", async () => {
    const a = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "preview" });
    const b = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "preview" });
    expect(a.ticket).not.toBe(b.ticket);
  });

  it("mints an uncapped purpose (mattermost-ws) freely past the voice cap", async () => {
    for (let i = 0; i < VOICE_CAP + 10; i++) {
      await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "mattermost-ws" });
    }
    const ok = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "mattermost-ws" });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("throws TicketCapExceededError at the per-uid voice-ws cap", async () => {
    for (let i = 0; i < VOICE_CAP; i++) {
      await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} });
    }
    await expect(mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} })).rejects.toThrow(TicketCapExceededError);
  });

  it("caps per (uid, purpose): an exhausted voice-ws cap does not block preview", async () => {
    for (let i = 0; i < VOICE_CAP; i++) {
      await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} });
    }
    const ok = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "preview" });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("caps per uid: u2 is unaffected by u1's exhausted cap", async () => {
    for (let i = 0; i < VOICE_CAP; i++) {
      await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} });
    }
    const ok = await mintTicket({ uid: "u2", gatewayId: "gw", purpose: "voice-ws", payload: {} });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("caps sustained voice-ws mints at the hourly quota", async () => {
    await recordVoiceMints(VOICE_QUOTA - 1, Date.now());
    const ok = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
    await expect(mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} })).rejects.toThrow(HourlyMintQuotaExceededError);
  });

  it("applies the hourly quota per (uid, purpose): an exhausted voice window does not block openclaw-ws", async () => {
    await recordVoiceMints(VOICE_QUOTA, Date.now());
    await expect(mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} })).rejects.toThrow(HourlyMintQuotaExceededError);
    const ok = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "openclaw-ws" });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("holds the per-uid cap under concurrent mints", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: VOICE_CAP + 2 }, () => mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(VOICE_CAP);
    await expect(tickets.countLive("u1", "voice-ws", Date.now())).resolves.toBe(VOICE_CAP);
  });

  it("rejects an invalid purpose", async () => {
    await expect(mintTicket({ uid: "u1", gatewayId: "gw", purpose: "nope" as unknown as "preview" })).rejects.toThrow();
  });

  it("rejects a missing uid and stores an empty gatewayId", async () => {
    await expect(mintTicket({ uid: "", gatewayId: "gw", purpose: "preview" })).rejects.toThrow();
    const ok = await mintTicket({ uid: "u1", gatewayId: "", purpose: "openclaw-ws" });
    expect(ok.gatewayId).toBe("");
    expect((await tickets.get(ok.ticket))?.gatewayId).toBe("");
  });
});
