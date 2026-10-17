/** D1 statements are schema-only migrations plus bounded, owner-scoped queries. */
import type { Identity, SpikeEnv } from "./config.ts";
import { SpikeError } from "./security.ts";

export interface Grant {
  owner_id: string;
  google_subject: string;
  masked_email: string;
  encrypted_refresh_token: string;
}

export class Store {
  readonly db: D1Database;
  constructor(readonly env: SpikeEnv) {
    if (!env.DB) throw new SpikeError("d1_binding_missing", "configuration", 503);
    this.db = env.DB;
  }

  async owner(identity: Identity): Promise<void> {
    if (this.env.OWNER_PRIVATE_DEPLOYMENT_CONFIRMED !== "true") {
      throw new SpikeError("private_deployment_not_confirmed", "identity", 503);
    }
    // Race-safe first pin. The platform's owner-private policy is the prerequisite.
    await this.db.prepare(
      "INSERT OR IGNORE INTO site_owner (singleton, owner_id) VALUES (1, ?)",
    ).bind(identity.userId).run();
    const owner = await this.db.prepare(
      "SELECT owner_id FROM site_owner WHERE singleton = 1",
    ).first<{ owner_id: string }>();
    if (owner?.owner_id !== identity.userId) {
      throw new SpikeError("owner_required", "identity", 403);
    }
  }

  async saveState(hash: string, ownerId: string, verifier: string,
    nonce: string, redirectUri: string, expiresAt: number): Promise<void> {
    await this.db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?")
      .bind(Date.now()).run();
    await this.db.prepare(
      `INSERT INTO oauth_states
       (state_hash, owner_id, code_verifier, nonce, redirect_uri, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(hash, ownerId, verifier, nonce, redirectUri, expiresAt).run();
  }

  async consumeState(hash: string, ownerId: string, now: number): Promise<{
    code_verifier: string; nonce: string; redirect_uri: string;
  }> {
    // DELETE RETURNING makes simultaneous callbacks single-use, not check-then-delete.
    const row = await this.db.prepare(
      `DELETE FROM oauth_states WHERE state_hash = ? AND owner_id = ?
       AND expires_at > ? RETURNING code_verifier, nonce, redirect_uri`,
    ).bind(hash, ownerId, now).first<{
      code_verifier: string; nonce: string; redirect_uri: string;
    }>();
    if (!row) throw new SpikeError("state_invalid_expired_or_used", "oauth", 400);
    return row;
  }

  async saveGrant(grant: Grant): Promise<void> {
    await this.db.prepare(
      `INSERT INTO google_grants
       (owner_id, google_subject, masked_email, encrypted_refresh_token, updated_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET
       google_subject = excluded.google_subject,
       masked_email = excluded.masked_email,
       encrypted_refresh_token = excluded.encrypted_refresh_token,
       updated_at = excluded.updated_at`,
    ).bind(grant.owner_id, grant.google_subject, grant.masked_email,
      grant.encrypted_refresh_token, Date.now()).run();
  }

  async grant(ownerId: string): Promise<Grant> {
    const row = await this.db.prepare(
      `SELECT owner_id, google_subject, masked_email, encrypted_refresh_token
       FROM google_grants WHERE owner_id = ?`,
    ).bind(ownerId).first<Grant>();
    if (!row) throw new SpikeError("google_authorization_required", "oauth", 409);
    return row;
  }

  async saveStatus(ownerId: string, value: Record<string, unknown>): Promise<void> {
    await this.db.prepare(
      `INSERT INTO latest_status (owner_id, result_json) VALUES (?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET result_json = excluded.result_json`,
    ).bind(ownerId, JSON.stringify(value)).run();
  }

  async latestStatus(ownerId: string): Promise<Record<string, unknown> | null> {
    const row = await this.db.prepare(
      "SELECT result_json FROM latest_status WHERE owner_id = ?",
    ).bind(ownerId).first<{ result_json: string }>();
    return row ? JSON.parse(row.result_json) : null;
  }
}
