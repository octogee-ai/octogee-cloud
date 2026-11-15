import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { coreTestOnlyDependencies, firebaseReach, firebaseRuntimeDependencies, runtimeSpecifiers } from "../lib/firebase-reach.js";

const cloudRoot = resolve(import.meta.dirname, "../..");

describe("Firebase gate", () => {
  it("lets no file reached from a platform entrypoint load Firebase", () => {
    expect(firebaseReach(cloudRoot), "these files load Firebase from a platform entrypoint; platform code must not use Firebase").toEqual([]);
  });

  it("lets no platform package install Firebase at runtime", () => {
    expect(firebaseRuntimeDependencies(cloudRoot), "these package.json entries install Firebase for platform consumers; a spec that needs it lists it under devDependencies").toEqual([]);
  });

  it("keeps test frameworks and Firebase out of what @octogee/core builds and declares", () => {
    expect(coreTestOnlyDependencies(cloudRoot), "test helpers belong in @octogee/core-testing; core's specs list these under devDependencies").toEqual([]);
  });
});

describe("runtimeSpecifiers", () => {
  it("counts value, side-effect, dynamic and re-export imports", () => {
    expect(runtimeSpecifiers([
      'import { FieldValue, type Firestore } from "firebase-admin/firestore";',
      'import "./side-effect.js";',
      'const { getStorage } = await import("firebase-admin/storage");',
      'export { db } from "./db.js";',
    ].join("\n")).sort()).toEqual(["./db.js", "./side-effect.js", "firebase-admin/firestore", "firebase-admin/storage"]);
  });

  it("skips type-only imports and re-exports, even across lines", () => {
    expect(runtimeSpecifiers([
      "import type {",
      "  Firestore,",
      '} from "firebase-admin/firestore";',
      'export type { Auth } from "firebase-admin/auth";',
      'import { exportedValue } from "./values.js";',
    ].join("\n"))).toEqual(["./values.js"]);
  });
});

describe("fixture trees", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function tree(files: Record<string, string>): string {
    root = mkdtempSync(join(tmpdir(), "firebase-reach-"));
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
    }
    return root;
  }

  it("lists reachable files that load firebase-admin or firebase-functions at runtime", () => {
    const fixture = tree({
      "api/src/main.ts": [
        'import "./uses-admin.js";',
        'import "./types-only.js";',
        'import "./plain.js";',
        'import "./dynamic.js";',
        'import "./functions.js";',
      ].join("\n"),
      "api/src/uses-admin.ts": 'import { getFirestore } from "firebase-admin/firestore";\nexport const db = getFirestore();',
      "api/src/types-only.ts": 'import type { Firestore } from "firebase-admin/firestore";\nexport type Db = Firestore;',
      "api/src/plain.ts": "export const plain = 1;",
      "api/src/dynamic.ts": 'export const bucket = async () => (await import("firebase-admin/storage")).getStorage();',
      "api/src/functions.ts": 'export { onRequest } from "firebase-functions/v2/https";',
      "edge/src/unreached.ts": 'import { getAuth } from "firebase-admin/auth";',
    });

    expect(firebaseReach(fixture, ["api/src/main.ts"])).toEqual([
      "api/src/dynamic.ts",
      "api/src/functions.ts",
      "api/src/uses-admin.ts",
    ]);
  });

  it("lists test-only packages that core declares, exports for or imports from built source", () => {
    const fixture = tree({
      "core/package.json": JSON.stringify({
        exports: { "./config": {}, "./testing/journal-store": {} },
        dependencies: { express: "^5.0.0" },
        devDependencies: { vitest: "^4.0.0" },
        peerDependencies: { supertest: "^7.0.0", "firebase-admin": "^14.0.0" },
        peerDependenciesMeta: { "firebase-admin": { optional: true } },
      }),
      "core/src/config.ts": 'import type { Firestore } from "firebase-admin/firestore";\nexport type Db = Firestore;',
      "core/src/helpers.ts": 'export const load = () => import("vitest");',
      "core/src/plain.ts": 'import express from "express";\nexport const app = express();',
      "core/src/config.spec.ts": 'import { it } from "vitest";',
      "core/src/fixtures/users.ts": 'import { beforeEach } from "vitest";',
    });

    expect(coreTestOnlyDependencies(fixture)).toEqual([
      "core/package.json exports ./testing/journal-store",
      "core/package.json peerDependencies.firebase-admin",
      "core/package.json peerDependencies.supertest",
      "core/src/config.ts imports firebase-admin",
      "core/src/helpers.ts imports vitest",
    ]);
  });

  it("lists Firebase packages that a package.json installs for its consumers", () => {
    const fixture = tree({
      "api/package.json": JSON.stringify({ dependencies: { express: "^5.0.0", "firebase-admin": "^14.0.0" } }),
      "worker/package.json": JSON.stringify({ optionalDependencies: { "firebase-functions": "^7.0.0" } }),
      "types/package.json": JSON.stringify({
        peerDependencies: { "firebase-admin": "^14.0.0", "firebase-functions": "^7.0.0" },
        peerDependenciesMeta: { "firebase-admin": { optional: true } },
      }),
      "core/package.json": JSON.stringify({ devDependencies: { "firebase-admin": "^14.0.0" } }),
      "api/node_modules/dep/package.json": JSON.stringify({ dependencies: { "firebase-admin": "^14.0.0" } }),
    });

    expect(firebaseRuntimeDependencies(fixture)).toEqual([
      "api/package.json dependencies.firebase-admin",
      "types/package.json peerDependencies.firebase-functions",
      "worker/package.json optionalDependencies.firebase-functions",
    ]);
  });
});
