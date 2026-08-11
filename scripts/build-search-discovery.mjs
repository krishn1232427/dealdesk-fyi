import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = "https://dealdesk.fyi";
const host = "dealdesk.fyi";
const buildID = "2026-08-08-discovery-v1";
const indexNowKey = "3abe3f91462ad860ed2d45214f0053977e539dd55cccf396dd8bcec9d4a7ab36";
const indexNowKeyPath = `${site}/${indexNowKey}.txt`;

const [latestCatalog, searchIndexPayload, authorityReport] = await Promise.all([
  readFile(resolve(root, "data/latest-deals.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/search-index.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/seo-authority-report.json"), "utf8").then(JSON.parse),
]);
const deals = Array.isArray(latestCatalog.deals) ? latestCatalog.deals : [];
if (!deals.length) throw new Error("data/latest-deals.json does not contain public deals");
const searchIndexEntries = Array.isArray(searchIndexPayload.deals) ? searchIndexPayload.deals : [];
const searchIndexByID = new Map(searchIndexEntries.map((entry) => [entry.id, entry]));
if (searchIndexPayload.version !== 1 || searchIndexPayload.policy !== "recheck-after-v1" ||
    searchIndexEntries.length !== deals.length || searchIndexByID.size !== deals.length) {
  throw new Error("data/search-index.json must contain exactly one record for every public deal");
}
for (const deal of deals) {
  const entry = searchIndexByID.get(deal.id);
  if (!entry || entry.url !== deal.url || typeof entry.indexable !== "boolean") {
    throw new Error(`data/search-index.json is inconsistent for ${deal.id}`);
  }
}
const indexableDeals = deals.filter((deal) => searchIndexByID.get(deal.id)?.indexable === true);

const updatedAt = new Date(latestCatalog.updatedAt || Date.now());
const updatedISO = Number.isNaN(updatedAt.getTime()) ? new Date().toISOString() : updatedAt.toISOString();
const updatedDate = updatedISO.slice(0, 10);

const escXML = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");
const escHTML = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const slugify = (value) => String(value || "merchant").toLowerCase()
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "") || "merchant";
const absolute = (path) => path.startsWith("http") ? path : `${site}${path.startsWith("/") ? path : `/${path}`}`;
const isoDate = (value) => {
  const date = new Date(value || updatedISO);
  return Number.isNaN(date.getTime()) ? updatedDate : date.toISOString().slice(0, 10);
};
const rssDate = (value) => {
  const date = new Date(value || updatedISO);
  return Number.isNaN(date.getTime()) ? new Date(updatedISO).toUTCString() : date.toUTCString();
};
const priceNumber = (value) => {
  const number = Number(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : null;
};

const rootFiles = await readdir(root);
const childSitemaps = rootFiles.filter((filename) => /^sitemap-(?:pages|deals-priority|deals-\d+|authority)\.xml$/.test(filename));
const discoveredURLs = new Set();
for (const filename of childSitemaps) {
  const xml = await readFile(resolve(root, filename), "utf8");
  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = match[1].replaceAll("&amp;", "&");
    try {
      const parsed = new URL(url);
      if (parsed.hostname === host && parsed.protocol === "https:") discoveredURLs.add(parsed.href);
    } catch {}
  }
}
for (const deal of indexableDeals) discoveredURLs.add(absolute(deal.url));
for (const path of [...(authorityReport.merchantPaths || []), ...(authorityReport.comparisonPaths || []), ...(authorityReport.collectionPaths || []), ...(authorityReport.staticPaths || [])]) {
  discoveredURLs.add(absolute(path));
}
discoveredURLs.add(`${site}/`);
discoveredURLs.add(`${site}/latest-deals/`);
discoveredURLs.add(`${site}/deals/`);
discoveredURLs.add(`${site}/categories/`);
discoveredURLs.add(`${site}/feeds/`);

const indexNowURLs = [...discoveredURLs].sort();
const indexNowManifest = {
  build: buildID,
  generatedAt: updatedISO,
  host,
  key: indexNowKey,
  keyLocation: indexNowKeyPath,
  indexableDeals: indexableDeals.length,
  total: indexNowURLs.length,
  urlList: indexNowURLs,
};
await writeFile(resolve(root, `${indexNowKey}.txt`), `${indexNowKey}\n`);
await writeFile(resolve(root, "data/indexnow-urls.json"), `${JSON.stringify(indexNowManifest, null, 2)}\n`);

const rssItems = indexableDeals.slice(0, 100).map((deal) => {
  const descriptionParts = [
    `${deal.currentPrice || "See current terms"}${deal.originalPrice ? ` compared with ${deal.originalPrice}` : ""}.`,
    deal.savingsText || deal.badgeText || "",
    deal.priceNote || "",
    `Merchant: ${deal.merchant || "Merchant"}.`,
    `Checked ${isoDate(deal.verifiedAt)}.`,
  ].filter(Boolean);
  return `    <item>\n      <title>${escXML(deal.title)}</title>\n      <link>${escXML(absolute(deal.url))}</link>\n      <guid isPermaLink="true">${escXML(absolute(deal.url))}</guid>\n      <pubDate>${escXML(rssDate(deal.verifiedAt))}</pubDate>\n      <category>${escXML(deal.categoryLabel || deal.category || "Deals")}</category>\n      <description>${escXML(descriptionParts.join(" "))}</description>\n    </item>`;
}).join("\n");
const rss = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>DealDesk verified deals</title>\n    <link>${site}/latest-deals/</link>\n    <description>Current DealDesk offers with displayed prices, savings, merchant, and verification date.</description>\n    <language>en-us</language>\n    <lastBuildDate>${escXML(rssDate(updatedISO))}</lastBuildDate>\n    <atom:link href="${site}/feed.xml" rel="self" type="application/rss+xml" />\n${rssItems}\n  </channel>\n</rss>\n`;
await writeFile(resolve(root, "feed.xml"), rss);

const publicDealFeed = {
  version: 1,
  generatedAt: updatedISO,
  canonical: `${site}/feeds/deals.v1.json`,
  total: indexableDeals.length,
  disclosure: "DealDesk may earn a commission when a user opens a merchant link. Merchant checkout controls final price, tax, shipping, eligibility, and availability.",
  deals: indexableDeals.map((deal) => ({
    id: deal.id,
    title: deal.title,
    canonical_url: absolute(deal.url),
    merchant: deal.merchant,
    category: deal.categoryLabel || deal.category,
    image_url: deal.imageURL,
    current_price: deal.currentPrice,
    original_price: deal.originalPrice || null,
    savings: deal.savingsText || deal.badgeText || null,
    terms: deal.priceNote || null,
    verified_at: isoDate(deal.verifiedAt),
    expires_at: deal.expiresAt || null,
  })),
};

const merchantMap = new Map();
for (const deal of indexableDeals) {
  const name = String(deal.merchant || "Merchant").trim();
  if (!merchantMap.has(name)) merchantMap.set(name, []);
  merchantMap.get(name).push(deal);
}
const publishedMerchantPaths = new Set(authorityReport.merchantPaths || []);
const merchants = [...merchantMap.entries()].map(([name, merchantDeals]) => {
  const prices = merchantDeals.map((deal) => priceNumber(deal.currentPrice)).filter((value) => value !== null);
  const categories = [...new Set(merchantDeals.map((deal) => deal.categoryLabel || deal.category).filter(Boolean))].sort();
  const newestCheck = merchantDeals.map((deal) => isoDate(deal.verifiedAt)).sort().at(-1) || updatedDate;
  const canonicalPath = `/merchant/${slugify(name)}/`;
  return {
    name,
    canonical_path: canonicalPath,
    canonical_url: `${site}${canonicalPath}`,
    offer_count: merchantDeals.length,
    categories,
    lowest_displayed_price: prices.length ? Math.min(...prices) : null,
    newest_check: newestCheck,
  };
}).filter((merchant) => publishedMerchantPaths.has(merchant.canonical_path))
  .map(({ canonical_path, ...merchant }) => merchant)
  .sort((a, b) => b.offer_count - a.offer_count || a.name.localeCompare(b.name));
const publicMerchantFeed = {
  version: 1,
  generatedAt: updatedISO,
  canonical: `${site}/feeds/merchants.v1.json`,
  total: merchants.length,
  merchants,
};

const feedsRoot = resolve(root, "feeds");
await mkdir(feedsRoot, { recursive: true });
await writeFile(resolve(feedsRoot, "deals.v1.json"), `${JSON.stringify(publicDealFeed, null, 2)}\n`);
await writeFile(resolve(feedsRoot, "merchants.v1.json"), `${JSON.stringify(publicMerchantFeed, null, 2)}\n`);

const feedPage = `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>DealDesk data feeds: verified deals and merchants</title>\n  <meta name="description" content="Machine-readable DealDesk feeds for verified offers and merchants, with canonical URLs and verification dates." />\n  <meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large" />\n  <meta name="dealdesk-discovery" content="${buildID}" />\n  <link rel="canonical" href="${site}/feeds/" />\n  <link rel="alternate" type="application/rss+xml" title="DealDesk verified deals" href="/feed.xml" />\n  <link rel="stylesheet" href="/styles.css" />\n  <link rel="stylesheet" href="/assets/indexing.css" />\n  <link rel="stylesheet" href="/assets/seo-authority.css" />\n  <script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "DataCatalog",
    name: "DealDesk verified deal feeds",
    url: `${site}/feeds/`,
    dateModified: updatedDate,
    dataset: [
      { "@type": "Dataset", name: "DealDesk deals feed", url: `${site}/feeds/deals.v1.json`, dateModified: updatedDate },
      { "@type": "Dataset", name: "DealDesk merchants feed", url: `${site}/feeds/merchants.v1.json`, dateModified: updatedDate },
    ],
  }).replaceAll("<", "\\u003c")}</script>\n</head>\n<body class="authority-page">\n  <header class="site-header"><nav class="nav shell" aria-label="Primary navigation"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><div class="nav-links"><a href="/latest-deals/">Latest deals</a><a href="/deals/">All deals</a><a href="/merchants/">Merchants</a><a href="/comparisons/">Comparisons</a></div></nav></header>\n  <main class="shell authority-shell">\n    <nav class="deal-breadcrumb" aria-label="Breadcrumb"><a href="/">DealDesk</a><span aria-hidden="true">›</span><span>Data feeds</span></nav>\n    <section class="authority-hero"><span class="page-kicker"><span></span> Machine-readable</span><h1>DealDesk data feeds</h1><p>Use canonical DealDesk URLs, verification dates, displayed pricing, and merchant context in applications, research, and search experiences. Always preserve the verification date and treat the merchant checkout as the final source of truth.</p></section>\n    <section class="authority-directory">\n      <a href="/feeds/deals.v1.json"><strong>Verified deals JSON</strong><span>${deals.length} current public offers</span><small>Open feed →</small></a>\n      <a href="/feeds/merchants.v1.json"><strong>Merchant directory JSON</strong><span>${merchants.length} merchants with current offers</span><small>Open feed →</small></a>\n      <a href="/feed.xml"><strong>Latest deals RSS</strong><span>100 recently prioritized offers</span><small>Open RSS →</small></a>\n      <a href="/data/dealdesk-deal-index.json"><strong>DealDesk Deal Index</strong><span>Scoring and query-target metadata</span><small>Open index →</small></a>\n    </section>\n    <section class="authority-explainer"><strong>Attribution and accuracy</strong><p>Link to the canonical DealDesk detail page rather than copying the merchant affiliate destination. Include the <code>verified_at</code> value when presenting a price. Do not imply that a price remains available after its verification date without checking the merchant.</p></section>\n  </main>\n  <footer class="footer"><div class="shell footer-inner"><a class="brand footer-brand" href="/"><span class="brand-mark">D</span><span>DealDesk</span></a><p>Clear prices. Better clicks.</p><div class="footer-links"><a href="/how-we-rank-deals/">Methodology</a><a href="/editorial-policy/">Editorial policy</a><a href="/privacy/">Privacy</a></div></div></footer>\n</body>\n</html>\n`;
const filteredFeedPage = feedPage
  .replace(`${deals.length} current public offers`, `${indexableDeals.length} search-indexable offers`)
  .replace("100 recently prioritized offers", `${Math.min(100, indexableDeals.length)} current verified offers`);
await writeFile(resolve(feedsRoot, "index.html"), filteredFeedPage);

const llms = `# DealDesk\n\n> DealDesk is a verified deal-analysis and comparison site. It publishes canonical pages for current offers, curated deal guides, merchant directories, comparison pages, transparent deal scores, and machine-readable feeds.\n\n## Canonical site\n- ${site}/\n- Latest deals: ${site}/latest-deals/\n- All deals: ${site}/deals/\n- Deal guides: ${site}/collections/\n- Subscription deals: ${site}/category/subscriptions/\n- Streaming deals: ${site}/category/streaming/\n- Merchants: ${site}/merchants/\n- Comparisons: ${site}/comparisons/\n- Methodology: ${site}/how-we-rank-deals/\n- Editorial policy: ${site}/editorial-policy/\n\n## Machine-readable resources\n- Deals JSON: ${site}/feeds/deals.v1.json\n- Merchants JSON: ${site}/feeds/merchants.v1.json\n- Latest deals RSS: ${site}/feed.xml\n- Deal index: ${site}/data/dealdesk-deal-index.json\n- Sitemap index: ${site}/sitemap.xml\n\n## Citation guidance\n1. Cite the canonical DealDesk deal page, not the affiliate redirect URL.\n2. Include the displayed verification date when mentioning a price.\n3. Describe original or reference prices as displayed comparisons, not guaranteed historical selling prices.\n4. Merchant checkout controls final price, tax, shipping, condition, eligibility, warranty, and availability.\n5. DealDesk may earn a commission from qualifying purchases.\n`;
await writeFile(resolve(root, "llms.txt"), llms);

const patchDiscoveryLinks = async (filePath) => {
  let html = await readFile(filePath, "utf8");
  if (!html.includes('type="application/rss+xml"')) {
    html = html.replace(/\s*<\/head>/, `\n  <link rel="alternate" type="application/rss+xml" title="DealDesk verified deals" href="/feed.xml" />\n</head>`);
  }
  if (!html.includes('href="/feeds/"')) {
    html = html.replace(/(<div class="footer-links">)/, `$1<a href="/feeds/">Data feeds</a>`);
  }
  await writeFile(filePath, html);
};
await patchDiscoveryLinks(resolve(root, "index.html"));
await patchDiscoveryLinks(resolve(root, "latest-deals", "index.html"));

let authoritySitemap = await readFile(resolve(root, "sitemap-authority.xml"), "utf8");
if (!authoritySitemap.includes(`${site}/feeds/`)) {
  authoritySitemap = authoritySitemap.replace(/\s*<\/urlset>/, `\n  <url><loc>${site}/feeds/</loc><lastmod>${updatedDate}</lastmod></url>\n</urlset>`);
  await writeFile(resolve(root, "sitemap-authority.xml"), authoritySitemap);
}

console.log(`Built multi-engine discovery assets for ${indexableDeals.length} indexable of ${deals.length} browseable deals, ${merchants.length} merchants, and ${indexNowURLs.length} IndexNow URLs.`);
