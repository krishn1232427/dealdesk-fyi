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

await rm(resolve(scriptsDirectory, "upgrade-indexing-v3.mjs"), { force: true });
await rm(resolve(root, ".github/workflows/build-indexing-crawl-architecture.yml"), { force: true });
await rm(installerPath);
console.log("Installed final DealDesk crawl architecture sources and removed temporary migration files.");
