/** SQLite-backed D1 test adapter and wholly synthetic credential fixtures. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCOPES, SITE_ORIGIN } from "../lib/platform/config.ts";
import type { Fetcher, SpikeEnv } from "../lib/platform/config.ts";
import { base64, base64url } from "../lib/platform/security.ts";
import { parseComputeInfo } from "../lib/colab/client.ts";

export function syntheticComputeStatus(overrides: Record<string, unknown> = {}) {
  return { ...parseComputeInfo({ currentBalance: 100, consumptionRateHourly: 0.08,
    assignmentsCount: 1, eligibleGpus: ["G4", "A100", "L4", "T4"], ...overrides }), assignmentCount: 1,
    assignmentEndpoints: ["synthetic-owned-endpoint"] };
}

export const OWNER = { userId: "synthetic-owner", email: "owner@example.test" };
export const OTHER = { userId: "synthetic-other", email: "other@example.test" };
export const ACCESS = "synthetic-access-token";
export const REFRESH = "synthetic-refresh-token";
export const PROXY = "synthetic-proxy-token";

class Statement {
  constructor(readonly sqlite: DatabaseSync, readonly sql: string,
    readonly values: unknown[] = []) {}
  bind(...values: unknown[]): Statement { return new Statement(this.sqlite, this.sql, values); }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...this.values as never[]);
    return row ? (column ? row[column] : { ...row }) as T : null;
  }
  async run(): Promise<unknown> {
    const outcome = this.sqlite.prepare(this.sql).run(...this.values as never[]);
    return { success: true, meta: { changes: Number(outcome.changes) } };
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.sqlite.prepare(this.sql).all(...this.values as never[])
      .map((row) => ({ ...row }) as T) };
  }
}

export function fixture(): { env: SpikeEnv; sqlite: DatabaseSync; close: () => void } {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(`${migrations}/${name}`, "utf8"));
  }
  let batchQueue: Promise<void> = Promise.resolve();
  const adapter = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    async batch(statements: Statement[]) {
      const previous = batchQueue;
      let release!: () => void;
      batchQueue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      finally { release(); }
    },
  };
  return {
    env: {
      OWNER_PRIVATE_DEPLOYMENT_CONFIRMED: "true",
      DB: adapter as unknown as D1Database,
      GOOGLE_CLIENT_ID: "synthetic-client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "synthetic-client-secret",
      TOKEN_ENCRYPTION_KEY: base64(new Uint8Array(32).fill(37)),
    },
    sqlite, close: () => sqlite.close(),
  };
}

export function ownerRequest(path: string, owner = OWNER): Request {
  return new Request(`${SITE_ORIGIN}${path}`, { headers: {
    "oai-authenticated-user-id": owner.userId,
    "oai-authenticated-user-email": owner.email,
  } });
}

export function jwt(env: SpikeEnv, nonce?: string, subject = "synthetic-google-subject"): string {
  return ["eyJhbGciOiJSUzI1NiJ9", base64url(new TextEncoder().encode(JSON.stringify({
    iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID,
    exp: Date.now() / 1000 + 3600, sub: subject, email: "google@example.test",
    email_verified: true, ...(nonce ? { nonce } : {}),
  }))), "synthetic-signature"].join(".");
}

export function tokenPayload(env: SpikeEnv, nonce?: string): Record<string, unknown> {
  return { access_token: ACCESS, refresh_token: REFRESH, token_type: "Bearer",
    expires_in: 3600, scope: SCOPES.join(" "), id_token: jwt(env, nonce) };
}

export function json(value: unknown, status = 200): Response {
  return new Response(")]}'\n" + JSON.stringify(value), {
    status, headers: { "Content-Type": "application/json" },
  });
}

export const noNetwork: Fetcher = async () => { throw new Error("unexpected_network_call"); };
