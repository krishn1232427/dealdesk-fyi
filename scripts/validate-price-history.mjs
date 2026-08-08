import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => { throw new Error(message); };
const occurrences = (text, pattern) => (text.match(pattern) || []).length;

const [latestCatalog, history, indexHTML, sitemap, csv] = await Promise.all([
  readFile(resolve(root, "data", "latest-deals.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data", "price-history.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "price-history", "index.html"), "utf8"),
  readFile(resolve(root, "sitemap-authority.xml"), "utf8"),
  readFile(resolve(root, "data", "price-history.csv"), "utf8"),
]);

const currentDeals = Array.isArray(latestCatalog.deals) ? latestCatalog.deals : [];
if (!currentDeals.length) fail("No public deals to validate");
if (!history || history.version !== 1 || !history.deals || typeof history.deals !== "object") fail("Invalid price-history.json structure");

const activeRecords = Object.values(history.deals).filter((record) => record.active);
if (activeRecords.length !== currentDeals.length) fail(`Active history count ${activeRecords.length} does not match catalog count ${currentDeals.length}`);
if (!history.generatedAt) fail("Price history generatedAt is missing");

for (const deal of currentDeals) {
  const record = history.deals[deal.id];
  if (!record) fail(`Missing price history for ${deal.id}`);
  if (!record.active) fail(`Current deal is not active in price history: ${deal.id}`);
  if (record.url !== deal.url) fail(`Price history URL mismatch for ${deal.id}`);
  if (!Array.isArray(record.observations) || !record.observations.length) fail(`No price observations for ${deal.id}`);
  const dates = record.observations.map((observation) => observation.date);
  if (new Set(dates).size !== dates.length) fail(`Duplicate observation date for ${deal.id}`);
  if (record.observations.length > 104) fail(`Too many observations for ${deal.id}`);

  const file = resolve(root, String(deal.url || "").replace(/^\//, ""), "index.html");
  const html = await readFile(file, "utf8");
  if (occurrences(html, /<!-- PRICE-HISTORY:START -->/g) !== 1) fail(`Missing or duplicate price-history section for ${deal.id}`);
  if (occurrences(html, /\/assets\/price-history\.css/g) !== 1) fail(`Missing or duplicate price-history stylesheet for ${deal.id}`);
  if (occurrences(html, /<meta\b[^>]*\bname=["']description["'][^>]*>/gi) !== 1) fail(`Description metadata is not unique for ${deal.id}`);
  if (!html.includes('href="/price-history/"')) fail(`Deal page does not link to price-history hub: ${deal.id}`);
}

for (const required of [
  '<link rel="canonical" href="https://dealdesk.fyi/price-history/"',
  '"@type":"Dataset"',
  '/data/price-history.json',
  '/data/price-history.csv',
  'Original DealDesk data',
]) {
  if (!indexHTML.includes(required)) fail(`Price-history hub is missing ${required}`);
}
if (occurrences(indexHTML, /<meta\b[^>]*\bname=["']description["'][^>]*>/gi) !== 1) fail("Price-history hub description metadata is not unique");
if (occurrences(sitemap, /<loc>https:\/\/dealdesk\.fyi\/price-history\/<\/loc>/g) !== 1) fail("Price-history sitemap entry is missing or duplicated");
if (!csv.startsWith('"deal_id","title","url","merchant","category"')) fail("Price-history CSV header is invalid");
if (csv.trim().split("\n").length < currentDeals.length + 1) fail("Price-history CSV has fewer rows than active deals");

const home = await readFile(resolve(root, "index.html"), "utf8");
if (occurrences(home, /<meta\b[^>]*\bname=["']description["'][^>]*>/gi) !== 1) fail("Homepage description metadata is not unique");
if (occurrences(home, /<!-- PRICE-HISTORY-HOME:START -->/g) !== 1) fail("Homepage price-history discovery link is missing or duplicated");

console.log(`Validated price history for ${currentDeals.length} active deals and ${Object.values(history.deals).reduce((sum, record) => sum + record.observations.length, 0)} observations.`);
