import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => { throw new Error(message); };
const basisFor = (value) => {
  const current = String(value || "").toLowerCase();
  if (/(?:\/|\bper\s+)(?:mo|month)\b|\bmonthly\b/.test(current)) return "monthly";
  if (/(?:\/|\bper\s+)(?:yr|year)\b|\bannual(?:ly)?\b/.test(current)) return "annual";
  if (/^\s*(?:US)?\$\s*\d/i.test(current)) return "total";
  return "non-monetary";
};
const text = (value) => String(value || "").replace(/<[^>]*>/g, "").replaceAll("&amp;", "&").replaceAll("&quot;", '"').trim();

const [latestCatalog, authoritySource, historySource] = await Promise.all([
  readFile(resolve(root, "data", "latest-deals.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "scripts", "build-seo-authority.mjs"), "utf8"),
  readFile(resolve(root, "scripts", "build-price-history.mjs"), "utf8"),
]);

for (const marker of [
  "const priceBasisFor = (deal) =>",
  "const distinctiveComparisonTokens = (deal) =>",
  "shared >= 2 && similarity >= 0.34",
  "const comparisonRows = position",
  "using the same price basis",
]) {
  if (!authoritySource.includes(marker)) fail(`SEO authority source is missing integrity marker: ${marker}`);
}
if (authoritySource.includes("similarity >= 0.22")) fail("Loose comparison threshold is still present");
if (!historySource.includes("const lowObservation =") || !historySource.includes("metrics.lowObservation.currentPrice")) {
  fail("Price-history unit-preserving extrema are not installed");
}

const deals = Array.isArray(latestCatalog.deals) ? latestCatalog.deals : [];
if (!deals.length) fail("No public deals to validate");
let rankedPanels = 0;
let monthlyHistoryChecks = 0;

for (const deal of deals) {
  const file = resolve(root, String(deal.url || "").replace(/^\//, ""), "index.html");
  const html = await readFile(file, "utf8");
  const currentMatch = html.match(/<p class="deal-detail-price">\s*<strong>([\s\S]*?)<\/strong>/i);
  const currentPrice = text(currentMatch?.[1] || deal.currentPrice);
  const panel = html.match(/<section class="deal-comparison-panel"[\s\S]*?<\/section>/i)?.[0] || "";
  if (panel.includes("This offer ranks")) {
    rankedPanels += 1;
    if (!panel.includes("using the same price basis")) fail(`Ranked comparison lacks same-basis disclosure for ${deal.id}`);
    const comparedPrices = [...panel.matchAll(/<b>([\s\S]*?)<\/b>/gi)].map((match) => text(match[1]));
    const currentBasis = basisFor(currentPrice);
    if (currentBasis === "non-monetary") fail(`Non-monetary deal has a ranked price comparison: ${deal.id}`);
    for (const comparedPrice of comparedPrices) {
      if (basisFor(comparedPrice) !== currentBasis) {
        fail(`Mixed price bases in ranked comparison for ${deal.id}: ${currentPrice} vs ${comparedPrice}`);
      }
    }
  }

  if (basisFor(currentPrice) === "monthly") {
    monthlyHistoryChecks += 1;
    const historySection = html.match(/<!-- PRICE-HISTORY:START -->[\s\S]*?<!-- PRICE-HISTORY:END -->/i)?.[0] || "";
    const low = text(historySection.match(/<dt>Lowest observed<\/dt><dd>([\s\S]*?)<\/dd>/i)?.[1]);
    const high = text(historySection.match(/<dt>Highest observed<\/dt><dd>([\s\S]*?)<\/dd>/i)?.[1]);
    if (low && basisFor(low) !== "monthly") fail(`Lowest observed price lost its monthly unit for ${deal.id}`);
    if (high && basisFor(high) !== "monthly") fail(`Highest observed price lost its monthly unit for ${deal.id}`);
  }
}

if (!rankedPanels) fail("No ranked comparison panels were generated; integrity validation is not exercising the ranking path");
if (!monthlyHistoryChecks) fail("No monthly price-history pages were checked");
console.log(`Validated ${rankedPanels} same-basis ranked comparison panels and ${monthlyHistoryChecks} monthly price histories across ${deals.length} deals.`);
