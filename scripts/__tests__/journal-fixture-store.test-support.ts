import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createJournalFixtureStore, journalRowsAtPaths, type JournalFixtureOptions } from "@octogee/core-testing/journal-store";

const journalFixturesByDb = new WeakMap<object, { docs: Map<string, Record<string, unknown>>; options: JournalFixtureOptions }>();

export function keepJournalRowsIn(db: object, docs: Map<string, Record<string, unknown>>, options: JournalFixtureOptions = {}): void {
  journalFixturesByDb.set(db, { docs, options });
}

export function journalFixtureStoreFor(options: { db: object }): PlatformStateStore {
  const fixture = journalFixturesByDb.get(options.db);
  if (fixture === undefined) throw new Error("no journal rows are kept for this Firestore fake");
  return createJournalFixtureStore(journalRowsAtPaths(fixture.docs), fixture.options);
}
