import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = "https://dealdesk.fyi";
const buildID = "price-history-v1";
const today = new Date().toISOString().slice(0, 10);
const maxObservationsPerDeal = 104;

const latestCatalog = JSON.parse(await readFile(resolve(root, "data", "latest-deals.json"), "utf8"));
const currentDeals = Array.isArray(latestCatalog.deals) ? latestCatalog.deals : [];
if (!currentDeals.length) throw new Error("data/latest-deals.json does not contain public deals");

const historyPath = resolve(root, "data", "price-history.json");
let history = { version: 1, generatedAt: null, catalogUpdatedAt: null, deals: {} };
try {
  const parsed = JSON.parse(await readFile(historyPath, "utf8"));
  if (parsed && typeof parsed === "object" && parsed.deals && typeof parsed.deals === "object") history = parsed;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const csv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const dateOnly = (value, fallback = today) => {
  const date = new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString().slice(0, 10);
};
const dayDistance = (left, right) => {
  const a = new Date(`${left}T00:00:00Z`).getTime();
  const b = new Date(`${right}T00:00:00Z`).getTime();
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86400000)) : 0;
};
const moneyAmount = (value) => {
  const match = String(value || "").replaceAll(",", "").match(/(?:US)?\$\s*(-?\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : null;
};
const absolute = (path) => `${site}${path}`;
const observationFingerprint = (observation) => JSON.stringify([
  observation.currentPrice,
  observation.originalPrice,
  observation.expiresAt,
  observation.priceNote,
]);
const money = (amount) => Number.isFinite(amount)
  ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: amount >= 100 ? 0 : 2 }).format(amount)
  : "Not available";

for (const record of Object.values(history.deals)) record.active = false;

for (const deal of currentDeals) {
  const observation = {
    date: today,
    verifiedAt: dateOnly(deal.verifiedAt),
    currentPrice: String(deal.currentPrice || ""),
    currentPriceAmount: moneyAmount(deal.currentPrice),
    originalPrice: String(deal.originalPrice || ""),
    originalPriceAmount: moneyAmount(deal.originalPrice),
    expiresAt: deal.expiresAt ? dateOnly(deal.expiresAt) : "",
    priceNote: String(deal.priceNote || ""),
  };
  const prior = history.deals[deal.id] || {
    id: deal.id,
    title: deal.title,
    url: deal.url,
    merchant: deal.merchant,
    category: deal.categoryLabel || deal.category || "Other",
    firstSeen: today,
    lastSeen: today,
    active: true,
    observations: [],
  };
  prior.title = deal.title;
  prior.url = deal.url;
  prior.merchant = deal.merchant;
  prior.category = deal.categoryLabel || deal.category || "Other";
  prior.active = true;
  prior.firstSeen = prior.firstSeen || today;
  prior.lastSeen = today;
  prior.observations = Array.isArray(prior.observations) ? prior.observations : [];
  const last = prior.observations.at(-1);
  if (last?.date === today) {
    prior.observations[prior.observations.length - 1] = observation;
  } else if (!last || observationFingerprint(last) !== observationFingerprint(observation) || dayDistance(last.date, today) >= 7) {
    prior.observations.push(observation);
  }
  prior.observations = prior.observations.slice(-maxObservationsPerDeal);
  history.deals[deal.id] = prior;
}

history.version = 1;
history.generatedAt = new Date().toISOString();
history.catalogUpdatedAt = latestCatalog.updatedAt || null;

const metricsFor = (record) => {
  const numeric = record.observations.filter((item) => Number.isFinite(item.currentPriceAmount));
  const amounts = numeric.map((item) => item.currentPriceAmount);
  const current = record.observations.at(-1) || null;
  const firstNumeric = numeric[0] || null;
  const currentNumeric = [...numeric].reverse()[0] || null;
  const low = amounts.length ? Math.min(...amounts) : null;
  const high = amounts.length ? Math.max(...amounts) : null;
  const changeAmount = firstNumeric && currentNumeric ? currentNumeric.currentPriceAmount - firstNumeric.currentPriceAmount : null;
  const changePercent = firstNumeric && currentNumeric && firstNumeric.currentPriceAmount > 0
    ? Math.round((changeAmount / firstNumeric.currentPriceAmount) * 100)
    : null;
  let priceChanges = 0;
  for (let index = 1; index < numeric.length; index += 1) {
    if (numeric[index].currentPriceAmount !== numeric[index - 1].currentPriceAmount) priceChanges += 1;
  }
  return { current, numeric, low, high, changeAmount, changePercent, priceChanges };
};

const historySection = (record) => {
  const metrics = metricsFor(record);
  const currentLabel = metrics.current?.currentPrice || "See current terms";
  const intro = record.observations.length === 1
    ? `DealDesk started tracking this exact offer on ${record.firstSeen}. More observations will accumulate as the catalog is rechecked.`
    : `DealDesk has tracked this exact offer from ${record.firstSeen} through ${record.lastSeen}. The current displayed price is ${currentLabel}.`;
  const trend = Number.isFinite(metrics.changePercent) && metrics.numeric.length > 1
    ? metrics.changePercent < 0
      ? `${Math.abs(metrics.changePercent)}% below the first observed price`
      : metrics.changePercent > 0
        ? `${metrics.changePercent}% above the first observed price`
        : "unchanged from the first observed price"
    : "history is still accumulating";
  const timeline = record.observations.slice(-8).reverse().map((item) => `<li><time datetime="${esc(item.date)}">${esc(item.date)}</time><strong>${esc(item.currentPrice || "See terms")}</strong><span>${esc(item.priceNote || "No additional price note")}</span></li>`).join("");
  return `<!-- PRICE-HISTORY:START -->
  <section class="deal-price-history" aria-labelledby="deal-price-history-title">
    <div class="price-history-heading"><div><span class="page-kicker"><span></span> First-party tracking</span><h2 id="deal-price-history-title">DealDesk price history</h2><p>${esc(intro)}</p></div><a href="/price-history/">Explore the dataset</a></div>
    <dl class="price-history-stats"><div><dt>Current</dt><dd>${esc(currentLabel)}</dd></div><div><dt>Lowest observed</dt><dd>${Number.isFinite(metrics.low) ? esc(money(metrics.low)) : "Not available"}</dd></div><div><dt>Highest observed</dt><dd>${Number.isFinite(metrics.high) ? esc(money(metrics.high)) : "Not available"}</dd></div><div><dt>Trend</dt><dd>${esc(trend)}</dd></div><div><dt>Observations</dt><dd>${record.observations.length}</dd></div><div><dt>Price changes</dt><dd>${metrics.priceChanges}</dd></div></dl>
    <ol class="price-history-timeline">${timeline}</ol>
    <p class="price-history-note">This history follows the exact listing represented by this DealDesk page. It is not a claim about every seller, variant, condition, or market price. Confirm the final price and terms at merchant checkout.</p>
  </section>
  <!-- PRICE-HISTORY:END -->`;
};

for (const deal of currentDeals) {
  const record = history.deals[deal.id];
  const file = resolve(root, String(deal.url || "").replace(/^\//, ""), "index.html");
  let html = await readFile(file, "utf8");
  html = html.replace(/\s*<!-- PRICE-HISTORY:START -->[\s\S]*?<!-- PRICE-HISTORY:END -->/g, "");
  if (!html.includes("/assets/price-history.css")) {
    html = html.replace(/<\/head>/, `  <link rel="stylesheet" href="/assets/price-history.css?v=${buildID}" />\n</head>`);
  }
  const section = historySection(record);
  if (/\s*<!-- SEO-AUTHORITY:START -->/.test(html)) {
    html = html.replace(/\s*<!-- SEO-AUTHORITY:START -->/, `\n  ${section}\n  <!-- SEO-AUTHORITY:START -->`);
  } else if (/\s*<section class="deal-more">/.test(html)) {
    html = html.replace(/\s*<section class="deal-more">/, `\n  ${section}\n  <section class="deal-more">`);
  } else {
    throw new Error(`Could not place price history section in ${deal.url}`);
  }
  await writeFile(file, html);
}

const activeRecords = Object.values(history.deals).filter((record) => record.active);
const allRecords = Object.values(history.deals);
const observationCount = allRecords.reduce((sum, record) => sum + record.observations.length, 0);
const recordsWithChanges = activeRecords
  .map((record) => ({ record, metrics: metricsFor(record) }))
  .filter(({ metrics }) => metrics.numeric.length > 1 && metrics.priceChanges > 0)
  .sort((left, right) => (left.metrics.changePercent ?? 0) - (right.metrics.changePercent ?? 0));
const merchantCount = new Set(activeRecords.map((record) => record.merchant)).size;
const earliest = allRecords.map((record) => record.firstSeen).sort()[0] || today;

const historyIndexPath = resolve(root, "price-history", "index.html");
await mkdir(dirname(historyIndexPath), { recursive: true });
const description = `Explore first-party price observations for ${activeRecords.length} active DealDesk offers across ${merchantCount} merchants. Download the JSON or CSV dataset and verify every price at checkout.`;
const datasetSchema = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "DealDesk Price History Dataset",
  description,
  url: `${site}/price-history/`,
  dateModified: today,
  temporalCoverage: `${earliest}/${today}`,
  creator: { "@type": "Organization", name: "DealDesk", url: site },
  distribution: [
    { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${site}/data/price-history.json` },
    { "@type": "DataDownload", encodingFormat: "text/csv", contentUrl: `${site}/data/price-history.csv` },
  ],
};
const changeCards = recordsWithChanges.length
  ? recordsWithChanges.slice(0, 24).map(({ record, metrics }) => `<a class="price-change-card" href="${esc(record.url)}"><strong>${esc(record.title)}</strong><span>${esc(record.merchant)} · ${esc(record.category)}</span><b>${metrics.changePercent < 0 ? `${Math.abs(metrics.changePercent)}% lower` : `${metrics.changePercent}% higher`}</b><small>${esc(record.firstSeen)} to ${esc(record.lastSeen)}</small></a>`).join("\n")
  : `<div class="price-history-empty"><strong>Baseline established</strong><p>DealDesk began recording this dataset on ${earliest}. Price-change rankings will appear after verified catalog prices move.</p></div>`;
const historyIndexHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Deal price history and downloadable dataset | DealDesk</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
  <link rel="canonical" href="${site}/price-history/" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="Deal price history and downloadable dataset | DealDesk" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${site}/price-history/" />
  <meta property="og:image" content="${site}/assets/dealdesk-publisher-logo.png" />
  <meta name="twitter:card" content="summary" />
  <link rel="icon" type="image/png" href="/assets/dealdesk-publisher-logo.png" />
  <link rel="stylesheet" href="/styles.css?v=${buildID}" />
  <link rel="stylesheet" href="/assets/indexing.css?v=${buildID}" />
  <link rel="stylesheet" href="/assets/seo-authority.css?v=${buildID}" />
  <link rel="stylesheet" href="/assets/price-history.css?v=${buildID}" />
  <script type="application/ld+json">${JSON.stringify(datasetSchema).replaceAll("<", "\\u003c")}</script>
</head>
<body class="authority-page">
<header class="site-header"><nav class="nav shell" aria-label="Primary navigation"><a class="brand" href="/" aria-label="DealDesk home"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><div class="nav-links"><a href="/latest-deals/">Latest deals</a><a href="/deals/">All deals</a><a href="/merchants/">Merchants</a><a href="/deal-index/">Deal Index</a></div></nav></header>
<main class="deal-home shell authority-shell"><nav class="deal-breadcrumb"><a href="/">DealDesk</a><span>›</span><span>Price history</span></nav><header class="authority-hero"><span class="page-kicker"><span></span> Original DealDesk data</span><h1>Deal price history</h1><p>${esc(description)}</p><div class="price-history-downloads"><a href="/data/price-history.json" download>Download JSON</a><a href="/data/price-history.csv" download>Download CSV</a></div></header><section class="authority-stat-grid"><article><strong>${activeRecords.length}</strong><span>active offers tracked</span></article><article><strong>${observationCount}</strong><span>stored observations</span></article><article><strong>${merchantCount}</strong><span>merchants represented</span></article><article><strong>${earliest}</strong><span>tracking began</span></article></section><section class="authority-analysis"><h2>How this history works</h2><p>DealDesk records a baseline for each exact listing and stores a new observation when the displayed price or material terms change, or after seven days. This makes the dataset useful without manufacturing daily volatility. The history is listing-specific and does not claim complete market coverage.</p></section><section aria-labelledby="price-movements-title"><div class="price-history-heading"><div><span class="page-kicker"><span></span> Verified movements</span><h2 id="price-movements-title">Observed price changes</h2></div></div><div class="price-change-grid">${changeCards}</div></section></main>
<footer class="footer"><div class="shell footer-inner"><a class="brand footer-brand" href="/"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><p>Verified prices. Better decisions.</p><div class="footer-links"><a href="/deals/">All deals</a><a href="/merchants/">Merchants</a><a href="/comparisons/">Comparisons</a><a href="/deal-index/">Deal Index</a><a href="/price-history/">Price history</a><a href="/editorial-policy/">Editorial policy</a></div></div><div class="shell disclosure">DealDesk may earn a commission when you buy through our links. Prices and availability can change at checkout.</div></footer>
</body>
</html>
`;
await writeFile(historyIndexPath, historyIndexHTML);

const csvRows = [
  ["deal_id", "title", "url", "merchant", "category", "active", "first_seen", "last_seen", "observation_date", "current_price", "current_price_amount", "original_price", "original_price_amount", "verified_at", "expires_at", "price_note"].map(csv).join(","),
];
for (const record of allRecords.sort((a, b) => a.id.localeCompare(b.id))) {
  for (const item of record.observations) {
    csvRows.push([record.id, record.title, absolute(record.url), record.merchant, record.category, record.active, record.firstSeen, record.lastSeen, item.date, item.currentPrice, item.currentPriceAmount ?? "", item.originalPrice, item.originalPriceAmount ?? "", item.verifiedAt, item.expiresAt, item.priceNote].map(csv).join(","));
  }
}
await mkdir(resolve(root, "data"), { recursive: true });
await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);
await writeFile(resolve(root, "data", "price-history.csv"), `${csvRows.join("\n")}\n`);

const sitemapPath = resolve(root, "sitemap-authority.xml");
let sitemap = await readFile(sitemapPath, "utf8");
sitemap = sitemap.replace(/\s*<url><loc>https:\/\/dealdesk\.fyi\/price-history\/<\/loc>[\s\S]*?<\/url>/g, "");
sitemap = sitemap.replace(/\s*<\/urlset>/, `\n  <url><loc>${site}/price-history/</loc><lastmod>${today}</lastmod></url>\n</urlset>`);
await writeFile(sitemapPath, sitemap);

const homePath = resolve(root, "index.html");
let home = await readFile(homePath, "utf8");
home = home.replace(/\s*<!-- PRICE-HISTORY-HOME:START -->[\s\S]*?<!-- PRICE-HISTORY-HOME:END -->/g, "");
if (home.includes('<div class="seo-authority-hub-links">')) {
  home = home.replace('<div class="seo-authority-hub-links">', '<div class="seo-authority-hub-links"><!-- PRICE-HISTORY-HOME:START --><a href="/price-history/"><strong>Price history</strong><span>First-party observations and downloads</span></a><!-- PRICE-HISTORY-HOME:END -->');
}
await writeFile(homePath, home);

const llmsPath = resolve(root, "llms.txt");
let llms = await readFile(llmsPath, "utf8");
llms = llms.replace(/\n?# PRICE history[\s\S]*?# END PRICE history\n?/gi, "\n");
llms = `${llms.trimEnd()}\n\n# PRICE HISTORY\n- Hub: ${site}/price-history/\n- JSON dataset: ${site}/data/price-history.json\n- CSV dataset: ${site}/data/price-history.csv\n- Method: exact-listing baselines plus changes or seven-day observations.\n# END PRICE HISTORY\n`;
await writeFile(llmsPath, llms);

console.log(`Tracked ${activeRecords.length} active deals across ${observationCount} observations; generated ${recordsWithChanges.length} price-change records.`);
