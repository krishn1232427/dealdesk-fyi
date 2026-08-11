import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const replace = args.includes("--replace");
const existingOnly = args.includes("--existing-only");
const allowLargeChange = args.includes("--allow-large-change");
const positional = args.filter((arg) => !arg.startsWith("--"));
if (positional.length < 2) {
  throw new Error("Usage: node scripts/import-ebay-products.mjs <fresh-products.json> <events.json> [--dry-run] [--existing-only] [--replace] [--allow-large-change]");
}
if (allowLargeChange && !replace) throw new Error("--allow-large-change is valid only with --replace");
if (existingOnly && replace) throw new Error("--existing-only cannot be combined with --replace");
const sourcePath = resolve(root, positional[0]);
const eventsPath = resolve(root, positional[1]);
const feedPath = resolve(root, "data/best-deals.json");
const registryPath = resolve(root, "data/affiliate-programs.json");
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const eventsSource = JSON.parse(await readFile(eventsPath, "utf8"));
const feed = JSON.parse(await readFile(feedPath, "utf8"));
const registry = JSON.parse(await readFile(registryPath, "utf8"));
const program = (registry.programs || []).find((item) => item.id === "ebay-partner-network-default");
const eventExpiryByURL = new Map((eventsSource.events || []).map((event) => [event.url, event.expiry]));
const capturedAt = new Date(source.capturedAt);
const eventsExtractedAt = new Date(eventsSource.extractedAt);
const sourceRelativePath = relative(root, sourcePath).replaceAll("\\", "/");
const evidenceRecord = sourceRelativePath.startsWith("../") ? "" : sourceRelativePath;

if (!Number.isFinite(capturedAt.getTime())) throw new Error("Product capture timestamp is invalid");
if (capturedAt.getTime() > Date.now() + 5 * 60 * 1000) {
  throw new Error("Product capture timestamp is in the future");
}
if (Date.now() - capturedAt.getTime() > 3 * 60 * 60 * 1000) {
  throw new Error("Product capture is too old to import; perform a fresh eBay recheck");
}
if (!Number.isFinite(eventsExtractedAt.getTime())) throw new Error("Event capture timestamp is invalid");
if (eventsExtractedAt.getTime() > Date.now() + 5 * 60 * 1000) throw new Error("Event capture timestamp is in the future");
if (replace && Date.now() - eventsExtractedAt.getTime() > 3 * 60 * 60 * 1000) {
  throw new Error("Event capture is too old to pair with the product capture");
}
if (replace && eventsExtractedAt.getTime() > capturedAt.getTime() + 5 * 60 * 1000) {
  throw new Error("Event capture must precede the product capture");
}
if (!Array.isArray(source.records) || !source.records.length) {
  throw new Error("Product capture contains no records");
}
if (!evidenceRecord) {
  throw new Error("Fresh product evidence must be stored inside the DealDesk repository before import");
}
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
const usedIDs = new Set((feed.deals || []).map((deal) => deal.id));
const previousEventURLs = new Set(existingProducts.map((deal) => deal.sourcePromotionURL).filter(Boolean));
const capturedEventURLs = new Set((source.capturedEventURLs || source.records.map((record) => record.eventURL)).filter(Boolean));
const missingEventURLs = [...previousEventURLs].filter((url) => !capturedEventURLs.has(url));
if (!capturedEventURLs.size) throw new Error("Product capture does not identify any promotion pages");
const unknownEventURLs = [...capturedEventURLs].filter((url) => !eventExpiryByURL.has(url));
if (unknownEventURLs.length) {
  throw new Error(`Product capture references ${unknownEventURLs.length} promotion pages that are absent from the event source`);
}
if (replace && !allowLargeChange && missingEventURLs.length) {
  throw new Error(`Product capture is incomplete; it is missing ${missingEventURLs.length} previously represented promotion pages. Rerun with --allow-large-change only after confirming those pages ended.`);
}
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
const auctionPattern = /\b\d+\s+bids?\b/i;
const merchantImage = (value) => {
  try {
    const image = new URL(String(value || ""));
    return image.protocol === "https:" && image.hostname === "i.ebayimg.com" ? image.href : "";
  } catch {
    return "";
  }
};

const candidates = [];
const seenURLs = new Set();
const seenVisuals = new Set();
for (const record of source.records || []) {
  let merchant;
  try { merchant = cleanURL(record.merchantURL); } catch { merchant = null; }
  if (!merchant || seenURLs.has(merchant.href)) continue;
  const lines = String(record.rawText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = lines[0];
  const isAuction = lines.some((line) => auctionPattern.test(line));
  const prices = lines.filter((line) => money.test(line));
  const current = prices[0];
  const currentValue = dollars(current);
  const expiresAt = expiryISO(record.expiresAt || eventExpiryByURL.get(record.eventURL));
  const imageURL = merchantImage(record.imageURL);
  const visualSignature = `${String(title || "").toLowerCase()}|${current || ""}|${imageURL}`;
  if (!title || title.length < 5 || isAuction || !Number.isFinite(currentValue) || currentValue <= 0 ||
      !imageURL || !expiresAt || new Date(expiresAt) <= capturedAt || seenVisuals.has(visualSignature)) continue;
  seenURLs.add(merchant.href);
  seenVisuals.add(visualSignature);
  candidates.push({ record, merchant, lines, title, prices, current, currentValue, expiresAt, imageURL });
}

const recheckAfter = new Date(capturedAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
const importCandidates = existingOnly ? candidates.filter(({ merchant }) => existingByURL.has(merchant.href)) : candidates;
const imported = importCandidates.map(({ record, merchant, lines, title, prices, current, currentValue, expiresAt, imageURL }, index) => {
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
    listingFormat: "FixedPrice",
    verificationScope: "promotion-card-observation",
    sourcePromotionURL: record.eventURL,
    imageURL,
    category: category(record.eventCategory),
    badgeText: discountPercent ? `${discountPercent}% off` : "Live eBay price",
    currentPrice: current,
    ...(original ? { originalPrice: original, discountPercent, savingsText: `Save $${(originalValue - currentValue).toFixed(2)}` } : {}),
    priceNote: details || "Confirm condition, shipping, seller, and availability on eBay",
    summary: `${title} was listed for ${current}${original ? `, reduced from ${original}` : ""} inside eBay’s active “${eventClaim}” promotion when checked. Price, variant, condition, seller, shipping, warranty, and availability can change; confirm the exact item on eBay.`,
    status: "active",
    verificationSource: source.source,
    evidenceRecord,
    publishedAt: existing?.publishedAt || source.capturedAt,
    verifiedAt: source.capturedAt,
    recheckAfter,
    rankingScore: discountPercent ? Math.min(95, 55 + discountPercent / 2) : 52,
    rankingReason: discountPercent ? `${discountPercent}% item-level saving in an active eBay promotion` : "Current item price in an active eBay promotion",
    priority: existing?.priority || index + 200
  };
});

const importedURLs = new Set(imported.map((deal) => deal.merchantURL));
const unobserved = existingProducts.filter((deal) => !importedURLs.has(deal.merchantURL));
const removed = replace ? unobserved : [];
const created = imported.filter((deal) => !existingByURL.has(deal.merchantURL));
const minimumCount = Math.max(1, Math.floor(existingProducts.length * 0.75));
if (replace && !allowLargeChange && existingProducts.length &&
    (imported.length < minimumCount || removed.length > Math.ceil(existingProducts.length * 0.25))) {
  throw new Error(`Fresh product capture would replace ${existingProducts.length} products with ${imported.length} and remove ${removed.length}; review the capture and rerun with --allow-large-change only after confirming the change`);
}
const importedByURL = new Map(imported.map((deal) => [deal.merchantURL, deal]));
const preserveWithoutUnsupportedAvailability = (deal) => {
  const {
    availabilityStatus: _unsupportedAvailability,
    expiresAt: _unsupportedItemPriceDeadline,
    ...preserved
  } = deal;
  return {
    ...preserved,
    verificationScope: preserved.verificationScope || "promotion-card-observation"
  };
};
const mergedProducts = replace ? imported : [
  ...existingProducts.map((deal) => importedByURL.get(deal.merchantURL) || preserveWithoutUnsupportedAvailability(deal)),
  ...created
];
feed.deals = [...preservedDeals, ...mergedProducts];
feed.updatedAt = source.capturedAt;
if (!dryRun) await writeFile(feedPath, `${JSON.stringify(feed, null, 2)}\n`);
console.log(`${dryRun ? "Validated" : "Refreshed"} ${imported.length} observed eBay products (${created.length} new, ${removed.length} removed, ${replace ? 0 : unobserved.length} unobserved records preserved on their prior verification window across ${capturedEventURLs.size} captured promotion pages${existingOnly ? "; new rotating cards ignored" : ""}).`);
