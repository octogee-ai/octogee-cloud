import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  product: {} as Record<string, any>,
  platform: new Map<string, Record<string, unknown>>(),
}));

vi.mock('@octogee/core/identity/platform-state-store', async () => {
  const { createDocumentFixtureStore } = await import('@octogee/core/testing/journal-store');
  return { platformStateStore: createDocumentFixtureStore(h.platform) };
});

import { readProject } from '@octogee/core/workspace/firestoreReads';
import { installDocumentPresentation } from './helpers/project-presentation.js';

installDocumentPresentation((path) => ({ get: async () => ({ data: () => h.product[path] }) }));

const projectPath = 'workspaces/alice/projects/game';

beforeEach(() => {
  for (const key of Object.keys(h.product)) delete h.product[key];
  h.platform.clear();
});

describe('readProject', () => {
  it('returns null when the store has no record, even if a product document remains', async () => {
    h.product[projectPath] = { name: 'Residue', ownerUid: 'u-alice' };

    expect(await readProject('alice', 'game')).toBeNull();
  });

  it('combines the product presentation with the platform record', async () => {
    h.product[projectPath] = { id: 'game', workspaceId: 'alice', slug: 'game', ownerUid: 'u-alice', name: 'My Game', visibility: 'private', provisioningState: 'active' };
    h.platform.set(projectPath, { ownerUid: 'u-alice', visibility: 'private', provisioningState: 'active' });

    const project = await readProject('alice', 'game');

    expect(project).toMatchObject({ id: 'game', slug: 'game', workspaceId: 'alice', ownerUid: 'u-alice', name: 'My Game', visibility: 'private' });
  });

  it('takes authorization and lifecycle fields from the store over a stale projection', async () => {
    h.product[projectPath] = { ownerUid: 'stale-owner', name: 'My Game', visibility: 'public', provisioningState: 'provisioning', commercialLifecycle: { status: 'active' } };
    h.platform.set(projectPath, {
      ownerUid: 'u-alice',
      visibility: 'private',
      provisioningState: 'active',
      commercialLifecycle: { status: 'archived' },
    });

    expect(await readProject('alice', 'game')).toMatchObject({
      ownerUid: 'u-alice',
      name: 'My Game',
      visibility: 'private',
      provisioningState: 'active',
      commercialLifecycle: { status: 'archived' },
    });
  });

  it('supplies identity fields when the product document has not been written yet', async () => {
    h.platform.set(projectPath, { ownerUid: 'u-alice', provisioningState: 'provisioning' });

    expect(await readProject('alice', 'game')).toMatchObject({ id: 'game', slug: 'game', workspaceId: 'alice', ownerUid: 'u-alice' });
  });
});
