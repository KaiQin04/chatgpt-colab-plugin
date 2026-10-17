# chatgpt-colab-plugin

**Run Colab notebooks in ChatGPT using your own Colab compute credits.**

[English](README.md) | [繁體中文](README.zh-TW.md)

Write, edit, and run Python notebooks from your ChatGPT conversation. Execution happens on **your Google Colab runtime**, using the resources and compute credits available to **your own Colab account**. Edit cells yourself, press **Shift + Enter**, or ask ChatGPT to work with the notebook.

Each user deploys a separate private backend, connects their own Google account through OAuth, and installs their own private plugin. You do not share the maintainer's Site, credentials, or compute credits.

> Unofficial, experimental integration. Not affiliated with Google or OpenAI. This repository is a self-deployment template, not a plugin already listed in the public directory.

## What you can do

- Run Python on your Colab CPU or an eligible GPU from ChatGPT.
- Edit code and Markdown cells, execute with Shift + Enter, and inspect outputs.
- Ask ChatGPT to create, edit, and run cells through MCP tools.
- Import attachments, export `.ipynb` notebooks, and download generated artifacts.
- Sign in to Google with OAuth—no manual access-token or refresh-token copying.

**Bring your own Colab account and compute credits.** This project does not provide extra credits, guarantee GPU availability, or transfer your Colab subscription to OpenAI. Available hardware, usage limits, and charges remain subject to your Colab account and Google's policies.

```text
Your ChatGPT / Codex
        |
Your private Site + MCP + D1 + R2
        |
Your Google OAuth client -> Your Google account -> Your Colab runtime
```

## Get started

The initial deployment target is an **owner-private ChatGPT Site**. You need access to Sites and its plugin, your own Google Cloud project for OAuth, and a Colab account. Sites hosts your individual backend; this is not a generic VPS or Cloudflare Workers deployment.

1. Clone this repository and choose a release.
2. Follow the [deployment guide](docs/DEPLOYMENT.en.md) to create your own private Site.
3. Follow the [Google OAuth guide](docs/OAUTH.en.md) and authorize your account in your browser.
4. Install or connect the private plugin that Sites creates for your deployment.

You can ask an agent with Sites access to guide you:

> Read this repository's AGENTS.md, docs/DEPLOYMENT.en.md, docs/OAUTH.en.md, and skills/setup/SKILL.md. Deploy it to a new ChatGPT Site that only I can access, help me configure my own Google OAuth client, and connect my private plugin. I will enter credentials in the settings UI, not in chat. Start with checks that do not allocate a Colab runtime.

Setup requires your participation in Google account authorization. A public directory installation does not automatically deploy a private backend for you. The notebook UI currently uses Traditional Chinese; the README and setup guides are available in English and Traditional Chinese.

## Local development

Requires Node.js 22.13+, npm, and uv for the Python test environment.

```sh
git clone https://github.com/KaiQin04/chatgpt-colab-plugin.git
cd chatgpt-colab-plugin
npm ci
npm ci --prefix ui
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements-test.txt
npm run build:ui
npm run check
npm run build
```

`npm run dev:ui` starts a localhost preview with synthetic data. It does not connect to Google or consume Colab credits. Python harnesses use `.venv/bin/python`, or the interpreter specified by `NOTEBOOK_TEST_PYTHON`. Missing Python can cause skipped tests; that is not a complete validation pass.

## Releases and upgrades

The maintainer develops features in a private source repository and publishes reviewed, sanitized versions here. This public repository does not include private Git history, deployment settings, credentials, or user data. “Stable release” describes the release workflow; it does not promise stability of Colab's unversioned endpoints.

Publishing a release does **not** update anyone's deployed Site. For upgrades, open your existing Site source through the Sites workflow, apply the selected release, and preserve your own `.openai/hosting.json`, `lib/platform/deployment.ts`, secrets, database, and storage. Review migrations, run checks, and deploy to the same private Site. Back up required notebooks and artifacts first. There is no automatic updater.

Agents should read [AGENTS.md](AGENTS.md). Detailed maintainer release instructions are in [docs/RELEASING.md](docs/RELEASING.md) (Traditional Chinese).

## Limits and validation

This integration uses unversioned Colab endpoints that may change. A successful OAuth flow is not approval from Google for a third-party integration. Read the [OAuth and Colab limitations](docs/OAUTH.en.md#limits-and-review) before deploying. Keep your Site private to yourself; do not offer other people access to your credentials or Colab runtime.

Stop runtimes when finished and verify that they have been released. Closing the browser, uninstalling the plugin, or revoking OAuth does not itself stop a runtime.

The current release passed 105 application tests, 2 deployment-configuration tests, type checking, and a production build. Manual Shift + Enter attribution was verified on the maintainer's existing private Site. A complete deployment and OAuth flow using a fresh third-party account has **not** yet been verified. See [validation details](docs/VALIDATION.en.md), including the embedded-panel execution limitation.

Google secrets stay in your Site settings; encrypted refresh tokens and notebook records are stored in your D1 database, and saved artifacts in your R2 bucket. Code and imported files go to Colab; tool outputs may also enter your ChatGPT conversation. Google and OpenAI still process data. Do not upload credentials or data you are not authorized to share. See [SECURITY.md](SECURITY.md) for reporting guidance (Traditional Chinese).

## License

[MIT](LICENSE). Original third-party licenses are retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). ChatGPT, OpenAI, Google, and Colab names describe compatible services and do not imply endorsement.
