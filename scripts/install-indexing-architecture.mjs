import { readFile, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const installerPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(installerPath);
const payloads = [
  [".build-indexing-hubs.mjs.gz.b64", "build-indexing-hubs.mjs"],
  [".validate-indexing.mjs.gz.b64", "validate-indexing.mjs"]
];

for (const [payloadName, outputName] of payloads) {
  const payloadPath = resolve(scriptDirectory, payloadName);
  const outputPath = resolve(scriptDirectory, outputName);
  const encoded = await readFile(payloadPath, "utf8");
  const source = gunzipSync(Buffer.from(encoded.trim(), "base64"));
  await writeFile(outputPath, source);
  await rm(payloadPath);
  console.log(`Installed ${outputName}`);
}

await rm(installerPath);
console.log("Removed temporary indexing installer and payloads.");
