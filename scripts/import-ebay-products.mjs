import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourcePath = resolve(root, "data/ebay-products-2026-08-01.json");
const eventsPath = resolve(root, "data/ebay-events-2026-08-01.json");
const feedPath = resolve(root, "data/best-deals.json");
const registryPath = resolve(root, "data/affiliate-programs.json");
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const eventsSource = JSON.parse(await readFile(eventsPath, "utf8"));
const feed = JSON.parse(await readFile(feedPath, "utf8"));
const registry = JSON.parse(await readFile(registryPath, "utf8"));
const program = (registry.programs || []).find((item) => item.id === "ebay-partner-network-default");
const eventExpiryByURL = new Map((eventsSource.events || []).map((event) => [event.url, event.expiry]));
const capturedAt = new Date(source.capturedAt);

if (!Number.isFinite(capturedAt.getTime())) throw new Error("Product capture timestamp is invalid");
if (!program || program.applicationStatus !== "active" || program.commissionEligible !== true ||
    program.publicPublishingAllowed !== true) {
  throw new Error("The approved eBay Partner Network program is not active");
}
if (JSON.stringify(program.trackingParameters) !== JSON.stringify(source.trackingParameters)) {
  throw new Error("Captured product tracking parameters do not match the approved EPN values");
}

const isProduct = (deal) => deal.sourceType === "ebay-product" ||
  /^https:\/\/www\.ebay\.com\/itm\//.test(deal.merchantURL || "");
const existingProducts = (feed.deals || []).filter((deal) =>
  deal.network === "ebay-partner-network" && isProduct(deal));
const existingByURL = new Map(existingProducts.map((deal) => [deal.merchantURL, deal]));
const preservedDeals = (feed.deals || []).filter((deal) =>
  deal.network !== "ebay-partner-network" || !isProduct(deal));
const usedIDs = new Set(preservedDeals.map((deal) => deal.id));
const money = /^\$([\d,]+(?:\.\d{2})?)$/;
const category = (value) => ({
  "B&I": "Business & industrial",
  "Home-Garden": "Home & garden",
  "Home & Garden": "Home & garden",
  "Sports Fan": "Sports collectibles",
  "Toys & Hobby": "Toys & hobbies"
}[value] || value || "Marketplace");
const expiryISO = (value) => {
  const match = String(value).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T23:59:59Z` : "";
};
const dollars = (value) => Number(String(value).replace(/[$,]/g, ""));
const cleanURL = (value) => {
  const url = new URL(value);
  const item = url.pathname.match(/^\/itm\/(\d+)/)?.[1];
  if (!item || url.hostname !== "www.ebay.com") return null;
  const canonical = new URL(`https://www.ebay.com/itm/${item}`);
  if (url.searchParams.get("var")) canonical.searchParams.set("var", url.searchParams.get("var"));
  return canonical;
};
const conditionPattern = /^(New(?: other)?|Open box|Certified Refurbished|Excellent - Refurbished|Very Good - Refurbished|Good - Refurbished|Seller refurbished|Manufacturer refurbished|Refurbished|Used|Pre-owned)$/i;

const candidates = [];
const seenURLs = new Set();
for (const record of source.records || []) {
  let merchant;
  try { merchant = cleanURL(record.merchantURL); } catch { merchant = null; }
  if (!merchant || seenURLs.has(merchant.href)) continue;
  const lines = String(record.rawText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = lines[0];
  const prices = lines.filter((line) => money.test(line));
  const current = prices[0];
  const currentValue = dollars(current);
  const expiresAt = expiryISO(record.expiresAt || eventExpiryByURL.get(record.eventURL));
  if (!title || title.length < 5 || !Number.isFinite(currentValue) || currentValue <= 0 ||
      !expiresAt || new Date(expiresAt) <= capturedAt) continue;
  seenURLs.add(merchant.href);
  candidates.push({ record, merchant, lines, title, prices, current, currentValue, expiresAt });
}

const recheckAfter = new Date(capturedAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
const imported = candidates.map(({ record, merchant, lines, title, prices, current, currentValue, expiresAt }, index) => {
  const existing = existingByURL.get(merchant.href);
  const original = prices.slice(1).find((price) => dollars(price) > currentValue);
  const originalValue = original ? dollars(original) : 0;
  const discountPercent = originalValue ? Math.round((1 - currentValue / originalValue) * 100) : 0;
  const condition = lines.find((line) => conditionPattern.test(line));
  const shipping = lines.find((line) => /shipping|delivery|pickup/i.test(line));
  const itemID = merchant.pathname.split("/").at(-1);
  const variant = merchant.searchParams.get("var");
  let id = existing?.id || `ebay-item-${itemID}${variant ? `-${variant}` : ""}`;
  if (usedIDs.has(id) && existing?.id !== id) id = `${id}-${index + 1}`;
  usedIDs.add(id);
  const affiliate = new URL(merchant);
  for (const [key, value] of Object.entries(source.trackingParameters)) affiliate.searchParams.set(key, value);
  const details = [condition, shipping].filter(Boolean).join(" · ");
  const eventClaim = [record.eventTitle, record.eventDescription].filter(Boolean).join(" — ");

  return {
    id,
    title,
    url: affiliate.href,
    affiliateURL: affiliate.href,
    network: "ebay-partner-network",
    trackingID: program.campaignName,
    approvalStatus: "approved",
    commissionEligible: true,
    commission: program.commission,
    merchantURL: merchant.href,
    merchantName: "eBay",
    sourceType: "ebay-product",
    sourcePromotionURL: record.eventURL,
    category: category(record.eventCategory),
    badgeText: discountPercent ? `${discountPercent}% off` : "Live eBay price",
    currentPrice: current,
    ...(original ? { originalPrice: original, discountPercent, savingsText: `Save $${(originalValue - currentValue).toFixed(2)}` } : {}),
    priceNote: details || "Confirm condition, shipping, seller, and availability on eBay",
    summary: `${title} was listed for ${current}${original ? `, reduced from ${original}` : ""} inside eBay’s active “${eventClaim}” promotion when checked. Price, variant, condition, seller, shipping, warranty, and availability can change; confirm the exact item on eBay.`,
    status: "active",
    publishedAt: existing?.publishedAt || source.capturedAt,
    verifiedAt: source.capturedAt,
    expiresAt,
    recheckAfter,
    rankingScore: discountPercent ? Math.min(95, 55 + discountPercent / 2) : 52,
    rankingReason: discountPercent ? `${discountPercent}% item-level saving in an active eBay promotion` : "Current item price in an active eBay promotion",
    priority: index + 200
  };
});

const importedURLs = new Set(imported.map((deal) => deal.merchantURL));
const removed = existingProducts.filter((deal) => !importedURLs.has(deal.merchantURL));
const created = imported.filter((deal) => !existingByURL.has(deal.merchantURL));
feed.deals = [...preservedDeals, ...imported];
feed.updatedAt = source.capturedAt;
await writeFile(feedPath, `${JSON.stringify(feed, null, 2)}\n`);
console.log(`Refreshed ${imported.length} verified eBay products (${created.length} new, ${removed.length} removed).`);
