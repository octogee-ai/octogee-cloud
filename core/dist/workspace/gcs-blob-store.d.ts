import type { Bucket } from "@google-cloud/storage";
import { type BlobStore } from "./blob-store.js";
export declare function createGcsBlobStore(bucket: () => Bucket | Promise<Bucket>): BlobStore;
