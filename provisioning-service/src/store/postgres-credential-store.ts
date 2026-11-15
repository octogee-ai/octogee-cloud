import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ProvisioningCredential, ProvisioningCredentialName } from "@octogee/shared/types/provisioning-service";
import { LeaseLostError, type CredentialStore } from "../hosts/credential-store.js";
import type { Database } from "./database.js";

export class PostgresCredentialStore implements CredentialStore {
  constructor(private readonly db: Database, private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("credential key must be 32 bytes");
  }

  async read(uid: string, name: ProvisioningCredentialName): Promise<ProvisioningCredential | null> {
    const { rows } = await this.db.pool.query<{ ciphertext: Buffer; iv: Buffer; tag: Buffer; version: number }>(
      `SELECT ciphertext, iv, tag, version FROM ${this.db.table("credentials")} WHERE uid = $1 AND name = $2`, [uid, name]);
    const row = rows[0];
    if (!row) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.iv);
    decipher.setAAD(Buffer.from(`${uid}/${name}`));
    decipher.setAuthTag(row.tag);
    const value = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
    return { name, value, version: row.version };
  }

  async names(uid: string): Promise<ProvisioningCredentialName[]> {
    const { rows } = await this.db.pool.query<{ name: ProvisioningCredentialName }>(
      `SELECT name FROM ${this.db.table("credentials")} WHERE uid = $1 ORDER BY name`, [uid]);
    return rows.map((row) => row.name);
  }

  async write(uid: string, name: ProvisioningCredentialName, value: string, leaseToken: string): Promise<{ version: number }> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${uid}/${name}`));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const t = this.db.table;
    return this.db.write(async (client, bumpVersion) => {
      await client.query(`SELECT 1 FROM ${t("provisionings")} WHERE uid = $1 FOR UPDATE`, [uid]);
      const lease = await client.query(
        `SELECT 1 FROM ${t("provisioning_work")} WHERE uid = $1 AND lease_token = $2 AND state = 'running' FOR UPDATE`, [uid, leaseToken]);
      if (lease.rowCount === 0) throw new LeaseLostError(uid);
      const { rows } = await client.query<{ version: number }>(
        `INSERT INTO ${t("credentials")} (uid, name, ciphertext, iv, tag, version) VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (uid, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
           version = ${t("credentials")}.version + 1
         RETURNING version`, [uid, name, ciphertext, iv, tag]);
      const version = await bumpVersion(uid);
      await client.query(`UPDATE ${t("provisionings")} SET resource_version = $2 WHERE uid = $1`, [uid, version.toString()]);
      return { version: rows[0].version };
    });
  }
}
