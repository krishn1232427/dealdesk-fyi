import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const endpoint = "https://api.indexnow.org/indexnow";
const manifest = JSON.parse(await readFile(resolve(root, "data/indexnow-urls.json"), "utf8"));
const urlList = Array.isArray(manifest.urlList) ? manifest.urlList : [];
if (!urlList.length) throw new Error("IndexNow manifest contains no URLs");
if (!manifest.host || !manifest.key || !manifest.keyLocation) throw new Error("IndexNow manifest is missing host, key, or keyLocation");

const chunks = Array.from({ length: Math.ceil(urlList.length / 10000) }, (_, index) =>
  urlList.slice(index * 10000, (index + 1) * 10000)
);
const wait = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

for (let index = 0; index < chunks.length; index += 1) {
  const payload = {
    host: manifest.host,
    key: manifest.key,
    keyLocation: manifest.keyLocation,
    urlList: chunks[index],
  };

  if (process.env.INDEXNOW_DRY_RUN === "true") {
    console.log(`IndexNow dry run: chunk ${index + 1}/${chunks.length}, ${chunks[index].length} URLs.`);
    continue;
  }

  let accepted = false;
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    lastStatus = response.status;
    lastBody = await response.text();
    if (response.status === 200 || response.status === 202) {
      accepted = true;
      console.log(`IndexNow accepted chunk ${index + 1}/${chunks.length}: ${chunks[index].length} URLs (${response.status}).`);
      break;
    }
    if (![429, 500, 502, 503, 504].includes(response.status)) break;
    await wait(attempt * 2000);
  }
  if (!accepted) {
    throw new Error(`IndexNow rejected chunk ${index + 1}/${chunks.length}: HTTP ${lastStatus} ${lastBody.slice(0, 500)}`);
  }
}
