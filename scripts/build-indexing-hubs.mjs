import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = "https://dealdesk.fyi";
const buildID = "2026-08-08-crawl-v3";
const archivePageSize = 32;
const categoryPageSize = 32;
const sitemapDealChunkSize = 200;
const priorityDealCount = 100;

const [latestCatalog, searchIndexPayload, categoryGuidePayload, ...sourceFeeds] = await Promise.all([
  readFile(resolve(root, "data/latest-deals.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/search-index.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/seo-category-guides.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/best-deals.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/streaming-deals.json"), "utf8").then(JSON.parse),
]);

const deals = Array.isArray(latestCatalog.deals) ? latestCatalog.deals : [];
if (!deals.length) throw new Error("data/latest-deals.json does not contain any public deals");
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
const isSearchIndexable = (deal) => searchIndexByID.get(deal.id)?.indexable === true;
const indexableDeals = deals.filter(isSearchIndexable);

const sourceByID = new Map(sourceFeeds.flatMap((feed) => feed.deals || []).map((deal) => [deal.id, deal]));
const updatedAt = new Date(latestCatalog.updatedAt || Date.now());
const buildLastmod = Number.isNaN(updatedAt.getTime())
  ? new Date().toISOString().slice(0, 10)
  : updatedAt.toISOString().slice(0, 10);

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const slugify = (value) => String(value || "other").toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "") || "other";
const moneyNumber = (value) => Number(String(value || "").replace(/[^0-9.]/g, ""));
const isMoney = (value) => /^\s*(?:US)?\$\s*\d/.test(String(value || ""));
const isoDate = (value) => {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? buildLastmod : date.toISOString().slice(0, 10);
};
const dealPath = (deal) => String(deal.url || `/deals/${slugify(deal.id)}/`);
const absolute = (path) => `${site}${path}`;
const pagePath = (basePath, page) => page === 1 ? basePath : `${basePath}page/${page}/`;
const pageOutput = (baseDirectory, page) => page === 1
  ? resolve(baseDirectory, "index.html")
  : resolve(baseDirectory, "page", String(page), "index.html");
const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
  items.slice(index * size, (index + 1) * size)
);
const newestVerifiedDate = (items) => items
  .map((deal) => isoDate(deal.verifiedAt))
  .filter(Boolean)
  .sort()
  .at(-1) || buildLastmod;

const categoryMap = new Map();
for (const deal of deals) {
  const label = deal.categoryLabel || deal.category || "Other";
  const key = slugify(label);
  if (!categoryMap.has(key)) categoryMap.set(key, { key, label, deals: [] });
  categoryMap.get(key).deals.push(deal);
}
const categories = [...categoryMap.values()].sort((a, b) =>
  b.deals.length - a.deals.length || a.label.localeCompare(b.label)
);
const categoryGuides = categoryGuidePayload?.categories || {};
const categoryGuideFor = (category) => categoryGuides[category.label] || {
  singular: category.label,
  queryLabel: `${category.label.toLowerCase()} deals`,
  title: `${category.label} Deals to Compare`,
  heading: `Compare ${category.label} Deals`,
};
const categoryByDealID = new Map();
for (const category of categories) {
  for (const deal of category.deals) categoryByDealID.set(deal.id, category);
}

const conditionFrom = (deal) => {
  const text = String(deal.priceNote || "").toLowerCase();
  if (text.includes("certified refurbished")) return "Certified refurbished";
  if (text.includes("refurbished")) return "Refurbished";
  if (text.includes("open box")) return "Open box";
  if (/\bpre-owned\b/.test(text)) return "Pre-owned";
  if (/\bused\b/.test(text)) return "Used";
  if (/\bnew\b/.test(text)) return "New";
  return "Not stated";
};

const contextFor = (deal) => {
  const source = sourceByID.get(deal.id) || {};
  const sentences = [];
  const current = moneyNumber(deal.currentPrice);
  const original = moneyNumber(deal.originalPrice);
  const badgeDiscount = String(deal.badgeText || "").match(/(\d+)%\s*off/i);
  const discount = badgeDiscount ? Number(badgeDiscount[1]) : original > current && current >= 0 ? Math.round((1 - current / original) * 100) : 0;
  const difference = original > current && current >= 0 ? original - current : 0;

  const referenceName = deal.referenceStyle === "renewal"
    ? "renewal price"
    : deal.referenceStyle === "comparison"
      ? "comparison reference"
      : "reference price";
  if (isMoney(deal.currentPrice) && isMoney(deal.originalPrice) && difference > 0) {
    sentences.push(`${deal.title} is listed at ${deal.currentPrice}, ${difference.toLocaleString("en-US", { style: "currency", currency: "USD" })} below the displayed ${referenceName}${discount ? ` (${discount}% lower)` : ""}.`);
  } else if (deal.currentPrice) {
    sentences.push(`DealDesk verified the displayed ${deal.currentPrice} price for ${deal.title} without inventing a comparison price.`);
  }

  if (deal.referenceStyle === "renewal" && deal.originalPrice) {
    sentences.push(`This is an introductory offer; the displayed rate changes to ${deal.originalPrice} after the introductory period, so confirm renewal timing before purchase.`);
  } else if (deal.referenceStyle === "comparison" && deal.originalPrice) {
    sentences.push(`The ${deal.referenceLabel || "reference price"} is presented as a comparison basis rather than a claim about the merchant's immediately previous selling price.`);
  }

  const condition = conditionFrom(deal);
  if (condition !== "Not stated") {
    sentences.push(`The merchant describes the item condition as ${condition.toLowerCase()}; review the grading, warranty, included accessories, and return policy on the merchant page.`);
  }
  if (/free shipping/i.test(String(deal.priceNote || ""))) {
    sentences.push("The listing states free shipping, but destination restrictions and delivery timing can still vary.");
  }
  if (source.summary && !sentences.join(" ").includes(String(source.summary).trim())) {
    const summary = String(source.summary).replace(/\s+/g, " ").trim();
    if (summary && summary.length <= 420) sentences.push(summary.endsWith(".") ? summary : `${summary}.`);
  }
  sentences.push(`Price and availability were checked on ${isoDate(deal.verifiedAt)}; the merchant checkout remains the source of truth.`);
  return sentences.join(" ");
};

const staticCard = (deal, { eager = false } = {}) => {
  const title = deal.title || "Deal";
  return `<article class="deal-card crawl-card">
    <a class="deal-card-link" href="${esc(dealPath(deal))}" aria-label="${esc(title)}, ${esc(deal.currentPrice || "See terms")}. View deal details">
      <span class="deal-media">
${deal.badgeText ? `        <span class="discount-badge">${esc(deal.badgeText)}</span>\n` : ""}        <img src="${esc(deal.imageURL)}" alt="${esc(title)}" width="800" height="520" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" />
      </span>
      <span class="deal-body">
        <span class="price-line"><strong>${esc(deal.currentPrice || "See terms")}</strong>${deal.originalPrice ? deal.referenceStyle === "renewal" ? `<span class="original-price">${esc(deal.referenceLabel || "Then")} ${esc(deal.originalPrice)}</span>` : `<span class="original-price">${esc(deal.referenceLabel || "Was")} <del>${esc(deal.originalPrice)}</del></span>` : ""}</span>
${deal.savingsText ? `        <span class="saving-text">${esc(deal.savingsText)}</span>\n` : ""}${deal.priceNote ? `        <span class="price-note">${esc(deal.priceNote)}</span>\n` : ""}        <strong class="deal-title">${esc(title)}</strong>
        <span class="deal-meta">${esc(deal.merchant || "Merchant")} · ${esc(deal.categoryLabel || "Deal")} · Checked ${esc(isoDate(deal.verifiedAt))}</span>
        <span class="deal-cta">View deal details</span>
      </span>
    </a>
  </article>`;
};

const pagination = (basePath, currentPage, pageCount) => {
  if (pageCount <= 1) return "";
  const pageLinks = Array.from({ length: pageCount }, (_, index) => {
    const page = index + 1;
    if (page === currentPage) return `<span aria-current="page">${page}</span>`;
    return `<a href="${pagePath(basePath, page)}">${page}</a>`;
  }).join("");
  return `<nav class="crawl-pagination" aria-label="Pagination">
    <div>${currentPage > 1 ? `<a class="crawl-pagination-direction" href="${pagePath(basePath, currentPage - 1)}">← Previous</a>` : ""}</div>
    <div class="crawl-pagination-pages">${pageLinks}</div>
    <div>${currentPage < pageCount ? `<a class="crawl-pagination-direction" href="${pagePath(basePath, currentPage + 1)}">Next →</a>` : ""}</div>
  </nav>`;
};

const header = (current = "") => `<header class="site-header"><nav class="nav shell" aria-label="Primary navigation"><a class="brand" href="/" aria-label="DealDesk home"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><div class="nav-links"><a href="/latest-deals/"${current === "latest" ? ' aria-current="page"' : ""}>Latest deals</a><a href="/category/subscriptions/">Subscription deals</a><a href="/category/streaming/">Streaming deals</a><a href="/deals/"${current === "deals" ? ' aria-current="page"' : ""}>All deals</a><a href="/categories/"${current === "categories" ? ' aria-current="page"' : ""}>Categories</a></div></nav></header>`;
const footer = `<footer class="footer"><div class="shell footer-inner"><a class="brand footer-brand" href="/"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><p>Clear prices. Better clicks.</p><div class="footer-links"><a href="/deals/">All deals</a><a href="/categories/">Categories</a><a href="/support/">Support</a><a href="/privacy/">Privacy</a></div></div><div class="shell disclosure">DealDesk may earn a commission when you buy through our links. Prices and availability can change at checkout.</div></footer>`;

const archivePages = chunk(deals, archivePageSize);
const archiveDirectory = resolve(root, "deals");
await rm(resolve(archiveDirectory, "page"), { recursive: true, force: true });
await rm(resolve(archiveDirectory, "index.html"), { force: true });
for (let pageIndex = 0; pageIndex < archivePages.length; pageIndex += 1) {
  const page = pageIndex + 1;
  const pageDeals = archivePages[pageIndex];
  const canonicalPath = pagePath("/deals/", page);
  const pageTitle = page === 1 ? "All deal listings" : `All deal listings – Page ${page}`;
  const pageLastmod = newestVerifiedDate(pageDeals);
  const pageIndexable = page === 1;
  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: pageTitle,
    url: absolute(canonicalPath),
    dateModified: pageLastmod,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: pageDeals.length,
      itemListElement: pageDeals.map((deal, index) => ({
        "@type": "ListItem",
        position: pageIndex * archivePageSize + index + 1,
        name: deal.title,
        url: absolute(dealPath(deal)),
      })),
    },
  };
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(pageTitle)} | DealDesk</title>
  <meta name="description" content="Browse page ${page} of the DealDesk catalog with displayed prices, merchant details, and visible check dates." />
  <meta name="robots" content="${pageIndexable ? "index,follow" : "noindex,follow"},max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
  <meta name="dealdesk-build" content="${buildID}" />
  <link rel="canonical" href="${absolute(canonicalPath)}" />
  <link rel="sitemap" type="application/xml" href="/sitemap.xml" />
  <link rel="icon" type="image/png" href="/assets/dealdesk-publisher-logo.png" />
  <link rel="stylesheet" href="/styles.css?v=${buildID}" />
  <link rel="stylesheet" href="/assets/indexing.css?v=${buildID}" />
  <script type="application/ld+json">${JSON.stringify(schema).replaceAll("<", "\\u003c")}</script>
</head>
<body class="crawl-archive-page">
  ${header("deals")}
  <main class="deal-home shell crawl-archive">
    <nav class="deal-breadcrumb" aria-label="Breadcrumb"><a href="/">DealDesk</a><span aria-hidden="true">›</span><span>All deals</span>${page > 1 ? `<span aria-hidden="true">›</span><span>Page ${page}</span>` : ""}</nav>
    <header class="page-heading crawl-heading"><div><span class="page-kicker"><span aria-hidden="true"></span> Crawlable catalog</span><h1>${esc(pageTitle)}</h1></div><p><strong>${deals.length}</strong> catalog records · Page ${page} of ${archivePages.length}</p></header>
    <p class="crawl-intro">Every card below is a normal crawlable link. Use the category pages for a narrower comparison, or move through the numbered archive pages.</p>
    <div class="crawl-hub-actions"><a href="/categories/">Browse categories</a><a href="/latest-deals/">Interactive latest-deals view</a></div>
    ${pagination("/deals/", page, archivePages.length)}
    <div class="deal-grid crawl-grid">${pageDeals.map((deal, index) => staticCard(deal, { eager: page === 1 && index === 0 })).join("\n")}</div>
    ${pagination("/deals/", page, archivePages.length)}
  </main>
  ${footer}
</body>
</html>\n`;
  const output = pageOutput(archiveDirectory, page);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html);
}

const categoriesRoot = resolve(root, "categories");
const categoryRoot = resolve(root, "category");
await rm(categoriesRoot, { recursive: true, force: true });
await rm(categoryRoot, { recursive: true, force: true });
await mkdir(categoriesRoot, { recursive: true });

const categoryIndexSchema = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "Deal categories",
  url: `${site}/categories/`,
  dateModified: buildLastmod,
  mainEntity: {
    "@type": "ItemList",
    numberOfItems: categories.length,
    itemListElement: categories.map((category, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: category.label,
      url: `${site}/category/${category.key}/`,
    })),
  },
};
const categoryIndexHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Deal categories | DealDesk</title>
  <meta name="description" content="Browse the DealDesk offer catalog through crawlable category pages with visible prices, merchants, and check dates." />
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1" />
  <meta name="dealdesk-build" content="${buildID}" />
  <link rel="canonical" href="${site}/categories/" />
  <link rel="sitemap" type="application/xml" href="/sitemap.xml" />
  <link rel="icon" type="image/png" href="/assets/dealdesk-publisher-logo.png" />
  <link rel="stylesheet" href="/styles.css?v=${buildID}" />
  <link rel="stylesheet" href="/assets/indexing.css?v=${buildID}" />
  <script type="application/ld+json">${JSON.stringify(categoryIndexSchema).replaceAll("<", "\\u003c")}</script>
</head>
<body class="crawl-category-page">
  ${header("categories")}
  <main class="deal-home shell crawl-archive">
    <nav class="deal-breadcrumb" aria-label="Breadcrumb"><a href="/">DealDesk</a><span aria-hidden="true">›</span><span>Categories</span></nav>
    <header class="page-heading crawl-heading"><div><span class="page-kicker"><span aria-hidden="true"></span> Browse by need</span><h1>Deal categories</h1></div><p><strong>${categories.length}</strong> categories · ${deals.length} catalog records</p></header>
    <p class="crawl-intro">Category hubs provide stable internal links to every active DealDesk offer without relying on search, filters, or a load-more button.</p>
    <div class="crawl-category-grid">${categories.map((category) => `<a class="crawl-category-card" href="/category/${category.key}/"><strong>${esc(categoryGuideFor(category).singular)} deals</strong><span>${category.deals.length} catalog ${category.deals.length === 1 ? "record" : "records"}</span><small>Browse ${esc(category.label.toLowerCase())} →</small></a>`).join("\n")}</div>
  </main>
  ${footer}
</body>
</html>\n`;
await writeFile(resolve(categoriesRoot, "index.html"), categoryIndexHTML);

const categoryPageRecords = [];
for (const category of categories) {
  const pages = chunk(category.deals, categoryPageSize);
  const basePath = `/category/${category.key}/`;
  const directory = resolve(categoryRoot, category.key);
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pageIndex + 1;
    const pageDeals = pages[pageIndex];
    const canonicalPath = pagePath(basePath, page);
    const guide = categoryGuideFor(category);
    const pageTitle = page === 1 ? guide.title : `${guide.singular} Deals – Page ${page}`;
    const pageHeading = page === 1 ? guide.heading : `${guide.singular} Deals – Page ${page}`;
    const pageDescription = page === 1
      ? `Compare ${category.deals.length} ${guide.queryLabel} with displayed prices, material terms, and check dates.`
      : `Browse page ${page} of ${pages.length} for ${category.deals.length} ${guide.queryLabel}, with displayed prices and merchant details.`;
    const pageIndexable = page === 1;
    const pageLastmod = newestVerifiedDate(pageDeals);
    const schema = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: pageHeading,
      url: absolute(canonicalPath),
      dateModified: pageLastmod,
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: pageDeals.length,
        itemListElement: pageDeals.map((deal, index) => ({
          "@type": "ListItem",
          position: pageIndex * categoryPageSize + index + 1,
          name: deal.title,
          url: absolute(dealPath(deal)),
        })),
      },
    };
    const breadcrumbSchema = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "DealDesk", item: `${site}/` },
        { "@type": "ListItem", position: 2, name: "Deal categories", item: `${site}/categories/` },
        { "@type": "ListItem", position: 3, name: pageHeading, item: absolute(canonicalPath) },
      ],
    };
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(pageTitle)} | DealDesk</title>
  <meta name="description" content="${esc(pageDescription)}" />
  <meta name="robots" content="${pageIndexable ? "index,follow" : "noindex,follow"},max-image-preview:large,max-snippet:-1" />
  <meta name="dealdesk-build" content="${buildID}" />
  <link rel="canonical" href="${absolute(canonicalPath)}" />
  <link rel="sitemap" type="application/xml" href="/sitemap.xml" />
  <link rel="icon" type="image/png" href="/assets/dealdesk-publisher-logo.png" />
  <link rel="stylesheet" href="/styles.css?v=${buildID}" />
  <link rel="stylesheet" href="/assets/indexing.css?v=${buildID}" />
  <script type="application/ld+json">${JSON.stringify(schema).replaceAll("<", "\\u003c")}</script>
  <script type="application/ld+json">${JSON.stringify(breadcrumbSchema).replaceAll("<", "\\u003c")}</script>
</head>
<body class="crawl-category-page">
  ${header("categories")}
  <main class="deal-home shell crawl-archive">
    <nav class="deal-breadcrumb" aria-label="Breadcrumb"><a href="/">DealDesk</a><span aria-hidden="true">›</span><a href="/categories/">Categories</a><span aria-hidden="true">›</span><span>${esc(category.label)}</span>${page > 1 ? `<span aria-hidden="true">›</span><span>Page ${page}</span>` : ""}</nav>
    <header class="page-heading crawl-heading"><div><span class="page-kicker"><span aria-hidden="true"></span> ${esc(category.label)}</span><h1>${esc(pageHeading)}</h1></div><p><strong>${category.deals.length}</strong> catalog records · Page ${page} of ${pages.length}</p></header>
    <p class="crawl-intro">Compare the displayed price, condition or subscription terms, check date, and merchant before opening the individual deal page.</p>
    <div class="crawl-hub-actions"><a href="/categories/">All categories</a><a href="/deals/">Complete deal archive</a></div>
    ${pagination(basePath, page, pages.length)}
    <div class="deal-grid crawl-grid">${pageDeals.map((deal, index) => staticCard(deal, { eager: page === 1 && index === 0 })).join("\n")}</div>
    ${pagination(basePath, page, pages.length)}
  </main>
  ${footer}
</body>
</html>\n`;
    const output = pageOutput(directory, page);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, html);
    categoryPageRecords.push({ path: canonicalPath, lastmod: pageLastmod, indexable: pageIndexable });
  }
}

for (let index = 0; index < deals.length; index += 1) {
  const deal = deals[index];
  const category = categoryByDealID.get(deal.id);
  const archivePage = Math.floor(index / archivePageSize) + 1;
  const previous = index > 0 ? deals[index - 1] : null;
  const next = index < deals.length - 1 ? deals[index + 1] : null;
  const file = resolve(root, dealPath(deal).replace(/^\//, ""), "index.html");
  let html = await readFile(file, "utf8");

  if (!html.includes('name="dealdesk-build"')) {
    html = html.replace('<meta name="robots"', `<meta name="dealdesk-build" content="${buildID}" />\n  <meta name="robots"`);
  } else {
    html = html.replace(/<meta name="dealdesk-build" content="[^"]*" \/>/, `<meta name="dealdesk-build" content="${buildID}" />`);
  }
  if (!html.includes('rel="sitemap"')) {
    html = html.replace(/(<link rel="canonical"[^>]+>)/, `$1\n  <link rel="sitemap" type="application/xml" href="/sitemap.xml" />`);
  }
  if (!html.includes('/assets/indexing.css')) {
    html = html.replace('<link rel="stylesheet" href="/styles.css" />', `<link rel="stylesheet" href="/styles.css?v=${buildID}" />\n  <link rel="stylesheet" href="/assets/indexing.css?v=${buildID}" />`);
  }

  const breadcrumb = `<nav class="deal-breadcrumb" aria-label="Breadcrumb"><a href="/">DealDesk</a><span aria-hidden="true">›</span><a href="/deals/">All deals</a><span aria-hidden="true">›</span><a href="/category/${category.key}/">${esc(category.label)}</a><span aria-hidden="true">›</span><span>${esc(deal.title)}</span></nav>`;
  html = html.replace(/<nav class="deal-breadcrumb"[^>]*>.*?<\/nav>/s, breadcrumb);
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "DealDesk", item: `${site}/` },
      { "@type": "ListItem", position: 2, name: "All deals", item: `${site}/deals/` },
      { "@type": "ListItem", position: 3, name: category.label, item: `${site}/category/${category.key}/` },
      { "@type": "ListItem", position: 4, name: deal.title, item: absolute(dealPath(deal)) },
    ],
  };
  const breadcrumbScript = `  <script type="application/ld+json">${JSON.stringify(breadcrumbSchema).replaceAll("<", "\\u003c")}</script>`;
  html = html.replace(/\s*<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"BreadcrumbList"[\s\S]*?<\/script>/, `\n${breadcrumbScript}`);


  const facts = [
    ["Merchant", deal.merchant || "Merchant"],
    ["Category", category.label],
    ["Current price", deal.currentPrice || "See merchant"],
    deal.originalPrice ? [deal.referenceLabel || (deal.referenceStyle === "renewal" ? "Then" : "Reference"), deal.originalPrice] : null,
    deal.savingsText ? ["Displayed savings", deal.savingsText] : null,
    ["Condition", conditionFrom(deal)],
    deal.priceNote ? ["Important terms", deal.priceNote] : null,
    ["Checked", isoDate(deal.verifiedAt)],
  ].filter(Boolean);
  const discoveryLinks = [
    previous ? `<a href="${dealPath(previous)}">← Previous deal</a>` : "",
    `<a href="${pagePath("/deals/", archivePage)}">Archive page ${archivePage}</a>`,
    `<a href="/category/${category.key}/">More ${esc(category.label.toLowerCase())} deals</a>`,
    next ? `<a href="${dealPath(next)}">Next deal →</a>` : "",
  ].filter(Boolean).join("");
  const contextSection = `<section class="deal-indexing-context" aria-labelledby="deal-indexing-context-title">
    <div class="deal-indexing-copy"><span class="page-kicker"><span aria-hidden="true"></span> Deal context</span><h2 id="deal-indexing-context-title">What to know before you click</h2><p>${esc(contextFor(deal))}</p></div>
    <dl>${facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>
  </section>
  <nav class="deal-discovery-links" aria-label="Continue browsing">${discoveryLinks}</nav>`;
  html = html.replace(/\s*<section class="deal-more">/, `\n  ${contextSection}\n    <section class="deal-more">`);
  await writeFile(file, html);
}

const priorityCategories = [...categories].sort((a, b) => {
  const preferred = ["subscriptions", "streaming", "electronics", "home", "home-and-garden", "collectibles", "toys-and-hobbies", "business-and-industrial"];
  const left = preferred.indexOf(a.key);
  const right = preferred.indexOf(b.key);
  if (left !== -1 || right !== -1) return (left === -1 ? preferred.length : left) - (right === -1 ? preferred.length : right);
  return b.deals.length - a.deals.length;
});
const categoryHubCards = priorityCategories.slice(0, 8).map((category) => `<a class="crawl-category-card" href="/category/${category.key}/"><strong>${esc(categoryGuideFor(category).singular)} deals</strong><span>${category.deals.length} catalog records</span><small>Compare deals →</small></a>`).join("\n");
const priorityDealLinks = indexableDeals.slice(0, 12).map((deal) => `<a href="${dealPath(deal)}">${esc(deal.title)} <span>${esc(deal.currentPrice || "See terms")}</span></a>`).join("\n");
const homeHubSection = `<!-- INDEXING-HUBS:START -->
        <section class="indexing-hubs" id="browse-all-deals" aria-labelledby="indexing-hubs-title">
          <div class="indexing-hubs-heading"><div><span class="page-kicker"><span aria-hidden="true"></span> Complete catalog</span><h2 id="indexing-hubs-title">Browse the complete DealDesk catalog</h2></div><p>Static archive and category links make every listed record available without search, filters, or a load-more action.</p></div>
          <div class="crawl-hub-actions"><a href="/deals/">All ${deals.length} deals</a><a href="/categories/">All ${categories.length} categories</a></div>
          <div class="crawl-category-grid crawl-category-grid-home">${categoryHubCards}</div>
          <div class="priority-deal-links" aria-label="Priority deals">${priorityDealLinks}</div>
        </section>
        <!-- INDEXING-HUBS:END -->`;
let homeHTML = await readFile(resolve(root, "index.html"), "utf8");
if (!homeHTML.includes('/assets/indexing.css')) {
  homeHTML = homeHTML.replace(/(<link rel="stylesheet" href="\/styles\.css\?v=[^"]+" \/>)/, `$1\n    <link rel="stylesheet" href="/assets/indexing.css?v=${buildID}" />`);
}
homeHTML = homeHTML.replace(/<meta name="dealdesk-build" content="[^"]*" \/>/, `<meta name="dealdesk-build" content="${buildID}" />`);
if (!homeHTML.includes('>All deals</a>')) {
  homeHTML = homeHTML.replace('<a href="/latest-deals/">Latest deals</a>', '<a href="/latest-deals/">Latest deals</a>\n          <a href="/deals/">All deals</a>');
}
if (/<!-- INDEXING-HUBS:START -->[\s\S]*?<!-- INDEXING-HUBS:END -->/.test(homeHTML)) {
  homeHTML = homeHTML.replace(/<!-- INDEXING-HUBS:START -->[\s\S]*?<!-- INDEXING-HUBS:END -->/, homeHubSection);
} else {
  homeHTML = homeHTML.replace(/\s*<section class="deals-section"/, `\n        ${homeHubSection}\n\n        <section class="deals-section"`);
}
await writeFile(resolve(root, "index.html"), homeHTML);

const latestHubSection = `<section class="indexing-hubs latest-indexing-hubs" aria-labelledby="latest-indexing-hubs-title"><div class="indexing-hubs-heading"><div><span class="page-kicker"><span aria-hidden="true"></span> Crawlable paths</span><h2 id="latest-indexing-hubs-title">Continue through the complete catalog</h2></div><p>The interactive view stays fast, while static archive pages expose every listed record through ordinary links.</p></div><div class="crawl-hub-actions"><a href="/deals/">Browse all ${deals.length} deals</a><a href="/deals/page/2/">Continue to archive page 2</a><a href="/categories/">Browse categories</a></div></section>`;
let latestHTML = await readFile(resolve(root, "latest-deals", "index.html"), "utf8");
if (!latestHTML.includes('/assets/indexing.css')) {
  latestHTML = latestHTML.replace(/(<link rel="stylesheet" href="\/styles\.css\?v=[^"]+" \/>)/, `$1\n  <link rel="stylesheet" href="/assets/indexing.css?v=${buildID}" />`);
}
latestHTML = latestHTML.replace(/<meta name="dealdesk-build" content="[^"]*" \/>/, `<meta name="dealdesk-build" content="${buildID}" />`);
if (!latestHTML.includes('>All deals</a>')) {
  latestHTML = latestHTML.replace('<a href="/latest-deals/" aria-current="page">Latest deals</a>', '<a href="/latest-deals/" aria-current="page">Latest deals</a><a href="/deals/">All deals</a>');
}
latestHTML = latestHTML.replace(/\s*<\/main>\s*<footer class="footer">/, `\n    ${latestHubSection}\n  </main>\n  <footer class="footer">`);
await writeFile(resolve(root, "latest-deals", "index.html"), latestHTML);

const xml = (value) => esc(value).replaceAll("&#39;", "&apos;");
const writeUrlset = async (filename, records) => {
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${records.map((record) => `  <url><loc>${xml(absolute(record.path))}</loc><lastmod>${record.lastmod}</lastmod></url>`).join("\n")}\n</urlset>\n`;
  await writeFile(resolve(root, filename), content);
};

const archivePageRecords = archivePages.map((pageDeals, index) => ({
  path: pagePath("/deals/", index + 1),
  lastmod: newestVerifiedDate(pageDeals),
  indexable: index === 0,
}));
const pageRecords = [
  { path: "/", lastmod: buildLastmod },
  { path: "/latest-deals/", lastmod: buildLastmod },
  { path: "/categories/", lastmod: buildLastmod },
  { path: "/privacy/", lastmod: buildLastmod },
  { path: "/support/", lastmod: buildLastmod },
  ...archivePageRecords.filter((record) => record.indexable),
  ...categoryPageRecords.filter((record) => record.indexable),
];
await writeUrlset("sitemap-pages.xml", pageRecords);
await writeUrlset("sitemap-deals-priority.xml", indexableDeals.slice(0, priorityDealCount).map((deal) => ({
  path: dealPath(deal),
  lastmod: isoDate(deal.verifiedAt),
})));

const remainingChunks = chunk(indexableDeals.slice(priorityDealCount), sitemapDealChunkSize);
const rootFiles = await readdir(root);
for (const filename of rootFiles) {
  if (/^sitemap-deals-\d+\.xml$/.test(filename)) await rm(resolve(root, filename), { force: true });
}
const dealSitemapFiles = [];
for (let index = 0; index < remainingChunks.length; index += 1) {
  const filename = `sitemap-deals-${index + 1}.xml`;
  await writeUrlset(filename, remainingChunks[index].map((deal) => ({
    path: dealPath(deal),
    lastmod: isoDate(deal.verifiedAt),
  })));
  dealSitemapFiles.push(filename);
}

const sitemapFiles = ["sitemap-pages.xml", "sitemap-deals-priority.xml", ...dealSitemapFiles];
const sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapFiles.map((filename) => `  <sitemap><loc>${site}/${filename}</loc><lastmod>${buildLastmod}</lastmod></sitemap>`).join("\n")}\n</sitemapindex>\n`;
await writeFile(resolve(root, "sitemap.xml"), sitemapIndex);
await writeFile(resolve(root, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /out/\n\nSitemap: ${site}/sitemap.xml\n`);

const linkedFromArchive = new Set(archivePages.flat().map((deal) => deal.id));
const linkedFromCategory = new Set(categories.flatMap((category) => category.deals).map((deal) => deal.id));
const report = {
  build: buildID,
  generatedAt: new Date().toISOString(),
  catalogUpdatedAt: latestCatalog.updatedAt,
  publicDeals: deals.length,
  indexableDeals: indexableDeals.length,
  browseOnlyDeals: deals.length - indexableDeals.length,
  archivePages: archivePages.length,
  indexableArchivePages: archivePageRecords.filter((record) => record.indexable).length,
  categories: categories.length,
  categoryPages: categoryPageRecords.length,
  indexableCategoryPages: categoryPageRecords.filter((record) => record.indexable).length,
  prioritySitemapDeals: Math.min(priorityDealCount, indexableDeals.length),
  sitemapFiles,
  orphanDeals: deals.filter((deal) => !linkedFromArchive.has(deal.id) || !linkedFromCategory.has(deal.id)).map((deal) => deal.id),
};
await writeFile(resolve(root, "data", "indexing-report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(root, "deploy-version.json"), `${JSON.stringify({
  build: buildID,
  catalogOffers: deals.length,
  indexableOffers: indexableDeals.length,
  archivePages: archivePages.length,
  categoryPages: categoryPageRecords.length,
  sitemapFiles,
  generatedAt: report.generatedAt,
}, null, 2)}\n`);

console.log(`Built crawl architecture for ${deals.length} browseable deals (${indexableDeals.length} indexable): ${archivePages.length} archive pages, ${categoryPageRecords.length} category pages, ${sitemapFiles.length} child sitemaps, and ${report.orphanDeals.length} orphan deals.`);
