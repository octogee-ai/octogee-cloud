import { vi } from "vitest";

// Keep firebase-admin out of the `npm test` (non-emulator) unit suite.
// gateway-edge/src/lib/db builds LIVE Firebase clients at first use, so any
// spec that uses it unmocked starts ADC/metadata work that hangs and — under
// the forks pool — bleeds across sibling files. Mock the module inert globally
// (specs that declare their own vi.mock for it still win, so seeded fakes are
// unaffected); the offline env is a backstop so a stray direct firebase-admin
// call fails fast instead of hanging on ADC. An emulator config doesn't load
// this setup, so real-emulator specs are unaffected.
vi.mock("../../../gateway-edge/src/lib/db", () => {
  const inertDoc: Record<string, unknown> = {};
  inertDoc.get = async () => ({ exists: false, data: () => undefined });
  inertDoc.set = async () => undefined;
  inertDoc.update = async () => undefined;
  inertDoc.delete = async () => undefined;
  inertDoc.collection = () => ({ doc: () => inertDoc });
  const inertDb = {
    doc: () => inertDoc,
    collection: () => ({ doc: () => inertDoc }),
  };
  return {
    auth: { verifyIdToken: vi.fn().mockResolvedValue({ uid: "hermetic-uid" }) },
    db: inertDb,
    storage: {
      bucket: vi.fn(() => { throw new Error("offline storage bucket accessed"); }),
    },
    messaging: {},
    FieldValue: {
      serverTimestamp: () => ({ __op: "serverTimestamp" }),
      increment: (n: number) => ({ __op: "increment", value: n }),
      arrayUnion: (v: unknown) => ({ __op: "arrayUnion", value: v }),
      arrayRemove: (v: unknown) => ({ __op: "arrayRemove", value: v }),
      delete: () => ({ __op: "delete" }),
    },
    Timestamp: {
      now: () => ({ toDate: () => new Date(0), toMillis: () => 0 }),
      fromDate: (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() }),
    },
  };
});

const CLOSED_PORT = "127.0.0.1:1";
process.env.GCLOUD_PROJECT ||= "octogee-unit-test";
process.env.GOOGLE_CLOUD_PROJECT ||= process.env.GCLOUD_PROJECT;
process.env.METADATA_SERVER_DETECTION ||= "none";
process.env.GCE_METADATA_HOST ||= CLOSED_PORT;
process.env.FIRESTORE_EMULATOR_HOST ||= CLOSED_PORT;
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= CLOSED_PORT;
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= CLOSED_PORT;
process.env.STORAGE_EMULATOR_HOST ||= `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}`;
