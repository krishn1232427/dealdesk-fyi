import { readFile, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const installerPath = fileURLToPath(import.meta.url);
const scriptsDirectory = dirname(installerPath);
const root = resolve(scriptsDirectory, "..");
const payloads = [
  [".build-seo-authority.mjs.gz.b64", "build-seo-authority.mjs"],
  [".validate-seo-authority.mjs.gz.b64", "validate-seo-authority.mjs"],
];

for (const [payloadName, outputName] of payloads) {
  const encoded = await readFile(resolve(scriptsDirectory, payloadName), "utf8");
  const source = gunzipSync(Buffer.from(encoded.trim(), "base64"));
  await writeFile(resolve(scriptsDirectory, outputName), source);
  await rm(resolve(scriptsDirectory, payloadName));
  console.log(`Installed ${outputName}`);
}

await rm(resolve(root, ".github/workflows/build-seo-authority.yml"), { force: true });
await rm(installerPath);
console.log("Installed final DealDesk SEO authority sources and removed temporary migration files.");
