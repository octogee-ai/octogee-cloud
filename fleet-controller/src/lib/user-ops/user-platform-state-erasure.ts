import type { PlatformStateStore, PlatformStateTransaction } from "@octogee/core/platform-state";
import type { ProductUserData, UserDataScope } from "./user-lifecycle-product.js";

const PLATFORM_WRITE_BATCH_SIZE = 400;

type PlatformWrite = (transaction: PlatformStateTransaction) => Promise<void>;

async function platformStateReferences(store: PlatformStateStore, uid: string, currentOperationId: string) {
  const [operations, receipts, assignments, members, projectMembers, tokens, pointers, accessRecords] = await Promise.all([
    store.journal.operations.listReferencingUid(uid),
    store.journal.recoveryReceipts.listReferencingUid(uid),
    store.gateways.assignments.listForUid(uid),
    store.workspaces.members.listForUid(uid),
    store.workspaces.projectMembers.listForUid(uid),
    store.access.modelBrokerTokens.listForOwner(uid),
    store.access.modelBrokerGatewayTokens.listForOwner(uid),
    store.access.listRecordsForUid(uid),
  ]);
  return {
    operations: operations.filter((operation) => operation.id !== currentOperationId),
    receipts,
    assignments,
    members,
    projectMembers,
    tokens,
    pointers,
    accessRecords,
  };
}

type PlatformStateReferences = Awaited<ReturnType<typeof platformStateReferences>>;

function platformStateReferencePaths(references: PlatformStateReferences): string[] {
  return [
    ...references.operations.map((operation) => `glmOperations/${operation.id}`),
    ...references.receipts.map((receipt) => `gatewayRecoveryReceipts/${receipt.id}`),
    ...references.assignments.map((assignment) => `gateways/${assignment.gatewayId}/assignments/${assignment.uid}`),
    ...references.members.map((member) => `workspaces/${member.workspaceSlug}/members/${member.uid}`),
    ...references.projectMembers.map((member) => `workspaces/${member.workspaceSlug}/projects/${member.projectSlug}/members/${member.uid}`),
    ...references.tokens.map((token) => `modelBrokerTokens/${token.tokenHash}`),
    ...references.pointers.map((pointer) => `modelBrokerGatewayTokens/${pointer.pointerKey}`),
    ...references.accessRecords,
  ];
}

function platformStateReferenceDeletes(references: PlatformStateReferences): PlatformWrite[] {
  return [
    ...references.operations.map((operation): PlatformWrite => (transaction) =>
      transaction.journal.operations.delete(operation.id)),
    ...references.receipts.map((receipt): PlatformWrite => (transaction) =>
      transaction.journal.recoveryReceipts.delete(receipt.id)),
    ...references.assignments.map((assignment): PlatformWrite => (transaction) =>
      transaction.gateways.assignments.delete(assignment.gatewayId, assignment.uid)),
    ...references.members.map((member): PlatformWrite => (transaction) =>
      transaction.workspaces.members.delete(member.workspaceSlug, member.uid)),
    ...references.projectMembers.map((member): PlatformWrite => (transaction) =>
      transaction.workspaces.projectMembers.delete(member.workspaceSlug, member.projectSlug, member.uid)),
    ...references.tokens.map((token): PlatformWrite => (transaction) =>
      transaction.access.modelBrokerTokens.delete(token.tokenHash)),
    ...references.pointers.map((pointer): PlatformWrite => (transaction) =>
      transaction.access.modelBrokerGatewayTokens.delete(pointer.pointerKey)),
  ];
}

export async function eraseUserRecords(
  store: PlatformStateStore,
  product: Pick<ProductUserData, "eraseRecords"> | undefined,
  scope: UserDataScope,
): Promise<void> {
  const { uid, slug, currentOperationId } = scope;
  const writes = platformStateReferenceDeletes(await platformStateReferences(store, uid, currentOperationId));
  await product?.eraseRecords(scope);
  for (let offset = 0; offset < writes.length; offset += PLATFORM_WRITE_BATCH_SIZE) {
    const chunk = writes.slice(offset, offset + PLATFORM_WRITE_BATCH_SIZE);
    await store.transaction({ label: "customer-erasure.platform-references" }, async (transaction) => {
      for (const write of chunk) await write(transaction);
    });
  }
  await store.access.eraseForUid(uid);
  await store.workspaces.agentIdentities.delete(uid);
  if (slug) await store.workspaces.records.delete(slug);
  await store.users.records.delete(uid);
}

export async function remainingUserRecords(
  store: PlatformStateStore,
  product: Pick<ProductUserData, "remaining"> | undefined,
  scope: UserDataScope,
): Promise<string[]> {
  const [platform, productRecords] = await Promise.all([
    remainingPlatformUserState(store, scope.uid, scope.slug, scope.currentOperationId),
    product?.remaining(scope) ?? [],
  ]);
  return Array.from(new Set([...platform, ...productRecords])).sort();
}

export async function remainingPlatformUserState(
  store: PlatformStateStore,
  uid: string,
  slug: string,
  currentOperationId: string,
): Promise<string[]> {
  const [user, agentIdentity, workspace, ownedGateways, references] = await Promise.all([
    store.users.records.get(uid),
    store.workspaces.agentIdentities.get(uid),
    slug ? store.workspaces.records.get(slug) : null,
    store.gateways.roots.list({ ownerUid: uid }),
    platformStateReferences(store, uid, currentOperationId),
  ]);
  return Array.from(new Set([
    ...(user === null ? [] : [`users/${uid}`]),
    ...(agentIdentity === null ? [] : [`agents/${uid}`]),
    ...(workspace === null ? [] : [`workspaces/${slug}`]),
    ...ownedGateways.map((root) => `gateways/${root.gatewayId}`),
    ...platformStateReferencePaths(references),
  ])).sort();
}
