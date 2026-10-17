# Deploy your own private Site

[English](DEPLOYMENT.en.md) | [繁體中文](DEPLOYMENT.md)

**Run Colab notebooks in ChatGPT using your own Colab compute credits**, through a backend and private plugin that belong to you.

## Requirements

- An account with access to private ChatGPT Sites and the Sites plugin. Availability can vary by account.
- Your own Google Cloud project, OAuth Web client, and Google account with access to Colab.
- Node.js 22.13+, npm, and uv/Python 3.12 for complete local validation.

The backend trusts identity headers supplied by Sites after authentication. Do not deploy it directly as an open Worker with `wrangler deploy`; those headers would not provide the same access boundary.

## 1. Obtain and check a release

Clone the repository and select a tagged release, for example `git switch --detach v0.2.0`. The public template must not contain an existing Site ID, OAuth secret, or user data.

```sh
npm ci
npm ci --prefix ui
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements-test.txt
npm run build:ui
npm run check
```

## 2. Create a separate private Site

Ask an agent with Sites tools to read the installed Sites skill and use this repository as a **retained template**. Use a new, empty deployment directory and the skill's `project-setup.mjs --template-source <absolute-sanitized-source-directory>` helper. Supply only tracked source files; exclude `.git`, `.env`, `.venv`, `node_modules`, `dist`, `.wrangler`, and `.sites-runtime`.

Create the Site with the native `create_site` tool and retain the returned project ID and URL. Confirm with `get_site` that you are the owner and sole allowed viewer, with no additional users or groups. If the account lacks the required capabilities, stop instead of making the Site public.

Pass source-repository credentials only through the official helper's hidden stdin. Never put them in chat, shell arguments, Git, or documentation.

## 3. Configure deployment identifiers

In the deployment checkout, use the actual values returned for your new Site:

```sh
npm run configure -- --site-url https://YOUR-SITE.chatgpt.site --project-id appgprj_YOUR_PROJECT_ID
```

This updates `lib/platform/deployment.ts` and `.openai/hosting.json` and prints the Google redirect URI. It does not handle secrets. It refuses to overwrite a different existing Site; investigate mismatched identifiers instead of removing that check.

Keep `d1: "DB"`, `r2: "BUCKET"`, and `capabilities: ["mcp"]`. Apply tracked `drizzle/*.sql` migrations through the current Sites storage workflow. Do not delete existing tables or recreate a database during upgrades.

## 4. Configure Google OAuth and Site secrets

Follow the [OAuth guide](OAUTH.en.md), then set these values in your own Site Settings or the native secrets interface:

| Name | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Your Google Web client ID |
| `GOOGLE_CLIENT_SECRET` | The same client's secret |
| `TOKEN_ENCRYPTION_KEY` | Base64 encoding of 32 random bytes |
| `OWNER_PRIVATE_DEPLOYMENT_CONFIRMED` | The string `true`, only after verifying owner-only Site access |

Generate an encryption key in your own terminal with `openssl rand -base64 32` and enter it directly into the secrets interface. Do not paste it into an agent conversation. Replacing it prevents existing refresh tokens from being decrypted and requires reauthorization. `.env.example` documents names only; it does not upload local values to Sites.

The private-confirmation setting records your access check. It does not itself make a public Site private. Without it, this public template refuses owner enrollment and protected operations.

## 5. Build and publish privately

Follow the installed Sites skill to synchronize source to **your new Site's source repository**, run outstanding checks, build with the official helper, and package the result. Use `save_version_and_deploy_private` for the confirmed owner-private Site, or the corresponding current workflow.

Retain the deployment version and URL. Preserve the same project ID, secrets, D1 database, R2 storage, and audience during upgrades. Never reuse credentials from another Site.

## 6. Authorize Google and connect your private plugin

1. Open your new Site as its owner. Follow its Google authorization link and authorize your own OAuth client in the browser.
2. Publishing a Site with the `mcp` capability provisions a private App/plugin for its owner. This connects to your individual backend.
3. If tools are missing, ask the agent to call `get_site(include_mcp_connection: true)` and use the returned plugin ID with Plugin Management to show the install/connect UI. You may also find it under Plugins → Personal → Created by you; labels can change.
4. Do not create a public directory listing or embed bearer tokens in MCP headers to complete this private setup.

## 7. Validate and release compute

Start with the panel and runtime-settings tools, which do not allocate compute. After Google authorization, read the balance and eligible hardware. Eligibility does not guarantee an allocation will succeed.

The interface supports English and Traditional Chinese. It uses the first supported language in your browser preferences on the first visit, falling back to English. Change it from the language selector on the home page or editor toolbar. A saved choice takes priority; if browser storage is blocked, the choice lasts for the current panel session.

Only after you authorize compute usage: open one CPU runtime, run `print(1 + 2)`, export the notebook, verify the downloaded file, and close the runtime. Verify release independently. A manual Shift + Enter run should show **Run by you** (「由你執行」), while an assistant tool call should show **Run by ChatGPT** (「由 ChatGPT 執行」). Historical attribution is not rewritten.

Unattended idle cleanup requires a separate Sites recurring update. Follow the current Sites skill for a private service-access `POST /api/maintenance` with JSON body `{}`, at least hourly. Never include its credentials in a schedule prompt. This is not an exact shutdown deadline; without a schedule, close runtimes manually.

Before uninstalling the plugin, revoking OAuth, or deleting the Site, release its runtimes and back up required notebooks and artifacts. Do not stop runtimes belonging to other work.
