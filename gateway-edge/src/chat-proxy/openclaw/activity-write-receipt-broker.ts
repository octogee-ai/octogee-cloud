import type {
  ActivityAttachmentReceiptV1,
  ActivityReceiptClaim,
  ActivityReceiptClaimInput,
  ActivityWriteReceiptStore,
  ActivityWriteReceiptV1,
} from "@octogee/core/http-candidates/chat-proxy/openclaw/activity-write-receipts";

export interface ActivityWriteReceiptBrokerPort {
  claimActivityWriteReceipt(
    channelDocPath: string,
    input: ActivityReceiptClaimInput,
  ): Promise<ActivityReceiptClaim>;
  readActivityWriteReceipt(
    channelDocPath: string,
    eventKey: string,
  ): Promise<ActivityWriteReceiptV1 | null>;
  markActivityWriteReceiptPosted(
    channelDocPath: string,
    eventKey: string,
    leaseToken: string,
    postId: string,
    now: number,
  ): Promise<void>;
  updateActivityWriteReceiptAttachment(
    channelDocPath: string,
    eventKey: string,
    leaseToken: string,
    attachment: ActivityAttachmentReceiptV1,
    now: number,
  ): Promise<void>;
  commitActivityWriteReceipt(
    channelDocPath: string,
    eventKey: string,
    leaseToken: string,
    now: number,
  ): Promise<void>;
}

export class BrokeredActivityWriteReceiptStore implements ActivityWriteReceiptStore {
  constructor(
    private readonly broker: ActivityWriteReceiptBrokerPort,
    private readonly channelDocPath: string,
  ) {}

  claim(input: ActivityReceiptClaimInput): Promise<ActivityReceiptClaim> {
    return this.broker.claimActivityWriteReceipt(this.channelDocPath, input);
  }

  read(eventKey: string): Promise<ActivityWriteReceiptV1 | null> {
    return this.broker.readActivityWriteReceipt(this.channelDocPath, eventKey);
  }

  markPosted(eventKey: string, leaseToken: string, postId: string, now: number): Promise<void> {
    return this.broker.markActivityWriteReceiptPosted(
      this.channelDocPath,
      eventKey,
      leaseToken,
      postId,
      now,
    );
  }

  updateAttachment(
    eventKey: string,
    leaseToken: string,
    attachment: ActivityAttachmentReceiptV1,
    now: number,
  ): Promise<void> {
    return this.broker.updateActivityWriteReceiptAttachment(
      this.channelDocPath,
      eventKey,
      leaseToken,
      attachment,
      now,
    );
  }

  commit(eventKey: string, leaseToken: string, now: number): Promise<void> {
    return this.broker.commitActivityWriteReceipt(
      this.channelDocPath,
      eventKey,
      leaseToken,
      now,
    );
  }
}
