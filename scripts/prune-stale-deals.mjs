import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const feedPaths = ["data/best-deals.json", "data/streaming-deals.json"];
const now = Date.now();

const deadlinePassed = (value) => {
  if (!value) return false;
  const deadline = new Date(value).getTime();
  return Number.isFinite(deadline) && deadline < now;
};

for (const relativePath of feedPaths) {
  const path = resolve(root, relativePath);
  const feed = JSON.parse(await readFile(path, "utf8"));
  const removed = (feed.deals || []).filter((deal) =>
    deal.status === "active" &&
    (deadlinePassed(deal.expiresAt) || deadlinePassed(deal.recheckAfter)));

  if (!removed.length) {
    console.log(`${relativePath}: no stale active deals`);
    continue;
  }

  feed.deals = feed.deals.filter((deal) => !removed.includes(deal));
  feed.updatedAt = new Date(now).toISOString();
  await writeFile(path, `${JSON.stringify(feed, null, 2)}\n`);

  const byNetwork = Object.entries(removed.reduce((counts, deal) => {
    const network = deal.network || "unknown";
    counts[network] = (counts[network] || 0) + 1;
    return counts;
  }, {})).map(([network, count]) => `${network}: ${count}`).join(", ");
  console.log(`${relativePath}: removed ${removed.length} stale active deals (${byNetwork})`);
}
