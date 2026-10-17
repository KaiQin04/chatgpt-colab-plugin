declare namespace Cloudflare {
  interface Env {
    OWNER_PRIVATE_DEPLOYMENT_CONFIRMED?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    TOKEN_ENCRYPTION_KEY?: string;
  }
}
