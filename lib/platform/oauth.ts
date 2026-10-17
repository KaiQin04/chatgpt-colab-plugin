/** Minimal-scope Google Web OAuth, pinned to the private Site owner. */
import { CALLBACK_URL, SCOPES, SITE_ORIGIN, STATE_TTL_MS } from "./config.ts";
import type { Fetcher, Identity, SpikeEnv } from "./config.ts";
import {
  decryptToken, digest, encryptToken, enforceScopes, htmlEscape,
  maskEmail, randomValue, requireSecrets, safeError, SpikeError,
  unbase64, validateEncryptionKey,
} from "./security.ts";
import { oauthErrorCode, requestJson } from "./network.ts";
import { Store } from "./store.ts";
import { boundedStep, requireActive } from "./deadline.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

function checkOrigin(request: Request): void {
  if (new URL(request.url).origin !== SITE_ORIGIN) {
    throw new SpikeError("unexpected_site_origin", "oauth", 400);
  }
}

export async function oauthStart(
  request: Request, env: SpikeEnv, identity: Identity,
): Promise<Response> {
  checkOrigin(request);
  const config = requireSecrets(env);
  await validateEncryptionKey(config.encryptionKey);
  const store = new Store(env);
  await store.owner(identity);
  const state = randomValue();
  const verifier = randomValue(64);
  const nonce = randomValue();
  await store.saveState(await digest(state), identity.userId, verifier, nonce,
    CALLBACK_URL, Date.now() + STATE_TTL_MS);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: CALLBACK_URL,
    response_type: "code", scope: SCOPES.join(" "), state,
    code_challenge: await digest(verifier), code_challenge_method: "S256",
    access_type: "offline", prompt: "consent", nonce,
  }).toString();
  return new Response(null, { status: 302, headers: {
    Location: url.toString(), "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  } });
}

/** Only called on ID tokens received directly from Google's TLS token endpoint.
 * As in the Python reference, TLS server authentication substitutes signature
 * verification for this direct code-flow response (OIDC Core 3.1.3.7).
 */
export function directGoogleClaims(
  token: unknown, clientId: string, nonce?: string,
): { subject: string; email: string } {
  try {
    if (typeof token !== "string" || token.length > 32_768) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = unbase64(encoded + "=".repeat((4 - encoded.length % 4) % 4));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!["https://accounts.google.com", "accounts.google.com"].includes(claims.iss)
      || !audiences.includes(clientId)
      || (audiences.length > 1 && claims.azp !== clientId)
      || typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000
      || (nonce !== undefined && claims.nonce !== nonce)
      || typeof claims.sub !== "string" || !claims.sub
      || typeof claims.email !== "string" || !claims.email.includes("@")
      || claims.email_verified !== true) throw new Error();
    return { subject: claims.sub, email: claims.email };
  } catch {
    throw new SpikeError("invalid_google_id_token", "oauth");
  }
}

function requireToken(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value || value.length > 32_768) {
    throw new SpikeError(`missing_or_invalid_${key}`, "oauth");
  }
  return value;
}

async function tokenRequest(
  fetcher: Fetcher, form: Record<string, string>, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const payload = await requestJson(fetcher, TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  }, "google_token", { signal });
  enforceScopes(payload.scope);
  if (payload.token_type !== "Bearer") {
    throw new SpikeError("unexpected_token_type", "oauth");
  }
  requireToken(payload, "access_token");
  return payload;
}

export async function oauthCallback(
  request: Request, env: SpikeEnv, identity: Identity, fetcher: Fetcher = fetch,
): Promise<Response> {
  checkOrigin(request);
  const config = requireSecrets(env);
  const store = new Store(env);
  await store.owner(identity);
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  if (!state || state.length > 1024) throw new SpikeError("state_required", "oauth", 400);
  const saved = await store.consumeState(await digest(state), identity.userId, Date.now());
  if (saved.redirect_uri !== CALLBACK_URL) {
    throw new SpikeError("state_redirect_mismatch", "oauth", 400);
  }
  if (params.has("error")) {
    throw new SpikeError("google_authorization_denied", "oauth", 400,
      oauthErrorCode(params.get("error")));
  }
  const code = params.get("code");
  if (!code || code.length > 16_384) throw new SpikeError("authorization_code_required", "oauth", 400);
  const payload = await tokenRequest(fetcher, {
    grant_type: "authorization_code", code, code_verifier: saved.code_verifier,
    client_id: config.clientId, client_secret: config.clientSecret,
    redirect_uri: CALLBACK_URL,
  });
  const claims = directGoogleClaims(payload.id_token, config.clientId, saved.nonce);
  const refreshToken = requireToken(payload, "refresh_token");
  const maskedEmail = maskEmail(claims.email);
  await store.saveGrant({
    owner_id: identity.userId, google_subject: claims.subject,
    masked_email: maskedEmail,
    encrypted_refresh_token: await encryptToken(refreshToken,
      config.encryptionKey, identity.userId, claims.subject),
  });
  // No token, raw email, code, state, claim dump, or automatic Colab call here.
  return new Response(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Google 授權完成</title><body><main><h1>Google 授權完成</h1>
    <p>${htmlEscape(maskedEmail)}</p></main></body></html>`, { headers: PAGE_HEADERS });
}

export async function accessToken(
  env: SpikeEnv, ownerId: string, fetcher: Fetcher = fetch, signal?: AbortSignal,
  options: { storageTimeoutMs?: number } = {},
): Promise<string> {
  requireActive(signal, "google_token");
  const config = requireSecrets(env);
  const store = new Store(env);
  const grant = options.storageTimeoutMs === undefined
    ? await store.grant(ownerId)
    : await boundedStep("grantRead", options.storageTimeoutMs, signal,
      async () => store.grant(ownerId));
  const refresh = await decryptToken(grant.encrypted_refresh_token,
    config.encryptionKey, ownerId, grant.google_subject);
  requireActive(signal, "google_token");
  const payload = await tokenRequest(fetcher, {
    grant_type: "refresh_token", refresh_token: refresh,
    client_id: config.clientId, client_secret: config.clientSecret,
  }, signal);
  if (payload.id_token) {
    const claims = directGoogleClaims(payload.id_token, config.clientId);
    if (claims.subject !== grant.google_subject) {
      throw new SpikeError("google_subject_mismatch", "oauth");
    }
  }
  if (payload.refresh_token !== undefined) {
    requireActive(signal, "grantWrite");
    grant.encrypted_refresh_token = await encryptToken(
      requireToken(payload, "refresh_token"), config.encryptionKey,
      ownerId, grant.google_subject,
    );
    requireActive(signal, "grantWrite");
    if (options.storageTimeoutMs === undefined) await store.saveGrant(grant);
    else await boundedStep("grantWrite", options.storageTimeoutMs, signal,
      async () => store.saveGrant(grant));
  }
  return requireToken(payload, "access_token");
}

export function oauthFailure(error: unknown): Response {
  const safe = safeError(error);
  const status = error instanceof SpikeError && error.httpStatus && error.httpStatus < 600
    ? error.httpStatus : 500;
  return new Response(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
    <title>授權未完成</title><body><h1>授權未完成</h1>
    <pre>${htmlEscape(JSON.stringify(safe, null, 2))}</pre></body></html>`,
  { status, headers: PAGE_HEADERS });
}
