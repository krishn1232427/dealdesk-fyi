import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [, , convertedPath] = process.argv;
if (!convertedPath) {
  throw new Error("Usage: node scripts/import-ebay-epn.mjs <converted EPN file>");
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(root, "data/ebay-deal-manifest.json");
const feedPath = resolve(root, "data/best-deals.json");
const registryPath = resolve(root, "data/affiliate-programs.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const feed = JSON.parse(await readFile(feedPath, "utf8"));
const registry = JSON.parse(await readFile(registryPath, "utf8"));
const converted = await readFile(resolve(convertedPath), "utf8");
const allowedTrackingHosts = new Set(["rover.ebay.com", "ebay.us", "www.ebay.com"]);

const lines = converted.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const urlsBySource = new Map();

for (const line of lines) {
  const urls = line.match(/https:\/\/[^,\s"']+/g) || [];
  const source = urls.find((url) => manifest.deals.some((deal) => deal.merchantURL === url));
  const affiliate = urls.find((url) => {
    try {
      const parsed = new URL(url);
      return allowedTrackingHosts.has(parsed.hostname) && url !== source &&
        (parsed.hostname !== "www.ebay.com" || parsed.searchParams.has("campid"));
    } catch {
      return false;
    }
  });
  if (source && affiliate) urlsBySource.set(source, affiliate);
}

const missing = manifest.deals.filter((deal) => !urlsBySource.has(deal.merchantURL));
if (missing.length) {
  throw new Error(`EPN conversion missing verified tracking links for: ${missing.map((deal) => deal.id).join(", ")}`);
}

const program = (registry.programs || []).find((item) => item.id === "ebay-partner-network-default");
if (!program || program.applicationStatus !== "active" || program.commissionEligible !== true || program.publicPublishingAllowed !== true) {
  throw new Error("The approved eBay Partner Network program is not active in affiliate-programs.json");
}

const imported = manifest.deals.map((deal, index) => ({
  ...deal,
  url: urlsBySource.get(deal.merchantURL),
  affiliateURL: urlsBySource.get(deal.merchantURL),
  network: "ebay-partner-network",
  trackingID: manifest.campaign,
  approvalStatus: "approved",
  commissionEligible: true,
  commission: "1%-4% of qualifying transaction value by category",
  merchantName: "eBay",
  status: "active",
  publishedAt: manifest.verifiedAt,
  verifiedAt: manifest.verifiedAt,
  priority: index + 1
}));

const importedIDs = new Set(imported.map((deal) => deal.id));
feed.deals = [...imported, ...(feed.deals || []).filter((deal) => !importedIDs.has(deal.id))];
feed.updatedAt = manifest.verifiedAt;
await writeFile(feedPath, `${JSON.stringify(feed, null, 2)}\n`);
console.log(`Imported ${imported.length} verified eBay Partner Network deals.`);
