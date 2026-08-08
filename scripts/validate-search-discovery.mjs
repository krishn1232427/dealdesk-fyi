import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const site = "https://dealdesk.fyi";
const host = "dealdesk.fyi";
const buildID = "2026-08-08-discovery-v1";
const key = "3abe3f91462ad860ed2d45214f0053977e539dd55cccf396dd8bcec9d4a7ab36";
const errors = [];

const read = (path) => readFile(resolve(root, path), "utf8");
const [latest, authority, manifest, dealFeed, merchantFeed] = await Promise.all([
  read("data/latest-deals.json").then(JSON.parse),
  read("data/seo-authority-report.json").then(JSON.parse),
  read("data/indexnow-urls.json").then(JSON.parse),
  read("feeds/deals.v1.json").then(JSON.parse),
  read("feeds/merchants.v1.json").then(JSON.parse),
]);
const deals = Array.isArray(latest.deals) ? latest.deals : [];
if (!deals.length) errors.push("latest-deals.json: public catalog is empty");

const keyFile = (await read(`${key}.txt`)).trim();
if (keyFile !== key) errors.push("IndexNow key file does not contain the exact key");
if (manifest.build !== buildID) errors.push("indexnow-urls.json: build id mismatch");
if (manifest.host !== host) errors.push("indexnow-urls.json: host mismatch");
if (manifest.key !== key) errors.push("indexnow-urls.json: key mismatch");
if (manifest.keyLocation !== `${site}/${key}.txt`) errors.push("indexnow-urls.json: keyLocation mismatch");
if (!Array.isArray(manifest.urlList) || manifest.total !== manifest.urlList.length) errors.push("indexnow-urls.json: total does not match URL list");
if (new Set(manifest.urlList || []).size !== (manifest.urlList || []).length) errors.push("indexnow-urls.json: URL list contains duplicates");
if ((manifest.urlList || []).some((url) => !url.startsWith(`${site}/`))) errors.push("indexnow-urls.json: contains a non-DealDesk URL");
for (const deal of deals) {
  const url = `${site}${deal.url}`;
  if (!manifest.urlList.includes(url)) errors.push(`indexnow-urls.json: missing deal ${deal.id}`);
}
for (const path of [...(authority.merchantPaths || []), ...(authority.comparisonPaths || []), ...(authority.staticPaths || [])]) {
  if (!manifest.urlList.includes(`${site}${path}`)) errors.push(`indexnow-urls.json: missing authority URL ${path}`);
}

if (dealFeed.version !== 1 || dealFeed.total !== deals.length || dealFeed.deals.length !== deals.length) {
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
if (feedIDs.size !== deals.length) errors.push("deals.v1.json: not every public deal is represented");

if (merchantFeed.version !== 1 || merchantFeed.canonical !== `${site}/feeds/merchants.v1.json`) {
  errors.push("merchants.v1.json: metadata mismatch");
}
if (!Array.isArray(merchantFeed.merchants) || merchantFeed.total !== merchantFeed.merchants.length) {
  errors.push("merchants.v1.json: total mismatch");
}
const merchantOfferTotal = (merchantFeed.merchants || []).reduce((sum, merchant) => sum + Number(merchant.offer_count || 0), 0);
if (merchantOfferTotal !== deals.length) errors.push("merchants.v1.json: merchant offer counts do not cover the catalog");
for (const merchant of merchantFeed.merchants || []) {
  if (!merchant.canonical_url?.startsWith(`${site}/merchant/`)) errors.push(`merchants.v1.json:${merchant.name}: invalid canonical URL`);
  if (!merchant.newest_check) errors.push(`merchants.v1.json:${merchant.name}: missing newest check date`);
}

const rss = await read("feed.xml");
if (!rss.includes('<rss version="2.0"')) errors.push("feed.xml: RSS root is missing");
if (!rss.includes(`${site}/feed.xml`)) errors.push("feed.xml: self link is missing");
const rssItems = (rss.match(/<item>/g) || []).length;
if (rssItems !== Math.min(100, deals.length)) errors.push(`feed.xml: expected ${Math.min(100, deals.length)} items, found ${rssItems}`);
if (!rss.includes(`${site}${deals[0].url}`)) errors.push("feed.xml: top deal is missing");

const feedPage = await read("feeds/index.html");
if (!feedPage.includes('content="index,follow')) errors.push("feeds/index.html: missing index,follow");
if (!feedPage.includes(`rel="canonical" href="${site}/feeds/"`)) errors.push("feeds/index.html: canonical mismatch");
if (!feedPage.includes('"@type":"DataCatalog"')) errors.push("feeds/index.html: DataCatalog structured data is missing");
for (const path of ["/feeds/deals.v1.json", "/feeds/merchants.v1.json", "/feed.xml"]) {
  if (!feedPage.includes(`href="${path}"`)) errors.push(`feeds/index.html: missing ${path}`);
}

const llms = await read("llms.txt");
for (const required of [`# DealDesk`, `${site}/feeds/deals.v1.json`, `${site}/sitemap.xml`, "verification date", "merchant checkout"]) {
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
console.log(`Validated multi-engine discovery for ${deals.length} deals, ${merchantFeed.total} merchants, ${rssItems} RSS items, and ${manifest.total} IndexNow URLs.`);
