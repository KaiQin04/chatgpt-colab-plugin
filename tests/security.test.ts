import assert from "node:assert/strict";
import { test } from "node:test";
import { SCOPES, CALLBACK_URL } from "../lib/platform/config.ts";
import { decryptToken, digest, dispatchIdentity, encryptToken, enforceScopes } from "../lib/platform/security.ts";
import { oauthCallback, oauthStart, accessToken } from "../lib/platform/oauth.ts";
import { Store } from "../lib/platform/store.ts";
import { fixture, OWNER, OTHER, ownerRequest, tokenPayload, REFRESH } from "./helpers.ts";

test("exact three scopes: aliases accepted, profile/Drive/cloud/unknown/missing refused", () => {
  enforceScopes(SCOPES.join(" "));
  enforceScopes(SCOPES.join(" ").replace(SCOPES[1], "email"));
  for (const extra of ["profile", "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/cloud-platform", "unknown"]) {
    assert.throws(() => enforceScopes(`${SCOPES.join(" ")} ${extra}`), /scope_set_mismatch/);
  }
  assert.throws(() => enforceScopes("openid email"), /scope_set_mismatch/);
  assert.throws(() => enforceScopes(undefined), /scope_set_missing/);
});

test("AES-GCM ciphertext is nondeterministic and bound to owner and Google subject", async () => {
  const f = fixture();
  try {
    const key = f.env.TOKEN_ENCRYPTION_KEY!;
    const first = await encryptToken(REFRESH, key, OWNER.userId, "subject");
    const second = await encryptToken(REFRESH, key, OWNER.userId, "subject");
    assert.notEqual(first, second);
    assert.ok(!first.includes(REFRESH));
    assert.equal(await decryptToken(first, key, OWNER.userId, "subject"), REFRESH);
    await assert.rejects(decryptToken(first, key, OTHER.userId, "subject"), /token_decryption_failed/);
    await assert.rejects(decryptToken(first, key, OWNER.userId, "other-subject"), /token_decryption_failed/);
    const envelope = JSON.parse(first);
    envelope.data = (envelope.data[0] === "A" ? "B" : "A") + envelope.data.slice(1);
    await assert.rejects(decryptToken(JSON.stringify(envelope), key, OWNER.userId, "subject"));
    await assert.rejects(encryptToken(REFRESH, "bad-key", OWNER.userId, "subject"), /invalid_TOKEN_ENCRYPTION_KEY/);
  } finally { f.close(); }
});

test("missing platform identity fails and owner singleton refuses another identity", async () => {
  const f = fixture();
  try {
    assert.throws(() => dispatchIdentity(new Headers({ "x-user-id": OWNER.userId })), /authenticated_identity_required/);
    const store = new Store(f.env);
    await store.owner(OWNER);
    await store.owner(OWNER);
    await assert.rejects(store.owner(OTHER), /owner_required/);
  } finally { f.close(); }
});

test("OAuth state is owner-bound, atomically single-use, and expires exactly at ten minutes", async () => {
  const f = fixture();
  try {
    const store = new Store(f.env);
    const now = Date.now();
    await store.saveState("hash", OWNER.userId, "verifier", "nonce", CALLBACK_URL, now + 600_000);
    await assert.rejects(store.consumeState("hash", OTHER.userId, now), /state_invalid/);
    const attempts = await Promise.allSettled([
      store.consumeState("hash", OWNER.userId, now),
      store.consumeState("hash", OWNER.userId, now),
    ]);
    assert.equal(attempts.filter((value) => value.status === "fulfilled").length, 1);
    await store.saveState("expired", OWNER.userId, "v", "n", CALLBACK_URL, now + 600_000);
    await assert.rejects(store.consumeState("expired", OWNER.userId, now + 600_000), /state_invalid/);
  } finally { f.close(); }
});

test("authorization redirect has exact scopes, fixed callback, offline consent and S256 PKCE", async () => {
  const f = fixture();
  try {
    const before = Date.now();
    const response = await oauthStart(ownerRequest("/oauth/google/start"), f.env, OWNER);
    const location = new URL(response.headers.get("Location")!);
    assert.equal(location.origin, "https://accounts.google.com");
    assert.equal(location.searchParams.get("scope"), SCOPES.join(" "));
    assert.equal(location.searchParams.get("redirect_uri"), CALLBACK_URL);
    assert.equal(location.searchParams.get("access_type"), "offline");
    assert.equal(location.searchParams.get("prompt"), "consent");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.ok(!location.toString().includes(f.env.GOOGLE_CLIENT_SECRET!));
    const row = f.sqlite.prepare("SELECT * FROM oauth_states").get()!;
    assert.equal(row.state_hash, await digest(location.searchParams.get("state")!));
    assert.equal(await digest(row.code_verifier as string), location.searchParams.get("code_challenge"));
    assert.ok((row.expires_at as number) >= before + 600_000);
    assert.ok((row.expires_at as number) <= Date.now() + 600_000);
    await assert.rejects(oauthStart(new Request("https://spoof.test/oauth/google/start"), f.env, OWNER), /unexpected_site_origin/);
  } finally { f.close(); }
});

async function flow(f: ReturnType<typeof fixture>) {
  const start = await oauthStart(ownerRequest("/oauth/google/start"), f.env, OWNER);
  const params = new URL(start.headers.get("Location")!).searchParams;
  const request = ownerRequest(`/oauth/google/callback?state=${params.get("state")}&code=synthetic-code`);
  return { request, nonce: params.get("nonce")! };
}

test("successful callback stores only encrypted refresh grant and returns masked email", async () => {
  const f = fixture();
  try {
    const { request, nonce } = await flow(f);
    const response = await oauthCallback(request, f.env, OWNER, async (_url, init) => {
      const form = new URLSearchParams(init!.body as string);
      assert.equal(form.get("redirect_uri"), CALLBACK_URL);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.ok(form.get("code_verifier"));
      return Response.json(tokenPayload(f.env, nonce));
    });
    const html = await response.text();
    assert.ok(!html.includes(REFRESH));
    assert.ok(!html.includes("google@example.test"));
    const grant = await new Store(f.env).grant(OWNER.userId);
    assert.ok(!JSON.stringify(grant).includes(REFRESH));
    assert.equal(await decryptToken(grant.encrypted_refresh_token,
      f.env.TOKEN_ENCRYPTION_KEY!, OWNER.userId, grant.google_subject), REFRESH);
    await assert.rejects(oauthCallback(request, f.env, OWNER), /state_invalid/);
  } finally { f.close(); }
});

test("wrong callback owner and scope mismatch cannot overwrite an existing grant", async () => {
  const f = fixture();
  try {
    const store = new Store(f.env);
    await store.owner(OWNER);
    await store.saveGrant({ owner_id: OWNER.userId, google_subject: "old-subject",
      masked_email: "m…@e…st", encrypted_refresh_token: "old-encrypted-value" });
    const before = await store.grant(OWNER.userId);
    const { request, nonce } = await flow(f);
    let calls = 0;
    const denied = async () => { calls++; return Response.json(tokenPayload(f.env, nonce)); };
    await assert.rejects(oauthCallback(request, f.env, OTHER, denied), /owner_required/);
    assert.equal(calls, 0);
    assert.deepEqual(await store.grant(OWNER.userId), before);
    await assert.rejects(oauthCallback(request, f.env, OWNER, async () => Response.json({
      ...tokenPayload(f.env, nonce), scope: `${SCOPES.join(" ")} profile`,
    })), /scope_set_mismatch/);
    assert.deepEqual(await store.grant(OWNER.userId), before);
    await assert.rejects(oauthCallback(request, f.env, OWNER, denied), /state_invalid/);
    assert.equal(calls, 0);
  } finally { f.close(); }
});

test("refresh refuses scope expansion before any Colab request", async () => {
  const f = fixture();
  try {
    const store = new Store(f.env);
    await store.owner(OWNER);
    await store.saveGrant({ owner_id: OWNER.userId, google_subject: "synthetic-google-subject",
      masked_email: "g…@e…st", encrypted_refresh_token: await encryptToken(REFRESH,
        f.env.TOKEN_ENCRYPTION_KEY!, OWNER.userId, "synthetic-google-subject") });
    let calls = 0;
    await assert.rejects(accessToken(f.env, OWNER.userId, async (url) => {
      calls++; assert.equal(String(url), "https://oauth2.googleapis.com/token");
      return Response.json({ ...tokenPayload(f.env), scope: "openid email" });
    }), /scope_set_mismatch/);
    assert.equal(calls, 1);
  } finally { f.close(); }
});
