import type { Request } from "express";
import type { FleetBrokerBlobSignedUrl } from "@octogee/shared/types/fleet-broker";
export interface BlobMetadata {
    size: string;
    storage?: "s3";
    generation?: string;
    md5Hash?: string;
}
export interface BlobWriteOptions {
    contentType: string;
    ifGenerationMatch?: string | number;
}
export interface BlobSignRequest {
    gcsPath: string;
    action: "read" | "write";
    contentType?: string;
    ifGenerationMatch?: number | string;
    generation?: string;
    contentMd5?: string;
    contentLength?: number;
}
export interface BlobStore {
    save(key: string, bytes: Buffer | string, options: BlobWriteOptions): Promise<void>;
    saveStream(key: string, source: AsyncIterable<Uint8Array>, options: {
        contentType: string;
    }): Promise<void>;
    move(from: string, to: string): Promise<void>;
    download(key: string): Promise<{
        bytes: Buffer;
        revision: string;
    } | null>;
    delete(key: string, generation?: string): Promise<void>;
    deletePrefix(prefix: string): Promise<void>;
    metadata(key: string): Promise<BlobMetadata>;
    signedUrl(input: BlobSignRequest, expires: number): Promise<FleetBrokerBlobSignedUrl>;
}
export declare function requestBlobStore(req: Request): BlobStore | undefined;
export declare function blobStatus(error: unknown): string;
