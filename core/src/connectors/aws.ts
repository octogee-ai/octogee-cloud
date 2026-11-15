import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { ConnectorDef } from "./def.js";
import { catalogMeta } from "./def.js";

export const awsConnector: ConnectorDef = {
  meta: catalogMeta("aws"),
  fetchIdentity: async () => {
    throw new Error("AWS uses an access-key pair, not a bare token");
  },
  validateFields: async (fields) => {
    const client = new STSClient({
      region: "us-east-1",
      credentials: {
        accessKeyId: fields.accessKeyId,
        secretAccessKey: fields.secretAccessKey,
      },
    });
    const out = await client.send(new GetCallerIdentityCommand({}));
    if (!out.Arn || !out.Account) {
      throw new Error("AWS GetCallerIdentity returned no identity");
    }
    const principal = out.Arn.split("/").pop() ?? out.Arn;
    return { accountLabel: `${out.Account} · ${principal}` };
  },
};
