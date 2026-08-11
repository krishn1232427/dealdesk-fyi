import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const feedPaths = ["data/best-deals.json", "data/streaming-deals.json"];
const now = Date.now();
const apply = process.argv.includes("--apply");
const explicitDryRun = process.argv.includes("--dry-run");
if (apply && explicitDryRun) throw new Error("Choose either --apply or --dry-run, not both");
const dryRun = !apply;

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
    deadlinePassed(deal.expiresAt));

  if (!removed.length) {
    console.log(`${relativePath}: no hard-expired active deals`);
    continue;
  }

  feed.deals = feed.deals.filter((deal) => !removed.includes(deal));
  feed.updatedAt = new Date(now).toISOString();
  if (!dryRun) await writeFile(path, `${JSON.stringify(feed, null, 2)}\n`);

  const byNetwork = Object.entries(removed.reduce((counts, deal) => {
    const network = deal.network || "unknown";
    counts[network] = (counts[network] || 0) + 1;
    return counts;
  }, {})).map(([network, count]) => `${network}: ${count}`).join(", ");
  console.log(`${relativePath}: ${dryRun ? "would remove" : "removed"} ${removed.length} hard-expired active deals (${byNetwork})`);
}
