/** Small explicit error surface and Web Crypto primitives. */
import { SCOPES } from "./config.ts";
import type { Identity, SpikeEnv } from "./config.ts";

export class SpikeError extends Error {
  constructor(
    public readonly code: string,
    public readonly stage: string,
    public readonly httpStatus?: number,
    public readonly upstreamCode?: string,
  ) {
    super(`${stage}: ${code}`);
    this.name = "SpikeError";
  }
}

/** Never serialize arbitrary upstream exceptions, URLs, headers or bodies. */
export function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof SpikeError) {
    return {
      code: error.code,
      stage: error.stage,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.upstreamCode ? { upstreamCode: error.upstreamCode } : {}),
    };
  }
  return { code: "internal_error", stage: "site" };
}

/** These headers are trusted ONLY after the documented private Sites dispatch. */
export function dispatchIdentity(headers: Headers): Identity {
  const userId = headers.get("oai-authenticated-user-id");
  const email = headers.get("oai-authenticated-user-email");
  if (!userId || !email || userId.length > 512 || email.length > 512) {
    throw new SpikeError("authenticated_identity_required", "identity", 401);
  }
  return { userId, email };
}

export function mask(value: string): string {
  return value.length > 4 ? `${value.slice(0, 2)}…${value.slice(-2)}` : "…";
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "…";
  return `${email.slice(0, 1)}…@${mask(email.slice(at + 1))}`;
}

export function base64(bytes: Uint8Array): string {
  // Spread in bounded chunks: one spread of a large array overflows small stacks.
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    throw new SpikeError("invalid_encrypted_value", "encryption");
  }
}

export function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomValue(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function digest(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(value),
  )));
}

export function requireSecrets(env: SpikeEnv): {
  clientId: string; clientSecret: string; encryptionKey: string;
} {
  const required = [
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY",
  ] as const;
  for (const name of required) {
    if (!env[name]) throw new SpikeError(`missing_${name}`, "configuration", 503);
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID!,
    clientSecret: env.GOOGLE_CLIENT_SECRET!,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY!,
  };
}

async function encryptionKey(encoded: string): Promise<CryptoKey> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = unbase64(encoded);
  } catch {
    throw new SpikeError("invalid_TOKEN_ENCRYPTION_KEY", "configuration", 503);
  }
  if (bytes.length !== 32 || base64(bytes) !== encoded) {
    throw new SpikeError("invalid_TOKEN_ENCRYPTION_KEY", "configuration", 503);
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false,
    ["encrypt", "decrypt"]);
}

export async function validateEncryptionKey(encoded: string): Promise<void> {
  await encryptionKey(encoded);
}

export async function encryptToken(
  token: string, encodedKey: string, ownerId: string, subject: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(
    `colab-spike:refresh:v1:${ownerId}:${subject}`,
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    await encryptionKey(encodedKey), new TextEncoder().encode(token),
  );
  return JSON.stringify({ v: 1, iv: base64(iv), data: base64(new Uint8Array(ciphertext)) });
}

export async function decryptToken(
  envelope: string, encodedKey: string, ownerId: string, subject: string,
): Promise<string> {
  try {
    const parsed = JSON.parse(envelope);
    if (parsed.v !== 1 || typeof parsed.iv !== "string" ||
      typeof parsed.data !== "string") throw new Error();
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM", iv: unbase64(parsed.iv), tagLength: 128,
        additionalData: new TextEncoder().encode(
          `colab-spike:refresh:v1:${ownerId}:${subject}`,
        ),
      },
      await encryptionKey(encodedKey), unbase64(parsed.data),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch (error) {
    if (error instanceof SpikeError && error.stage === "configuration") throw error;
    throw new SpikeError("token_decryption_failed", "encryption");
  }
}

/** Google may canonicalize userinfo.email to its documented short alias. */
export function enforceScopes(raw: unknown): void {
  if (typeof raw !== "string") throw new SpikeError("scope_set_missing", "oauth");
  const actual = new Set(raw.trim().split(/\s+/).filter(Boolean).map(
    (scope) => scope === "email" ? SCOPES[1] : scope,
  ));
  if (actual.size !== SCOPES.length || SCOPES.some((scope) => !actual.has(scope))) {
    throw new SpikeError("scope_set_mismatch", "oauth");
  }
}

export function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}
