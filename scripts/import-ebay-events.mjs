import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allowLargeChange = args.includes("--allow-large-change");
const sourceArg = args.find((arg) => !arg.startsWith("--"));
if (!sourceArg) {
  throw new Error("Usage: node scripts/import-ebay-events.mjs <fresh-events.json> [--dry-run] [--allow-large-change]");
}
const sourcePath = resolve(root, sourceArg);
const feedPath = resolve(root, "data/best-deals.json");
const registryPath = resolve(root, "data/affiliate-programs.json");
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const feed = JSON.parse(await readFile(feedPath, "utf8"));
const registry = JSON.parse(await readFile(registryPath, "utf8"));
const program = (registry.programs || []).find((item) => item.id === "ebay-partner-network-default");
const extractedAt = new Date(source.extractedAt);
const now = extractedAt.getTime();
const sourceRelativePath = relative(root, sourcePath).replaceAll("\\", "/");
const evidenceRecord = sourceRelativePath.startsWith("../") ? "" : sourceRelativePath;

if (!Number.isFinite(now)) throw new Error("Event capture timestamp is invalid");
if (now > Date.now() + 5 * 60 * 1000) throw new Error("Event capture timestamp is in the future");
if (Date.now() - now > 3 * 60 * 60 * 1000) {
  throw new Error("Event capture is too old to import; export a fresh EPN Sales + Events file");
}
if (!Array.isArray(source.events) || !source.events.length) {
  throw new Error("Event capture contains no events");
}
if (!evidenceRecord) {
  throw new Error("Fresh event evidence must be stored inside the DealDesk repository before import");
}

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
const eventURLs = new Set();
for (const [index, event] of source.events.entries()) {
  if (!event || typeof event !== "object" || !event.title || !event.url || !event.expiry) {
    throw new Error(`Event capture record ${index + 1} is missing title, URL, or expiry`);
  }
  let parsed;
  try { parsed = new URL(event.url); } catch { throw new Error(`Event capture record ${index + 1} has an invalid URL`); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.ebay.com" || !parsed.pathname.startsWith("/e/")) {
    throw new Error(`Event capture record ${index + 1} is not an eBay promotion URL`);
  }
  if (!expiryISO(event.expiry)) throw new Error(`Event capture record ${index + 1} has an invalid expiry`);
  if (eventURLs.has(event.url)) throw new Error(`Event capture contains duplicate URL ${event.url}`);
  eventURLs.add(event.url);
}
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

const statedEndHasPassed = (description) => {
  const match = String(description || "").match(/\bends\s+(\d{1,2})\/(\d{1,2})\b/i);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return true;
  let statedEnd = Date.UTC(extractedAt.getUTCFullYear(), month - 1, day, 23, 59, 59);
  if (now - statedEnd > 180 * 86_400_000) {
    statedEnd = Date.UTC(extractedAt.getUTCFullYear() + 1, month - 1, day, 23, 59, 59);
  }
  return statedEnd < now;
};

const candidates = (source.events || []).filter((event) => {
  const expiry = new Date(expiryISO(event.expiry)).getTime();
  const suspiciousEndedCopy = statedEndHasPassed(event.description);
  return event.url?.startsWith("https://www.ebay.com/e/") && expiry > now &&
    !suspiciousEndedCopy;
});

const candidateURLs = new Set(candidates.map((event) => event.url));
const preflightRemoved = existingEbay.filter((deal) => !candidateURLs.has(deal.merchantURL));
const minimumCount = Math.max(1, Math.floor(existingEbay.length * 0.75));
if (!allowLargeChange && existingEbay.length &&
    (candidates.length < minimumCount || preflightRemoved.length > Math.ceil(existingEbay.length * 0.25))) {
  throw new Error(`Fresh event capture would replace ${existingEbay.length} promotions with ${candidates.length} and remove ${preflightRemoved.length}; review the source and rerun with --allow-large-change only after confirming the change`);
}

const captureStamp = extractedAt.toISOString().slice(0, 10).replaceAll("-", "");

const imported = candidates.map((event, index) => {
  const existing = existingByURL.get(event.url);
  const destination = new URL(event.url);
  for (const [key, value] of trackingEntries) destination.searchParams.set(key, value);
  const pathTail = event.url.split("/").filter(Boolean).at(-1);
  let id = existing?.id || `ebay-${slug(pathTail)}-${captureStamp}`;
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
    publishedAt: existing?.publishedAt || source.extractedAt,
    verifiedAt: source.extractedAt,
    verificationSource: "Authenticated eBay Partner Network Sales and Events export",
    evidenceRecord,
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
if (!dryRun) await writeFile(feedPath, `${JSON.stringify(feed, null, 2)}\n`);
console.log(`${dryRun ? "Validated" : "Refreshed"} ${imported.length} verified eBay events (${created.length} new, ${removed.length} removed).`);
