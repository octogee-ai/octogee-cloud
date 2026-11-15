import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required for S3 blob erasure`);
  return value;
}

export function createS3UserBlobErasure(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.BLOB_STORE_BACKEND !== "s3") return undefined;
  const buckets = [
    required(environment, "BLOB_S3_BUCKET"),
    required(environment, "BLOB_S3_WORKSPACE_BUCKET"),
  ];
  const client = new S3Client({
    endpoint: required(environment, "BLOB_S3_ENDPOINT"),
    region: environment.AWS_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: required(environment, "AWS_ACCESS_KEY_ID"),
      secretAccessKey: required(environment, "AWS_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
  });

  function prefixes(uid: string, slug: string): string[] {
    if (!/^[A-Za-z0-9_-]+$/u.test(uid) || (slug && !/^[a-z0-9-]+$/u.test(slug))) {
      throw new Error("invalid user scope for S3 blob erasure");
    }
    return [`agent-imports/${uid}/`, ...(slug ? [`customers/${slug}/`] : [])];
  }

  async function list(Bucket: string, Prefix: string, MaxKeys?: number) {
    const page = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix, MaxKeys }));
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map(({ Key, VersionId }) => {
      if (!Key?.startsWith(Prefix) || !VersionId) throw new Error("invalid S3 erasure target");
      return { Key, VersionId };
    });
    if (!objects.length && page.IsTruncated) throw new Error("truncated S3 erasure listing contained no targets");
    return objects;
  }

  return {
    async erase(uid: string, slug: string): Promise<void> {
      for (const Prefix of prefixes(uid, slug)) {
        for (const Bucket of buckets) {
          for (;;) {
            const Objects = await list(Bucket, Prefix);
            if (!Objects.length) break;
            const result = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }));
            if (result.Errors?.length) throw new Error(`S3 erasure could not remove ${result.Errors.length} object versions`);
          }
        }
      }
    },
    async remaining(uid: string, slug: string): Promise<string[]> {
      const result: string[] = [];
      for (const Prefix of prefixes(uid, slug)) {
        for (const Bucket of buckets) {
          const [object] = await list(Bucket, Prefix, 1);
          if (object) result.push(`s3/${Bucket}/${object.Key}`);
        }
      }
      return result;
    },
  };
}
