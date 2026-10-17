/** Deployment constants, never credentials. */
export { SITE_ORIGIN } from "./deployment.ts";
import { SITE_ORIGIN } from "./deployment.ts";
export const CALLBACK_URL = `${SITE_ORIGIN}/oauth/google/callback`;

export const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/colaboratory",
] as const;

export const STATE_TTL_MS = 10 * 60 * 1000;
export const HTTP_TIMEOUT_MS = 20_000;
export const CLEANUP_STEP_TIMEOUT_MS = 5_000;

export interface SpikeEnv {
  OWNER_PRIVATE_DEPLOYMENT_CONFIRMED?: string;
  DB?: D1Database;
  BUCKET?: R2Bucket;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
}

export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type Identity = { userId: string; email: string };
