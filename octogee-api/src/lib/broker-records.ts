import type { PlatformStateStore } from "@octogee/core/platform-state";
import { platformStateUserAccountReader, userAccountDocument } from "@octogee/core/platform-state-user-accounts";
import { noUserAccounts, type UserAccountReader } from "@octogee/core/user-account";
import { NO_AGENT_IDENTITY, type AgentIdentityRecords } from "../../../gateway-edge/src/lib/agent-identity.js";
import type { FleetBrokerUsageData } from "@octogee/shared/types/fleet-broker";

import { UNCONFIGURED_MODEL_BROKER_USAGE, type ModelBrokerUsageLedger } from "./model-broker-usage.js";

type Document = Record<string, unknown>;

export interface UserDocuments {
  account(uid: string): Promise<Document | undefined>;
  accounts(uids: readonly string[]): Promise<ReadonlyMap<string, Document>>;
  agent(uid: string): Promise<Document | undefined>;
  systemConfig(uid: string): Promise<Document | undefined>;
  projectRecipes(workspaceSlug: string): Promise<ReadonlyMap<string, string>>;
}

export interface ByosubFlowRecord {
  readonly uid: string;
  readonly gatewayId: string;
  readonly agentId: string;
  readonly provider: string;
  readonly modelCredentialProvider: string;
  readonly createdAt: number;
  readonly expireAt: number;
}

export interface ByosubRecords {
  readIntegration(uid: string): Promise<Document | undefined>;
  readFlow(flowId: string): Promise<Document | undefined>;
  startFlow(flowId: string, flow: ByosubFlowRecord): Promise<void>;
}

export interface UsageEvent {
  readonly uid: string;
  readonly agentId: string;
  readonly usage: FleetBrokerUsageData;
  readonly gatewayId: string;
  readonly workspaceSlug: string | null;
}

export interface BrokerRecords {
  readonly accounts: UserAccountReader;
  readonly userDocuments: UserDocuments;
  readonly usage: ModelBrokerUsageLedger;
  readonly byosub: ByosubRecords;
  readonly agentIdentity: AgentIdentityRecords;
  recordUsageEvent(event: UsageEvent): Promise<void>;
}

export const NO_BROKER_RECORDS: BrokerRecords = {
  accounts: noUserAccounts,
  userDocuments: {
    account: async () => undefined,
    accounts: async () => new Map(),
    agent: async () => undefined,
    systemConfig: async () => undefined,
    projectRecipes: async () => new Map(),
  },
  usage: UNCONFIGURED_MODEL_BROKER_USAGE,
  byosub: {
    readIntegration: async () => undefined,
    readFlow: async () => undefined,
    startFlow: async () => {
      throw new Error("BYOSUB flows need a product record store");
    },
  },
  agentIdentity: NO_AGENT_IDENTITY,
  recordUsageEvent: async () => {
    throw new Error("usage events need a product recorder");
  },
};

export function platformStateBrokerRecords(store: Pick<PlatformStateStore, "users">): BrokerRecords {
  return {
    ...NO_BROKER_RECORDS,
    accounts: platformStateUserAccountReader(store),
    userDocuments: {
      ...NO_BROKER_RECORDS.userDocuments,
      account: async (uid) => {
        const record = await store.users.accounts.get(uid);
        return record === null ? undefined : userAccountDocument(record);
      },
      accounts: async (uids) =>
        new Map([...(await store.users.accounts.getMany(uids))].map(([uid, record]) => [uid, userAccountDocument(record)])),
    },
  };
}
