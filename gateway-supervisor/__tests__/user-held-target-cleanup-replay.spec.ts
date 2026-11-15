import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSurgeOpenClawProcessGate, type SurgeOpenClawProcessRequest, type SurgeOpenClawProcessSupervisorClient } from '../lib/surge-openclaw-process-gate.js';
import { createIsolatedSurgeGateWiring } from '../lib/fleet-provisioner.js';

describe('held isolated target cleanup replay', () => {
  it.each(['success', 'cleanup-unavailable'])('keeps exact released-target custody when replaying cleanup after rollback: %s', async scenario => {
    const directory = await mkdtemp(join(tmpdir(), 'user-roll-retry-'));
    try {
      const gate = createSurgeOpenClawProcessGate(directory);
      const request = { migrationId: 'mig-builder-activate-builder-a-g1', slug: 'alice', targetPodUid: 'old' };
      const identity = { ...request, podUid: 'old' };
      await gate.ensure({ podUid: 'old', readinessReleased: false });
      await gate.hydrateTarget(identity); await gate.unreserveTarget(identity);
      await expect(gate.hold(identity)).rejects.toThrow('target migration already released');
      const processGate = { status: gate.read, reholdReleasedTarget: (input: SurgeOpenClawProcessRequest) => gate.reholdReleasedTarget({ ...input, podUid: 'old' }),
        finalizeTargetCancellation: (input: SurgeOpenClawProcessRequest) => gate.finalizeTargetCancellation({ ...input, podUid: 'old' }),
      } as SurgeOpenClawProcessSupervisorClient;
      const wiring = createIsolatedSurgeGateWiring({ processGate, configuredUserAssigned: async () => false,
        log: vi.fn(), adapter: {}, surgeReadiness: {}, provisioning: {}, waitForGatewayHealthy: async () => undefined, waitForGatewayReady: async () => undefined,
      } as unknown as Parameters<typeof createIsolatedSurgeGateWiring>[0]);
      const cleanup = vi.fn(async (assertCurrent: () => Promise<void>) => {
        await assertCurrent(); if (scenario === 'cleanup-unavailable') { throw new Error('Native cleanup unavailable'); }
      });
      if (scenario === 'success') {
        await expect(wiring.unreserveSurgeTarget(request, cleanup)).resolves.toMatchObject({ role: 'normal', mode: 'held', phase: 'held', terminalTarget: request });
        await expect(wiring.unreserveSurgeTarget(request, cleanup)).resolves.toMatchObject({ role: 'normal', mode: 'held', phase: 'held', terminalTarget: request });
        expect(cleanup).toHaveBeenCalledTimes(2);
      } else {
        await expect(wiring.unreserveSurgeTarget(request, cleanup)).rejects.toThrow('Native cleanup unavailable');
        expect(await gate.read()).toMatchObject({ role: 'target', mode: 'held', phase: 'cancelling', ...request });
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
