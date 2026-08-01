import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourcePath = resolve(root, "data/ebay-events-2026-08-01.json");
const feedPath = resolve(root, "data/best-deals.json");
const registryPath = resolve(root, "data/affiliate-programs.json");
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const feed = JSON.parse(await readFile(feedPath, "utf8"));
const registry = JSON.parse(await readFile(registryPath, "utf8"));
const program = (registry.programs || []).find((item) => item.id === "ebay-partner-network-default");
const now = new Date(source.extractedAt).getTime();

if (!program || program.applicationStatus !== "active" || program.commissionEligible !== true ||
    program.publicPublishingAllowed !== true) {
  throw new Error("The approved eBay Partner Network program is not active");
}

if (JSON.stringify(program.trackingParameters) !== JSON.stringify(source.trackingParameters)) {
  throw new Error("The extracted eBay event tracking parameters do not match the approved registry values");
}

const isPromotion = (deal) => deal.sourceType === "ebay-promotion" ||
  /^https:\/\/www\.ebay\.com\/e\//.test(deal.merchantURL || "");
const existingEbay = (feed.deals || []).filter((deal) =>
  deal.network === "ebay-partner-network" && isPromotion(deal));
const existingByURL = new Map(existingEbay.map((deal) => [deal.merchantURL, deal]));
const preservedDeals = (feed.deals || []).filter((deal) =>
  deal.network !== "ebay-partner-network" || !isPromotion(deal));
const existingIDs = new Set((feed.deals || []).map((deal) => deal.id));
const trackingEntries = Object.entries(source.trackingParameters || {});
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const expiryISO = (value) => {
  const match = String(value).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}T23:59:59Z`;
};
const offerText = (event) => `${event.title} ${event.description}`.trim();
const discountFrom = (event) => Number(offerText(event).match(/(\d+)%\s+off/i)?.[1] || 0);
const displayPrice = (event) => {
  const text = offerText(event);
  const discount = discountFrom(event);
  if (discount) return /up to\s+\d+%\s+off/i.test(text) ? `Up to ${discount}% off` : `${discount}% off`;
  const fromPrice = text.match(/from\s+(\$[\d,.]+)/i)?.[1];
  return fromPrice ? `From ${fromPrice}` : "See live offer";
};
const category = (value) => ({
  "B&I": "Business & industrial",
  "Home-Garden": "Home & garden",
  "Home & Garden": "Home & garden",
  "Sports Fan": "Sports collectibles",
  "Toys & Hobby": "Toys & hobbies"
}[value] || value || "Marketplace");
const sentence = (value) => {
  const text = String(value || "").trim();
  return text && !/[.!?]$/.test(text) ? `${text}.` : text;
};

const candidates = (source.events || []).filter((event) => {
  const expiry = new Date(expiryISO(event.expiry)).getTime();
  const suspiciousEndedCopy = /\bends\s+\d{1,2}\/\d{1,2}\b/i.test(event.description || "");
  return event.url?.startsWith("https://www.ebay.com/e/") && expiry > now &&
    !suspiciousEndedCopy;
});

const imported = candidates.map((event, index) => {
  const existing = existingByURL.get(event.url);
  const destination = new URL(event.url);
  for (const [key, value] of trackingEntries) destination.searchParams.set(key, value);
  const pathTail = event.url.split("/").filter(Boolean).at(-1);
  let id = existing?.id || `ebay-${slug(pathTail)}-20260801`;
  if (existingIDs.has(id)) id = `${id}-${index + 1}`;
  if (existing?.id) id = existing.id;
  existingIDs.add(id);
  const discount = discountFrom(event);
  const currentPrice = displayPrice(event);
  const recheckAfter = new Date(now + 7 * 86_400_000).toISOString();

  return {
    id,
    title: event.title,
    url: destination.href,
    affiliateURL: destination.href,
    network: "ebay-partner-network",
    trackingID: program.campaignName,
    approvalStatus: "approved",
    commissionEligible: true,
    commission: program.commission,
    merchantURL: event.url,
    merchantName: "eBay",
    sourceType: "ebay-promotion",
    category: category(event.category),
    ...(discount ? { badgeText: currentPrice, discountPercent: discount, savingsText: currentPrice } : {}),
    currentPrice,
    priceNote: event.description || "Confirm eligibility, condition, seller, price, and availability on eBay",
    summary: `${sentence(event.title)}${event.description ? ` ${sentence(event.description)}` : ""} This eBay promotion was active when checked; eligible inventory, prices, condition, sellers, warranties, and availability can vary by listing.`,
    status: "active",
    publishedAt: source.extractedAt,
    verifiedAt: source.extractedAt,
    expiresAt: expiryISO(event.expiry),
    recheckAfter,
    rankingScore: discount ? Math.min(90, 45 + discount / 2) : 45,
    rankingReason: discount ? `${currentPrice} in an active eBay promotion` : "Active eBay promotion with approved EPN tracking",
    priority: index + 11
  };
});

const importedURLs = new Set(imported.map((deal) => deal.merchantURL));
const removed = existingEbay.filter((deal) => !importedURLs.has(deal.merchantURL));
const created = imported.filter((deal) => !existingByURL.has(deal.merchantURL));
feed.deals = [...preservedDeals, ...imported];
feed.updatedAt = source.extractedAt;
await writeFile(feedPath, `${JSON.stringify(feed, null, 2)}\n`);
console.log(`Refreshed ${imported.length} verified eBay events (${created.length} new, ${removed.length} removed).`);
