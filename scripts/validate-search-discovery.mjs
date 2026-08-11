import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const site = "https://dealdesk.fyi";
const host = "dealdesk.fyi";
const buildID = "2026-08-08-discovery-v1";
const key = "3abe3f91462ad860ed2d45214f0053977e539dd55cccf396dd8bcec9d4a7ab36";
const errors = [];
const slugify = (value) => String(value || "merchant").toLowerCase()
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "") || "merchant";

const read = (path) => readFile(resolve(root, path), "utf8");
const [latest, searchIndexPayload, authority, indexNowManifest, dealFeed, merchantFeed] = await Promise.all([
  read("data/latest-deals.json").then(JSON.parse),
  read("data/search-index.json").then(JSON.parse),
  read("data/seo-authority-report.json").then(JSON.parse),
  read("data/indexnow-urls.json").then(JSON.parse),
  read("feeds/deals.v1.json").then(JSON.parse),
  read("feeds/merchants.v1.json").then(JSON.parse),
]);
const deals = Array.isArray(latest.deals) ? latest.deals : [];
if (!deals.length) errors.push("latest-deals.json: public catalog is empty");
const searchIndexEntries = Array.isArray(searchIndexPayload.deals) ? searchIndexPayload.deals : [];
const searchIndexByID = new Map(searchIndexEntries.map((entry) => [entry.id, entry]));
if (searchIndexPayload.version !== 2 || searchIndexPayload.policy !== "quality-diversity-v2" ||
    searchIndexEntries.length !== deals.length || searchIndexByID.size !== deals.length) {
  errors.push("search-index.json: must contain exactly one quality-diversity-v2 record for every public deal");
}
for (const deal of deals) {
  const entry = searchIndexByID.get(deal.id);
  if (!entry || entry.url !== deal.url || typeof entry.indexable !== "boolean") {
    errors.push(`search-index.json:${deal.id}: missing or inconsistent state`);
  }
}
const indexableDeals = deals.filter((deal) => searchIndexByID.get(deal.id)?.indexable === true);
const browseOnlyDeals = deals.filter((deal) => searchIndexByID.get(deal.id)?.indexable === false);
if (Number(searchIndexPayload.indexableDeals) !== indexableDeals.length ||
    Number(searchIndexPayload.browseOnlyDeals) !== browseOnlyDeals.length) {
  errors.push("search-index.json: summary counts do not match the catalog");
}

const keyFile = (await read(`${key}.txt`)).trim();
if (keyFile !== key) errors.push("IndexNow key file does not contain the exact key");
if (indexNowManifest.build !== buildID) errors.push("indexnow-urls.json: build id mismatch");
if (indexNowManifest.host !== host) errors.push("indexnow-urls.json: host mismatch");
if (indexNowManifest.key !== key) errors.push("indexnow-urls.json: key mismatch");
if (indexNowManifest.keyLocation !== `${site}/${key}.txt`) errors.push("indexnow-urls.json: keyLocation mismatch");
if (Number(indexNowManifest.indexableDeals) !== indexableDeals.length) errors.push("indexnow-urls.json: indexable-deal count mismatch");
if (!Array.isArray(indexNowManifest.urlList) || indexNowManifest.total !== indexNowManifest.urlList.length) errors.push("indexnow-urls.json: total does not match URL list");
if (new Set(indexNowManifest.urlList || []).size !== (indexNowManifest.urlList || []).length) errors.push("indexnow-urls.json: URL list contains duplicates");
if ((indexNowManifest.urlList || []).some((url) => !url.startsWith(`${site}/`))) errors.push("indexnow-urls.json: contains a non-DealDesk URL");
for (const deal of indexableDeals) {
  const url = `${site}${deal.url}`;
  if (!indexNowManifest.urlList.includes(url)) errors.push(`indexnow-urls.json: missing deal ${deal.id}`);
}
for (const deal of browseOnlyDeals) {
  const url = `${site}${deal.url}`;
  if (indexNowManifest.urlList.includes(url)) errors.push(`indexnow-urls.json: browse-only deal must be excluded ${deal.id}`);
}
for (const url of indexNowManifest.urlList || []) {
  if (/https:\/\/dealdesk\.fyi\/(?:deals|category\/[^/]+)\/page\/\d+\/$/.test(url)) {
    errors.push(`indexnow-urls.json: noindex pagination URL must be excluded ${url}`);
  }
}
for (const path of [...(authority.merchantPaths || []), ...(authority.comparisonPaths || []), ...(authority.collectionPaths || []), ...(authority.staticPaths || [])]) {
  if (!indexNowManifest.urlList.includes(`${site}${path}`)) errors.push(`indexnow-urls.json: missing authority URL ${path}`);
}

if (dealFeed.version !== 1 || dealFeed.total !== indexableDeals.length || dealFeed.deals.length !== indexableDeals.length) {
  errors.push("deals.v1.json: count mismatch");
}
if (dealFeed.canonical !== `${site}/feeds/deals.v1.json`) errors.push("deals.v1.json: canonical mismatch");
const feedIDs = new Set();
for (const item of dealFeed.deals || []) {
  if (!item.id || feedIDs.has(item.id)) errors.push(`deals.v1.json: missing or duplicate id ${item.id || "unknown"}`);
  feedIDs.add(item.id);
  if (!item.canonical_url?.startsWith(`${site}/deals/`)) errors.push(`deals.v1.json:${item.id}: invalid canonical URL`);
  if (!item.verified_at) errors.push(`deals.v1.json:${item.id}: missing verification date`);
  for (const forbidden of ["affiliateURL", "affiliate_url", "trackingID", "tracking_id", "linkID", "link_id"]) {
    if (Object.hasOwn(item, forbidden)) errors.push(`deals.v1.json:${item.id}: public feed must not expose ${forbidden}`);
  }
}
const expectedFeedIDs = new Set(indexableDeals.map((deal) => deal.id));
if (feedIDs.size !== expectedFeedIDs.size || [...feedIDs].some((id) => !expectedFeedIDs.has(id))) {
  errors.push("deals.v1.json: feed must contain exactly the search-indexable deals");
}

if (merchantFeed.version !== 1 || merchantFeed.canonical !== `${site}/feeds/merchants.v1.json`) {
  errors.push("merchants.v1.json: metadata mismatch");
}
if (!Array.isArray(merchantFeed.merchants) || merchantFeed.total !== merchantFeed.merchants.length) {
  errors.push("merchants.v1.json: total mismatch");
}
const publishedMerchantBasePaths = (authority.merchantPaths || []).filter((path) => !/\/page\/\d+\/$/.test(path));
const expectedMerchantCounts = new Map();
for (const deal of indexableDeals) {
  const name = String(deal.merchant || "Merchant").trim();
  const path = `/merchant/${slugify(name)}/`;
  if (publishedMerchantBasePaths.includes(path)) expectedMerchantCounts.set(name, (expectedMerchantCounts.get(name) || 0) + 1);
}
if (merchantFeed.total !== expectedMerchantCounts.size) errors.push("merchants.v1.json: feed count does not match indexable merchant hubs");
const seenMerchantNames = new Set();
for (const merchant of merchantFeed.merchants || []) {
  if (!merchant.name || seenMerchantNames.has(merchant.name) || !expectedMerchantCounts.has(merchant.name)) {
    errors.push(`merchants.v1.json:${merchant.name || "unknown"}: missing, duplicate, or browse-only merchant`);
  }
  seenMerchantNames.add(merchant.name);
  if (!merchant.canonical_url?.startsWith(`${site}/merchant/`)) errors.push(`merchants.v1.json:${merchant.name}: invalid canonical URL`);
  if (!merchant.newest_check) errors.push(`merchants.v1.json:${merchant.name}: missing newest check date`);
  if (Number(merchant.offer_count) !== Number(expectedMerchantCounts.get(merchant.name))) errors.push(`merchants.v1.json:${merchant.name}: offer count does not match published hub`);
  const canonicalPath = new URL(merchant.canonical_url).pathname;
  if (!publishedMerchantBasePaths.includes(canonicalPath)) errors.push(`merchants.v1.json:${merchant.name}: canonical URL has no published merchant hub`);
  try {
    const merchantPage = await read(`${canonicalPath.replace(/^\//, "")}index.html`);
    if (!merchantPage.includes('content="index,follow') || !merchantPage.includes(`rel="canonical" href="${merchant.canonical_url}"`)) {
      errors.push(`merchants.v1.json:${merchant.name}: canonical merchant page is not indexable and self-canonical`);
    }
  } catch {
    errors.push(`merchants.v1.json:${merchant.name}: canonical merchant page is missing`);
  }
}

const rss = await read("feed.xml");
if (!rss.includes('<rss version="2.0"')) errors.push("feed.xml: RSS root is missing");
if (!rss.includes(`${site}/feed.xml`)) errors.push("feed.xml: self link is missing");
const rssItems = (rss.match(/<item>/g) || []).length;
if (rssItems !== Math.min(100, indexableDeals.length)) errors.push(`feed.xml: expected ${Math.min(100, indexableDeals.length)} items, found ${rssItems}`);
if (indexableDeals[0] && !rss.includes(`${site}${indexableDeals[0].url}`)) errors.push("feed.xml: top indexable deal is missing");
for (const deal of browseOnlyDeals) {
  if (rss.includes(`${site}${deal.url}`)) errors.push(`feed.xml: browse-only deal must be excluded ${deal.id}`);
}

const feedPage = await read("feeds/index.html");
if (!feedPage.includes('content="index,follow')) errors.push("feeds/index.html: missing index,follow");
if (!feedPage.includes(`rel="canonical" href="${site}/feeds/"`)) errors.push("feeds/index.html: canonical mismatch");
if (!feedPage.includes('"@type":"DataCatalog"')) errors.push("feeds/index.html: DataCatalog structured data is missing");
for (const path of ["/feeds/deals.v1.json", "/feeds/merchants.v1.json", "/feed.xml"]) {
  if (!feedPage.includes(`href="${path}"`)) errors.push(`feeds/index.html: missing ${path}`);
}

const llms = await read("llms.txt");
for (const required of [`# DealDesk`, `${site}/feeds/deals.v1.json`, `${site}/sitemap.xml`, "verification date", "Merchant checkout"]) {
  if (!llms.includes(required)) errors.push(`llms.txt: missing ${required}`);
}

for (const pagePath of ["index.html", "latest-deals/index.html"]) {
  const html = await read(pagePath);
  if (!html.includes('type="application/rss+xml"')) errors.push(`${pagePath}: RSS discovery link is missing`);
  if (!html.includes('href="/feeds/"')) errors.push(`${pagePath}: data-feed link is missing`);
}
const authoritySitemap = await read("sitemap-authority.xml");
if (!authoritySitemap.includes(`${site}/feeds/`)) errors.push("sitemap-authority.xml: feeds page is missing");

const submitter = await read("scripts/submit-indexnow.mjs");
for (const required of ["api.indexnow.org/indexnow", "data/indexnow-urls.json", "keyLocation", "urlList"]) {
  if (!submitter.includes(required)) errors.push(`submit-indexnow.mjs: missing ${required}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Validated multi-engine discovery for ${indexableDeals.length} indexable of ${deals.length} browseable deals, ${merchantFeed.total} merchants, ${rssItems} RSS items, and ${indexNowManifest.total} IndexNow URLs.`);
