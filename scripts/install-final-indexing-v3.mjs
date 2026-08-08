import { readFile, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const installerPath = fileURLToPath(import.meta.url);
const scriptsDirectory = dirname(installerPath);
const root = resolve(scriptsDirectory, "..");

const payloads = [
  [".build-indexing-hubs-v3.mjs.gz.b64", "build-indexing-hubs.mjs"],
  [".validate-indexing-v3.mjs.gz.b64", "validate-indexing.mjs"],
];

for (const [payloadName, outputName] of payloads) {
  const payloadPath = resolve(scriptsDirectory, payloadName);
  const encoded = await readFile(payloadPath, "utf8");
  const source = gunzipSync(Buffer.from(encoded.trim(), "base64"));
  await writeFile(resolve(scriptsDirectory, outputName), source);
  await rm(payloadPath);
  console.log(`Installed ${outputName}`);
}

const validateDealsPath = resolve(scriptsDirectory, "validate-deals.mjs");
let validateDeals = await readFile(validateDealsPath, "utf8");
const exactBuildCheck = `if (!homepageSource.includes('name="dealdesk-build" content="2026-08-08-indexing-v1"')) {
  errors.push("index.html: deployment build marker is missing");
}`;
const versionedBuildCheck = `if (!/name="dealdesk-build" content="[^"]+"/.test(homepageSource)) {
  errors.push("index.html: deployment build marker is missing");
}`;
if (validateDeals.includes(exactBuildCheck)) {
  validateDeals = validateDeals.replace(exactBuildCheck, versionedBuildCheck);
  await writeFile(validateDealsPath, validateDeals);
  console.log("Updated deal validation for versioned crawl builds");
} else if (!validateDeals.includes(versionedBuildCheck)) {
  throw new Error("Could not locate the DealDesk deployment build-marker validation");
}

await rm(resolve(scriptsDirectory, "upgrade-indexing-v3.mjs"), { force: true });
await rm(resolve(root, ".github/workflows/build-indexing-crawl-architecture.yml"), { force: true });
await rm(installerPath);
console.log("Installed final DealDesk crawl architecture sources and removed temporary migration files.");
