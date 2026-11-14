import { describe, expect, it } from 'vitest';
import { migrationSourceReady, type MigrationGatewayRoot } from '../migration-root-stability.js';

type SourceRoot = MigrationGatewayRoot & { gatewayClass: string };

describe('migration source readiness', () => {
  const source: SourceRoot = { gatewayClass: 'isolated', desiredStatus: 'running', desiredRelease: 2, liveRelease: 1 };
  it('allows a Native forward recovery to retain its exact live source through a pending rollout', () => {
    expect(migrationSourceReady(source, 1)).toBe(true);
    expect(migrationSourceReady(source)).toBe(false);
  });
  it.each<SourceRoot>([
    { ...source, liveRelease: 2 },
    { ...source, liveRelease: null },
    { ...source, desiredStatus: 'retired' },
    { ...source, gatewayClass: 'shared' },
  ])('refuses a changed or retired recovery source', changed => {
    expect(migrationSourceReady(changed, 1)).toBe(false);
  });
});
