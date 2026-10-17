# Connect your own Google account

[English](OAUTH.en.md) | [繁體中文](OAUTH.md)

OAuth obtains tokens through browser authorization. You do not manually copy access or refresh tokens. You do need your own **OAuth client ID and client secret**, which identify your deployment and are distinct from user authorization tokens.

## Setup

1. Create a separate project in Google Cloud Console and open Google Auth Platform.
2. In Branding, provide a name identifying your deployment, a support email, and developer contact information. Do not imply that it is an official Google or OpenAI service.
3. For personal testing, use External / Testing and add your Colab Google account to the test-user list. Workspace accounts may also be subject to administrator policies.
4. In Data Access, add only these scopes:

```text
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/colaboratory
```

5. Create a **Web application** client. Add the exact redirect URI printed by the configuration script:

```text
https://YOUR-SITE.chatgpt.site/oauth/google/callback
```

6. Enter the client ID and secret in your own Site Settings. This is a server-side OAuth flow; do not put the secret in browser JavaScript or commit credential JSON files.
7. Open the authorization link from your private Site. Check the application name, account, and scopes before consenting.

The Google Cloud OAuth project and your personal Colab compute credits are separate. This template does not require you to enable Colab Enterprise or Vertex AI billing.

## Testing-mode expiration

An External app in Testing generally receives refresh tokens that expire after seven days when its scopes extend beyond basic sign-in. This integration requests `colaboratory`, so it cannot assume the basic-sign-in exception. Reauthorize through your Site when needed. Revocation and account policies may invalidate tokens earlier. See [Google's token-expiration documentation](https://developers.google.com/identity/protocols/oauth2#expiration).

## Limits and review

Using your own OAuth client means you manage its configuration. It does not automatically exempt every deployment from verification or grant permission for a third-party Colab integration. Branding, scope verification, and potential security-review requirements depend on Google's current scope classification, publishing status, audience, and use case.

Before serving other users or moving to production, review Google's requirements for branding, privacy policies, domain ownership, and scopes. A shared `chatgpt.site` domain may create domain-verification limitations; successful production verification is not guaranteed. See [Google's OAuth production policies](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance).

This integration uses unversioned Colab endpoints such as `/tun/m/*`. It does not have a public third-party API stability guarantee. Recheck the official extension's [API v2 notes](https://github.com/googlecolab/colab-vscode/blob/main/src/colab/client/v2/README.md) when upgrading.

Colab's terms include restrictions on unauthorized access and providing direct or indirect access to third parties. **A working OAuth flow is not approval from Google for this integration.** Review the [Colab terms](https://research.google.com/colaboratory/tos_v6.html) and [FAQ](https://research.google.com/colaboratory/faq.html) for your use case. This project does not certify compliance, provide pooled accounts, or bypass access restrictions.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `redirect_uri_mismatch` | Web client type, exact HTTPS origin, and callback path |
| `access_denied` | Test-user membership and Workspace administrator restrictions |
| `invalid_grant` | Testing-mode expiry, revoked authorization, or mismatched client; investigate before reauthorizing |
| `private_deployment_not_confirmed` | Verify owner-only audience, then set the confirmation value |
| Token decryption fails | Whether `TOKEN_ENCRYPTION_KEY` changed; preserve data and reauthorize without printing tokens |

Never include authorization codes, access tokens, refresh tokens, client secrets, or encryption keys in issues, logs, screenshots, or agent conversations.
