/** Configure public deployment identifiers; never reads or writes credentials. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export function configure(root, { siteUrl, projectId }) {
  const url = new URL(siteUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".chatgpt.site") ||
      url.username || url.password || url.port || url.search || url.hash ||
      url.pathname !== "/") {
    throw new Error("Use the HTTPS origin of your own private ChatGPT Site.");
  }
  if (!/^appgprj_[a-zA-Z0-9_-]+$/.test(projectId ?? "")) {
    throw new Error("Use the project ID returned by Sites, starting with appgprj_.");
  }
  const manifestPath = resolve(root, ".openai/hosting.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.project_id && manifest.project_id !== projectId) {
    throw new Error("Existing Site ID differs. Use a fresh deployment checkout.");
  }
  const deploymentPath = resolve(root, "lib/platform/deployment.ts");
  const current = readFileSync(deploymentPath, "utf8");
  const previous = /export const SITE_ORIGIN = "([^"]+)";/.exec(current)?.[1];
  if (!previous) throw new Error("Unrecognized deployment configuration; inspect it manually.");
  if (previous !== "https://unconfigured.invalid" && previous !== url.origin) {
    throw new Error("Existing Site origin differs. Do not redirect an existing deployment.");
  }
  writeFileSync(deploymentPath,
    "/** Non-secret deployment origin. Set with npm run configure. */\n" +
    `export const SITE_ORIGIN = ${JSON.stringify(url.origin)};\n`);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, project_id: projectId }, null, 2) + "\n");
  return { origin: url.origin, callbackUrl: `${url.origin}/oauth/google/callback` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      "site-url": { type: "string" }, "project-id": { type: "string" },
    } });
    const result = configure(fileURLToPath(new URL("..", import.meta.url)), {
      siteUrl: values["site-url"], projectId: values["project-id"],
    });
    console.log(`Configured Site: ${result.origin}\nGoogle OAuth redirect URI: ${result.callbackUrl}`);
    console.log("After verifying owner-only Sites access, set OWNER_PRIVATE_DEPLOYMENT_CONFIRMED=true in Site Settings.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Configuration failed");
    process.exitCode = 1;
  }
}
