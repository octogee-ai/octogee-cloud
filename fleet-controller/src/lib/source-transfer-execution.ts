import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { SourceTransferAuthority, SourceTransferExecution } from '@octogee/shared/types/glm';
export type { SourceTransferAuthority, SourceTransferExecution } from '@octogee/shared/types/glm';
export interface SourceTransferPod {
  metadata: { name?: string; namespace?: string; uid?: string; resourceVersion?: string; deletionTimestamp?: string };
  spec: {
    shareProcessNamespace?: boolean;
    hostPID?: boolean;
    volumes?: { name: string; emptyDir?: unknown }[];
    containers?: { name: string; volumeMounts?: { name: string; mountPath: string }[] }[];
    ephemeralContainers?: Record<string, unknown>[];
  };
  status?: { ephemeralContainerStatuses?: { name: string; state?: { terminated?: { exitCode: number; message?: string }; running?: unknown } }[] };
}

function assertAuthority(authority: SourceTransferAuthority, pod: SourceTransferPod): void {
  const {metadata, spec} = pod;
  if (spec.shareProcessNamespace === true || spec.hostPID === true) throw new Error("source transfer requires an isolated process namespace");
  if ([metadata.uid !== authority.podUid, metadata.name !== authority.podName, metadata.namespace !== authority.namespace, metadata.deletionTimestamp, !metadata.resourceVersion].some(Boolean)) throw new Error('source pod changed');
  if ([!authority.sourceGatewayId.startsWith('shared-'), !Number.isSafeInteger(authority.assignmentEpoch), authority.assignmentEpoch < 1, !Number.isSafeInteger(authority.claimStartedAt), authority.claimStartedAt < 1].some(Boolean)) throw new Error('invalid source transfer authority');
  for (const value of [authority.operationId, authority.migrationId, authority.uid, authority.slug, authority.podUid]) if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error('invalid source transfer identity');
  if (!/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(authority.image)) throw new Error('source transfer requires immutable image');
  if (!spec.volumes?.some(volume => volume.name === 'data' && volume.emptyDir !== undefined) || !spec.containers?.some(container => container.volumeMounts?.some(mount => mount.name === 'data' && mount.mountPath === '/home/node'))) throw new Error('source data volume unavailable');
}

export function planSourceTransfer(authority: SourceTransferAuthority, pod: SourceTransferPod) {
  assertAuthority(authority, pod);
  const identity = [authority.operationId, authority.claimStartedAt, authority.migrationId, authority.uid, authority.slug, authority.sourceGatewayId, authority.assignmentEpoch, authority.namespace, authority.podName, authority.podUid, authority.image, authority.targetGatewayId, authority.targetName, authority.targetIp, authority.targetVm, authority.targetIdentity];
  const executionId = `snapshot-transfer-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,24)}`;
  const record: SourceTransferExecution = { ...authority, executionId, status: 'reserved' };
  const container = {
    name: executionId,
    image: authority.image,
    command: ['/usr/bin/python3','/octogee/scripts/libexec/source-transfer-launcher.py',executionId],
    stdin: true, stdinOnce: true, tty: false,
    env: [{name: 'SOURCE_POD_UID',valueFrom: {fieldRef: {fieldPath: 'metadata.uid'}}}],
    volumeMounts: [{ name: 'data', mountPath: '/home/node', readOnly: true }],
    securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true, runAsUser: 1000, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
    terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File',
  };
  const containers = pod.spec.ephemeralContainers ?? [];
  const existing = containers.find(candidate => candidate.name === executionId);
  if (existing && !isDeepStrictEqual(existing, container)) throw new Error('source transfer execution collision');
  const patch = existing ? null : [
    {op:'test',path:'/metadata/uid',value:authority.podUid},
    {op:'test',path:'/metadata/resourceVersion',value:pod.metadata.resourceVersion},
    {op:'add',path:'/spec/ephemeralContainers',value:[...containers,container]},
  ];
  return {record, container, patch};
}

export function sourceTransferBlocksRelease(record: SourceTransferExecution | undefined): boolean {
  return record !== undefined && (record.targetCleanup === 'pending' || (record.status !== 'transferred' && record.status !== 'failed'));
}

function transferReceiptMatches(record: SourceTransferExecution, message: string | undefined): boolean {
  if (!message || Buffer.byteLength(message) > 1024) return false;
  let receipt: Record<string, unknown> | null;
  try { receipt = JSON.parse(message); } catch { return false; }
  return receipt !== null && [Object.keys(receipt).length === 5, receipt.version === 1, receipt.executionId === record.executionId, receipt.migrationId === record.migrationId, receipt.sourcePodUid === record.podUid, receipt.status === 'transferred'].every(Boolean);
}

export function observeSourceTransfer(record: SourceTransferExecution, pod: SourceTransferPod): SourceTransferExecution {
  if (record.podUid !== pod.metadata.uid) return {...record,status:'unresolved'};
  const terminated = pod.status?.ephemeralContainerStatuses?.find(container => container.name === record.executionId)?.state?.terminated;
  if (!terminated) return record;
  if (terminated.exitCode !== 0) return {...record,status:'failed',exitCode:terminated.exitCode};
  return {...record,status:transferReceiptMatches(record,terminated.message) ? 'transferred' : 'unresolved',exitCode:0};
}
