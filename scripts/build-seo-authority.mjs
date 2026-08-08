import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = "https://dealdesk.fyi";
const buildID = "2026-08-08-authority-v1";
const merchantPageSize = 32;
const maxComparisonPages = 80;

const [latestCatalog, ...sourceFeeds] = await Promise.all([
  readFile(resolve(root, "data/latest-deals.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/best-deals.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/streaming-deals.json"), "utf8").then(JSON.parse),
]);

const deals = Array.isArray(latestCatalog.deals) ? latestCatalog.deals : [];
if (!deals.length) throw new Error("data/latest-deals.json does not contain public deals");

const sourceByID = new Map(sourceFeeds.flatMap((feed) => feed.deals || []).map((deal) => [deal.id, deal]));
const catalogUpdatedAt = new Date(latestCatalog.updatedAt || Date.now());
const buildDate = Number.isNaN(catalogUpdatedAt.getTime())
  ? new Date().toISOString().slice(0, 10)
  : catalogUpdatedAt.toISOString().slice(0, 10);

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const xml = (value) => esc(value).replaceAll("&#39;", "&apos;");
const csv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const slugify = (value) => String(value || "other").toLowerCase()
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "") || "other";
const cleanTitle = (value) => String(value || "Deal")
  .replace(/\s+[—–-]\s+(?:up to\s+)?\d+%\s+off\s*$/i, "")
  .replace(/\s+/g, " ")
  .trim();
const truncate = (value, limit) => {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  const clipped = text.slice(0, Math.max(0, limit - 1));
  const boundary = clipped.lastIndexOf(" ");
  return `${(boundary > limit * 0.62 ? clipped.slice(0, boundary) : clipped).trim()}…`;
};
const moneyNumber = (value) => {
  const number = Number(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : NaN;
};
const isMoney = (value) => /^\s*(?:US)?\$\s*\d/.test(String(value || ""));
const isoDate = (value) => {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? buildDate : date.toISOString().slice(0, 10);
};
const dealPath = (deal) => String(deal.url || `/deals/${slugify(deal.id)}/`);
const absolute = (path) => `${site}${path}`;
const pagePath = (basePath, page) => page === 1 ? basePath : `${basePath}page/${page}/`;
const pageOutput = (baseDirectory, page) => page === 1
  ? resolve(baseDirectory, "index.html")
  : resolve(baseDirectory, "page", String(page), "index.html");
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
  items.slice(index * size, (index + 1) * size)
);
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const money = (value) => Number.isFinite(value)
  ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value)
  : "Not available";
const merchantName = (deal) => String(deal.merchant || sourceByID.get(deal.id)?.merchantName || "Merchant").trim();
const conditionFrom = (deal) => {
  const text = `${deal.priceNote || ""} ${sourceByID.get(deal.id)?.summary || ""}`.toLowerCase();
  if (text.includes("certified refurbished")) return "Certified refurbished";
  if (text.includes("refurbished")) return "Refurbished";
  if (text.includes("open box")) return "Open box";
  if (/\bpre-owned\b/.test(text)) return "Pre-owned";
  if (/\bused\b/.test(text)) return "Used";
  if (/\bnew\b/.test(text)) return "New";
  return "Not stated";
};
const discountFrom = (deal) => {
  for (const text of [deal.badgeText, deal.savingsText]) {
    const match = String(text || "").match(/(\d{1,3})%\s*off/i);
    if (match) return Math.min(100, Number(match[1]));
  }
  if (deal.referenceStyle === "renewal") return 0;
  const current = moneyNumber(deal.currentPrice);
  const original = moneyNumber(deal.originalPrice);
  return Number.isFinite(current) && Number.isFinite(original) && original > current && original > 0
    ? Math.max(0, Math.min(100, Math.round((1 - current / original) * 100)))
    : 0;
};
const freshnessDays = (deal) => {
  const checked = new Date(deal.verifiedAt || 0).getTime();
  const reference = Number.isNaN(catalogUpdatedAt.getTime()) ? Date.now() : catalogUpdatedAt.getTime();
  return Number.isFinite(checked) ? Math.max(0, Math.floor((reference - checked) / 86400000)) : 9999;
};

const tokenStopwords = new Set([
  "the", "and", "for", "with", "from", "this", "that", "new", "brand", "sale", "deal", "free", "shipping",
  "certified", "refurbished", "renewed", "used", "pre", "owned", "open", "box", "black", "white", "silver",
  "blue", "green", "red", "purple", "gray", "grey", "good", "very", "excellent", "condition", "unlocked",
  "factory", "sealed", "pack", "piece", "pieces", "set", "kit", "edition", "model", "includes", "only",
  "inch", "inches", "windows", "pro", "home", "audio", "wireless", "system", "plus", "max"
]);
const modelTokens = (value) => cleanTitle(value).toLowerCase()
  .replace(/([a-z])([0-9])/g, "$1 $2")
  .replace(/([0-9])([a-z])/g, "$1 $2")
  .split(/[^a-z0-9+]+/)
  .filter((token) => token && !tokenStopwords.has(token) && token.length > 1);
const tokenSetByID = new Map(deals.map((deal) => [deal.id, new Set(modelTokens(deal.title))]));
const jaccard = (left, right) => {
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union ? intersection / union : 0;
};

const familyPatterns = [
  /\bSamsung Galaxy\s+(?:S\d{1,2}(?:\s*(?:Ultra|Plus|\+))?|A\d{1,2}|Z\s*(?:Fold|Flip)\s*\d)\b/i,
  /\b(?:Apple\s+)?iPhone\s+\d{1,2}(?:\s*(?:Pro Max|Pro|Plus|Mini))?\b/i,
  /\b(?:Apple\s+)?MacBook\s+(?:Air|Pro)(?:\s+\d{2}(?:\.\d)?(?:-inch|\"|”|″)?)?\b/i,
  /\bLenovo ThinkPad\s+(?:[A-Z]\d{2,4}[A-Za-z]?|T\d{2,3}s?(?:\s+Gen\s+\d)?|X\d{2,3}(?:\s+Gen\s+\d)?|L\d{2,3}(?:\s+Gen\s+\d)?)\b/i,
  /\bDell Latitude\s+\d{4}\b/i,
  /\bHP EliteBook\s+(?:x360\s+)?\d{3,4}(?:\s+[A-Z]\d)?\b/i,
  /\bAcer\s+(?:Predator|Aspire|Nitro|Vero|TravelMate|Enduro)\s+[A-Za-z0-9-]+\b/i,
  /\bDyson\s+V\d{1,2}\b/i,
  /\bRoborock\s+(?:Qrevo|S\d|Q\d)[A-Za-z0-9-]*\b/i,
  /\bLevoit\s+Core\s+\d+[A-Za-z0-9-]*\b/i,
  /\bMakita\s+[A-Z]{1,4}\d[A-Z0-9-]*\b/i,
  /\bArlo\s+[A-Z]{1,5}\d[A-Z0-9-]*\b/i,
  /\bJBL\s+[A-Z]{1,6}\d[A-Z0-9-]*\b/i,
  /\bSony\s+(?:WH|WF|HT|SRS)-?[A-Z0-9-]+\b/i,
];
const familyCandidate = (deal) => {
  const title = cleanTitle(deal.title);
  for (const pattern of familyPatterns) {
    const match = title.match(pattern);
    if (match) {
      const label = match[0].replace(/\s+/g, " ").trim();
      return { key: slugify(label), label, confidence: "pattern" };
    }
  }
  const tokens = modelTokens(title);
  if (!tokens.some((token) => /\d/.test(token))) return null;
  const selected = tokens.slice(0, 4);
  if (selected.length < 3) return null;
  const label = selected.map((token) => token.length <= 3 ? token.toUpperCase() : `${token[0].toUpperCase()}${token.slice(1)}`).join(" ");
  return { key: slugify(selected.join("-")), label, confidence: "fallback" };
};

const familyCandidates = new Map();
for (const deal of deals) {
  const candidate = familyCandidate(deal);
  if (!candidate) continue;
  if (!familyCandidates.has(candidate.key)) familyCandidates.set(candidate.key, { ...candidate, deals: [] });
  familyCandidates.get(candidate.key).deals.push(deal);
}
const families = [...familyCandidates.values()]
  .filter((family) => family.deals.length >= (family.confidence === "pattern" ? 2 : 3))
  .sort((a, b) => b.deals.length - a.deals.length || a.label.localeCompare(b.label))
  .slice(0, maxComparisonPages);
const familyByDealID = new Map();
for (const family of families) for (const deal of family.deals) familyByDealID.set(deal.id, family);

const baseScoreFor = (deal) => {
  let score = 25;
  if (isMoney(deal.currentPrice)) score += 12;
  if (isMoney(deal.originalPrice)) score += 8;
  const discount = discountFrom(deal);
  if (discount >= 50) score += 12;
  else if (discount >= 25) score += 8;
  else if (discount > 0) score += 4;
  const age = freshnessDays(deal);
  if (age <= 7) score += 12;
  else if (age <= 30) score += 8;
  else if (age <= 90) score += 4;
  if (conditionFrom(deal) !== "Not stated") score += 6;
  if (deal.priceNote) score += 5;
  const summary = String(sourceByID.get(deal.id)?.summary || "").trim();
  if (summary.length >= 80) score += 7;
  if (/free shipping/i.test(String(deal.priceNote || ""))) score += 3;
  if (familyByDealID.has(deal.id)) score += 10;
  return Math.min(100, score);
};
const scoreByID = new Map(deals.map((deal) => [deal.id, baseScoreFor(deal)]));

const statsFor = (items) => {
  const prices = items.map((deal) => moneyNumber(deal.currentPrice)).filter(Number.isFinite);
  const discounts = items.map(discountFrom).filter((value) => value > 0);
  const categories = new Set(items.map((deal) => deal.categoryLabel || deal.category || "Other"));
  const conditions = new Map();
  for (const deal of items) {
    const condition = conditionFrom(deal);
    conditions.set(condition, (conditions.get(condition) || 0) + 1);
  }
  const sortedByScore = [...items].sort((a, b) => scoreByID.get(b.id) - scoreByID.get(a.id));
  return {
    count: items.length,
    lowestPrice: prices.length ? Math.min(...prices) : NaN,
    highestPrice: prices.length ? Math.max(...prices) : NaN,
    medianPrice: median(prices),
    medianDiscount: median(discounts),
    maxDiscount: discounts.length ? Math.max(...discounts) : 0,
    categories: [...categories].sort(),
    conditions: [...conditions.entries()].sort((a, b) => b[1] - a[1]),
    newestCheck: items.map((deal) => isoDate(deal.verifiedAt)).sort().at(-1) || buildDate,
    bestDeal: sortedByScore[0] || null,
  };
};

const merchantGroups = new Map();
for (const deal of deals) {
  const name = merchantName(deal);
  const key = slugify(name);
  if (!merchantGroups.has(key)) merchantGroups.set(key, { key, name, deals: [], direct: false });
  const group = merchantGroups.get(key);
  group.deals.push(deal);
  const network = String(sourceByID.get(deal.id)?.network || "");
  if (network && !["amazon-associates", "ebay-partner-network"].includes(network)) group.direct = true;
}
const merchants = [...merchantGroups.values()]
  .filter((merchant) => merchant.deals.length >= 2 || merchant.direct)
  .sort((a, b) => b.deals.length - a.deals.length || a.name.localeCompare(b.name));
const merchantByDealID = new Map();
for (const merchant of merchants) for (const deal of merchant.deals) merchantByDealID.set(deal.id, merchant);

const comparisonFor = (deal) => {
  const family = familyByDealID.get(deal.id);
  if (family) {
    return family.deals
      .filter((candidate) => candidate.id !== deal.id)
      .sort((a, b) => {
        const left = moneyNumber(a.currentPrice);
        const right = moneyNumber(b.currentPrice);
        if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
        return scoreByID.get(b.id) - scoreByID.get(a.id);
      })
      .slice(0, 6);
  }
  const tokens = tokenSetByID.get(deal.id) || new Set();
  return deals
    .filter((candidate) => candidate.id !== deal.id && candidate.category === deal.category)
    .map((candidate) => ({ candidate, similarity: jaccard(tokens, tokenSetByID.get(candidate.id) || new Set()) }))
    .filter(({ similarity }) => similarity >= 0.22)
    .sort((a, b) => b.similarity - a.similarity || scoreByID.get(b.candidate.id) - scoreByID.get(a.candidate.id))
    .slice(0, 4)
    .map(({ candidate }) => candidate);
};

const pricePositionFor = (deal, comparable) => {
  const items = [deal, ...comparable].filter((item) => Number.isFinite(moneyNumber(item.currentPrice)));
  if (items.length < 2 || !Number.isFinite(moneyNumber(deal.currentPrice))) return null;
  const sorted = [...items].sort((a, b) => moneyNumber(a.currentPrice) - moneyNumber(b.currentPrice));
  const rank = sorted.findIndex((item) => item.id === deal.id) + 1;
  const prices = sorted.map((item) => moneyNumber(item.currentPrice));
  const med = median(prices);
  const current = moneyNumber(deal.currentPrice);
  const delta = Number.isFinite(med) && med > 0 ? Math.round(((current - med) / med) * 100) : 0;
  return { rank, total: sorted.length, median: med, delta };
};

const verdictFor = (deal, comparable) => {
  const parts = [];
  const discount = discountFrom(deal);
  const position = pricePositionFor(deal, comparable);
  if (position?.rank === 1) parts.push(`It is the lowest displayed price among ${position.total} closely related offers currently compared by DealDesk.`);
  else if (position && position.delta < 0) parts.push(`Its displayed price is ${Math.abs(position.delta)}% below the median of ${position.total} closely related offers.`);
  else if (position && position.delta > 0) parts.push(`Its displayed price is ${position.delta}% above the median of ${position.total} closely related offers, so condition and included terms matter.`);
  if (discount >= 50) parts.push(`The page shows a ${discount}% discount against the stated reference, which is a strong price signal but should still be confirmed at checkout.`);
  else if (discount > 0) parts.push(`The page shows a ${discount}% discount against the stated reference.`);
  if (deal.referenceStyle === "renewal") parts.push("This is an introductory price; the renewal amount is more important than the headline monthly rate.");
  const condition = conditionFrom(deal);
  if (condition !== "Not stated") parts.push(`The merchant describes the condition as ${condition.toLowerCase()}, which can explain part of the price difference.`);
  if (!parts.length) parts.push("The strongest evidence is the verified current price, merchant destination, and check date rather than an unverified popularity claim.");
  return parts.join(" ");
};

const targetFor = (deal) => {
  const title = cleanTitle(deal.title);
  const merchant = merchantName(deal);
  return {
    primary: `${title} deal`,
    secondary: [`${title} price`, `${title} discount`, `${merchant} ${title}`],
  };
};

const header = (current = "") => `<header class="site-header"><nav class="nav shell" aria-label="Primary navigation"><a class="brand" href="/" aria-label="DealDesk home"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><div class="nav-links"><a href="/latest-deals/"${current === "latest" ? ' aria-current="page"' : ""}>Latest deals</a><a href="/deals/"${current === "deals" ? ' aria-current="page"' : ""}>All deals</a><a href="/categories/"${current === "categories" ? ' aria-current="page"' : ""}>Categories</a><a href="/deal-index/"${current === "index" ? ' aria-current="page"' : ""}>Deal Index</a></div></nav></header>`;
const footer = `<footer class="footer"><div class="shell footer-inner"><a class="brand footer-brand" href="/"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><p>Verified prices. Better decisions.</p><div class="footer-links"><a href="/deals/">All deals</a><a href="/merchants/">Merchants</a><a href="/comparisons/">Comparisons</a><a href="/deal-index/">Deal Index</a><a href="/how-we-rank-deals/">Methodology</a><a href="/editorial-policy/">Editorial policy</a><a href="/about/">About</a></div></div><div class="shell disclosure">DealDesk may earn a commission when you buy through our links. Prices and availability can change at checkout.</div></footer>`;
const head = ({ title, description, canonicalPath, schema = [], bodyClass = "" }) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
  <meta name="dealdesk-seo" content="${buildID}" />
  <link rel="canonical" href="${absolute(canonicalPath)}" />
  <link rel="sitemap" type="application/xml" href="/sitemap.xml" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${absolute(canonicalPath)}" />
  <meta property="og:image" content="${site}/assets/dealdesk-publisher-logo.png" />
  <meta name="twitter:card" content="summary" />
  <link rel="icon" type="image/png" href="/assets/dealdesk-publisher-logo.png" />
  <link rel="stylesheet" href="/styles.css?v=${buildID}" />
  <link rel="stylesheet" href="/assets/indexing.css?v=${buildID}" />
  <link rel="stylesheet" href="/assets/seo-authority.css?v=${buildID}" />
${schema.map((entry) => `  <script type="application/ld+json">${JSON.stringify(entry).replaceAll("<", "\\u003c")}</script>`).join("\n")}
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ""}>`;
const pageEnd = `</body>\n</html>\n`;

const card = (deal, eager = false) => `<article class="deal-card authority-card">
  <a class="deal-card-link" href="${esc(dealPath(deal))}">
    <span class="deal-media">${deal.badgeText ? `<span class="discount-badge">${esc(deal.badgeText)}</span>` : ""}<img src="${esc(deal.imageURL)}" alt="${esc(deal.title)}" width="800" height="520" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" /></span>
    <span class="deal-body"><span class="price-line"><strong>${esc(deal.currentPrice || "See terms")}</strong>${deal.originalPrice ? `<span class="original-price">${esc(deal.referenceLabel || "Was")} ${deal.referenceStyle === "renewal" ? esc(deal.originalPrice) : `<del>${esc(deal.originalPrice)}</del>`}</span>` : ""}</span>${deal.savingsText ? `<span class="saving-text">${esc(deal.savingsText)}</span>` : ""}<strong class="deal-title">${esc(deal.title)}</strong><span class="deal-meta">${esc(merchantName(deal))} · Score ${scoreByID.get(deal.id)}/100 · Checked ${esc(isoDate(deal.verifiedAt))}</span><span class="deal-cta">Analyze deal</span></span>
  </a>
</article>`;

const authorityRoot = resolve(root, "merchant");
const merchantsIndexRoot = resolve(root, "merchants");
const comparisonRoot = resolve(root, "compare");
const comparisonsIndexRoot = resolve(root, "comparisons");
await rm(authorityRoot, { recursive: true, force: true });
await rm(merchantsIndexRoot, { recursive: true, force: true });
await rm(comparisonRoot, { recursive: true, force: true });
await rm(comparisonsIndexRoot, { recursive: true, force: true });

const authorityPageRecords = [];
const merchantPageRecords = [];
const comparisonPageRecords = [];

await mkdir(merchantsIndexRoot, { recursive: true });
const merchantIndexDescription = `Browse ${merchants.length} merchant hubs covering ${deals.length} current DealDesk offers, with verified prices, discounts, conditions, and update dates.`;
const merchantIndexSchema = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "Deal merchants",
  url: `${site}/merchants/`,
  dateModified: buildDate,
  mainEntity: {
    "@type": "ItemList",
    numberOfItems: merchants.length,
    itemListElement: merchants.map((merchant, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: merchant.name,
      url: `${site}/merchant/${merchant.key}/`,
    })),
  },
};
const merchantIndexHTML = `${head({ title: "Deal merchants: verified offers by store | DealDesk", description: merchantIndexDescription, canonicalPath: "/merchants/", schema: [merchantIndexSchema], bodyClass: "authority-page" })}
${header("merchants")}
<main class="deal-home shell authority-shell"><nav class="deal-breadcrumb"><a href="/">DealDesk</a><span>›</span><span>Merchants</span></nav><header class="authority-hero"><span class="page-kicker"><span></span> Merchant intelligence</span><h1>Verified deals by merchant</h1><p>${esc(merchantIndexDescription)}</p></header><div class="authority-directory">${merchants.map((merchant) => { const stats = statsFor(merchant.deals); return `<a href="/merchant/${merchant.key}/"><strong>${esc(merchant.name)}</strong><span>${merchant.deals.length} ${merchant.deals.length === 1 ? "offer" : "offers"}</span><small>${stats.maxDiscount ? `Up to ${stats.maxDiscount}% off` : `Checked ${stats.newestCheck}`}</small></a>`; }).join("\n")}</div></main>
${footer}
${pageEnd}`;
await writeFile(resolve(merchantsIndexRoot, "index.html"), merchantIndexHTML);
authorityPageRecords.push({ path: "/merchants/", lastmod: buildDate });

for (const merchant of merchants) {
  const sortedDeals = [...merchant.deals].sort((a, b) => scoreByID.get(b.id) - scoreByID.get(a.id));
  const pages = chunks(sortedDeals, merchantPageSize);
  const stats = statsFor(sortedDeals);
  const basePath = `/merchant/${merchant.key}/`;
  const directory = resolve(authorityRoot, merchant.key);
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pageIndex + 1;
    const pageDeals = pages[pageIndex];
    const canonicalPath = pagePath(basePath, page);
    const title = page === 1
      ? `Best ${merchant.name} deals today: verified prices | DealDesk`
      : `${merchant.name} deals – Page ${page} | DealDesk`;
    const description = `Compare ${merchant.deals.length} verified ${merchant.name} offers across ${stats.categories.length} ${stats.categories.length === 1 ? "category" : "categories"}. ${Number.isFinite(stats.lowestPrice) ? `Prices start at ${money(stats.lowestPrice)}.` : ""} Checked ${stats.newestCheck}.`;
    const schema = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: title.replace(" | DealDesk", ""),
      url: absolute(canonicalPath),
      dateModified: stats.newestCheck,
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: pageDeals.length,
        itemListElement: pageDeals.map((deal, index) => ({
          "@type": "ListItem",
          position: pageIndex * merchantPageSize + index + 1,
          name: deal.title,
          url: absolute(dealPath(deal)),
        })),
      },
    };
    const pagination = pages.length > 1 ? `<nav class="crawl-pagination" aria-label="Merchant pagination"><div>${page > 1 ? `<a href="${pagePath(basePath, page - 1)}">← Previous</a>` : ""}</div><div class="crawl-pagination-pages">${pages.map((_, index) => index + 1 === page ? `<span aria-current="page">${index + 1}</span>` : `<a href="${pagePath(basePath, index + 1)}">${index + 1}</a>`).join("")}</div><div>${page < pages.length ? `<a href="${pagePath(basePath, page + 1)}">Next →</a>` : ""}</div></nav>` : "";
    const html = `${head({ title, description, canonicalPath, schema: [schema], bodyClass: "authority-page" })}
${header("merchants")}
<main class="deal-home shell authority-shell"><nav class="deal-breadcrumb"><a href="/">DealDesk</a><span>›</span><a href="/merchants/">Merchants</a><span>›</span><span>${esc(merchant.name)}</span>${page > 1 ? `<span>›</span><span>Page ${page}</span>` : ""}</nav><header class="authority-hero"><span class="page-kicker"><span></span> ${esc(merchant.name)}</span><h1>${page === 1 ? `Best ${esc(merchant.name)} deals today` : `${esc(merchant.name)} deals – Page ${page}`}</h1><p>${esc(description)}</p></header><section class="authority-stat-grid"><article><strong>${merchant.deals.length}</strong><span>current offers</span></article><article><strong>${Number.isFinite(stats.medianPrice) ? money(stats.medianPrice) : "Varies"}</strong><span>median displayed price</span></article><article><strong>${stats.maxDiscount ? `${stats.maxDiscount}%` : "—"}</strong><span>largest displayed discount</span></article><article><strong>${stats.newestCheck}</strong><span>latest verification</span></article></section><p class="authority-explainer">DealDesk ranks these offers with an objective score based on price clarity, displayed savings, freshness, terms, condition, and comparison depth. <a href="/how-we-rank-deals/">See the methodology.</a></p>${pagination}<div class="deal-grid authority-grid">${pageDeals.map((deal, index) => card(deal, page === 1 && index === 0)).join("\n")}</div>${pagination}</main>
${footer}
${pageEnd}`;
    const output = pageOutput(directory, page);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, html);
    const record = { path: canonicalPath, lastmod: stats.newestCheck };
    merchantPageRecords.push(record);
    authorityPageRecords.push(record);
  }
}

await mkdir(comparisonsIndexRoot, { recursive: true });
const comparisonIndexDescription = `Compare prices, condition, savings, and freshness across ${families.length} groups of closely related DealDesk offers.`;
const comparisonIndexSchema = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "Deal comparisons",
  url: `${site}/comparisons/`,
  dateModified: buildDate,
  mainEntity: {
    "@type": "ItemList",
    numberOfItems: families.length,
    itemListElement: families.map((family, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: `${family.label} deals compared`,
      url: `${site}/compare/${family.key}/`,
    })),
  },
};
const comparisonIndexHTML = `${head({ title: "Compare similar deals: prices, condition and savings | DealDesk", description: comparisonIndexDescription, canonicalPath: "/comparisons/", schema: [comparisonIndexSchema], bodyClass: "authority-page" })}
${header("comparisons")}
<main class="deal-home shell authority-shell"><nav class="deal-breadcrumb"><a href="/">DealDesk</a><span>›</span><span>Comparisons</span></nav><header class="authority-hero"><span class="page-kicker"><span></span> Side-by-side analysis</span><h1>Compare similar deals</h1><p>${esc(comparisonIndexDescription)}</p></header><div class="authority-directory">${families.map((family) => { const stats = statsFor(family.deals); return `<a href="/compare/${family.key}/"><strong>${esc(family.label)}</strong><span>${family.deals.length} related offers</span><small>${Number.isFinite(stats.lowestPrice) ? `${money(stats.lowestPrice)}–${money(stats.highestPrice)}` : `Checked ${stats.newestCheck}`}</small></a>`; }).join("\n")}</div></main>
${footer}
${pageEnd}`;
await writeFile(resolve(comparisonsIndexRoot, "index.html"), comparisonIndexHTML);
authorityPageRecords.push({ path: "/comparisons/", lastmod: buildDate });

for (const family of families) {
  const sortedDeals = [...family.deals].sort((a, b) => {
    const left = moneyNumber(a.currentPrice);
    const right = moneyNumber(b.currentPrice);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
    return scoreByID.get(b.id) - scoreByID.get(a.id);
  });
  const stats = statsFor(sortedDeals);
  const canonicalPath = `/compare/${family.key}/`;
  const title = `${family.label} deals compared: prices and savings | DealDesk`;
  const description = `Compare ${family.deals.length} ${family.label} offers by displayed price, condition, savings, merchant, and verification date. ${Number.isFinite(stats.lowestPrice) ? `Prices start at ${money(stats.lowestPrice)}.` : ""}`;
  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${family.label} deals compared`,
    url: absolute(canonicalPath),
    dateModified: stats.newestCheck,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: sortedDeals.length,
      itemListElement: sortedDeals.map((deal, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: deal.title,
        url: absolute(dealPath(deal)),
      })),
    },
  };
  const rows = sortedDeals.map((deal, index) => `<tr><td><a href="${dealPath(deal)}">${esc(deal.title)}</a></td><td>${esc(deal.currentPrice || "See terms")}</td><td>${esc(conditionFrom(deal))}</td><td>${discountFrom(deal) ? `${discountFrom(deal)}%` : "—"}</td><td>${esc(merchantName(deal))}</td><td>${esc(isoDate(deal.verifiedAt))}</td><td>${scoreByID.get(deal.id)}/100</td></tr>`).join("\n");
  const html = `${head({ title, description, canonicalPath, schema: [schema], bodyClass: "authority-page" })}
${header("comparisons")}
<main class="deal-home shell authority-shell"><nav class="deal-breadcrumb"><a href="/">DealDesk</a><span>›</span><a href="/comparisons/">Comparisons</a><span>›</span><span>${esc(family.label)}</span></nav><header class="authority-hero"><span class="page-kicker"><span></span> Product-family comparison</span><h1>Compare ${esc(family.label)} deals</h1><p>${esc(description)}</p></header><section class="authority-stat-grid"><article><strong>${family.deals.length}</strong><span>related offers</span></article><article><strong>${Number.isFinite(stats.lowestPrice) ? money(stats.lowestPrice) : "Varies"}</strong><span>lowest displayed price</span></article><article><strong>${Number.isFinite(stats.medianPrice) ? money(stats.medianPrice) : "Varies"}</strong><span>median displayed price</span></article><article><strong>${stats.maxDiscount ? `${stats.maxDiscount}%` : "—"}</strong><span>largest displayed discount</span></article></section><section class="authority-analysis"><h2>What the comparison shows</h2><p>${Number.isFinite(stats.lowestPrice) ? `The displayed price range runs from ${money(stats.lowestPrice)} to ${money(stats.highestPrice)}, with a median of ${money(stats.medianPrice)}.` : "Some offers use non-standard or subscription pricing, so compare the full billing terms."} ${stats.conditions.length > 1 ? `Condition varies across ${stats.conditions.map(([condition, count]) => `${count} ${condition.toLowerCase()}`).join(", ")}.` : "Condition is broadly consistent across these listings."} DealDesk does not treat a high reference-price discount as proof of product quality.</p></section><div class="authority-table-wrap"><table class="authority-table"><thead><tr><th>Offer</th><th>Price</th><th>Condition</th><th>Discount</th><th>Merchant</th><th>Checked</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table></div><div class="deal-grid authority-grid">${sortedDeals.map((deal, index) => card(deal, index === 0)).join("\n")}</div><p class="authority-explainer">Compare exact model, storage, size, accessories, warranty, shipping, renewal terms, and return policy before buying. <a href="/how-we-rank-deals/">How DealDesk scores offers.</a></p></main>
${footer}
${pageEnd}`;
  const output = resolve(comparisonRoot, family.key, "index.html");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html);
  const record = { path: canonicalPath, lastmod: stats.newestCheck };
  comparisonPageRecords.push(record);
  authorityPageRecords.push(record);
}

const overallStats = statsFor(deals);
const categoryGroups = new Map();
for (const deal of deals) {
  const label = deal.categoryLabel || deal.category || "Other";
  if (!categoryGroups.has(label)) categoryGroups.set(label, []);
  categoryGroups.get(label).push(deal);
}
const categoryStats = [...categoryGroups.entries()].map(([label, items]) => ({ label, key: slugify(label), ...statsFor(items) }))
  .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
const merchantStats = merchants.map((merchant) => ({ name: merchant.name, key: merchant.key, ...statsFor(merchant.deals) }));
const dealIndexJSON = {
  name: "DealDesk Deal Index",
  updatedAt: latestCatalog.updatedAt,
  generatedAt: new Date().toISOString(),
  publicDeals: deals.length,
  merchants: merchants.length,
  categories: categoryStats.length,
  medianDisplayedPrice: Number.isFinite(overallStats.medianPrice) ? overallStats.medianPrice : null,
  medianDisplayedDiscountPercent: Number.isFinite(overallStats.medianDiscount) ? Math.round(overallStats.medianDiscount * 10) / 10 : null,
  categoryStats: categoryStats.map((entry) => ({
    category: entry.label,
    count: entry.count,
    lowestDisplayedPrice: Number.isFinite(entry.lowestPrice) ? entry.lowestPrice : null,
    medianDisplayedPrice: Number.isFinite(entry.medianPrice) ? entry.medianPrice : null,
    maximumDisplayedDiscountPercent: entry.maxDiscount,
    latestVerification: entry.newestCheck,
  })),
};
await writeFile(resolve(root, "data", "dealdesk-deal-index.json"), `${JSON.stringify(dealIndexJSON, null, 2)}\n`);
const dealIndexCSV = [
  ["deal_id", "title", "url", "merchant", "category", "current_price", "original_price", "displayed_discount_percent", "condition", "verified_at", "dealdesk_value_score"].map(csv).join(","),
  ...deals.map((deal) => [deal.id, deal.title, absolute(dealPath(deal)), merchantName(deal), deal.categoryLabel || deal.category || "Other", deal.currentPrice || "", deal.originalPrice || "", discountFrom(deal) || "", conditionFrom(deal), isoDate(deal.verifiedAt), scoreByID.get(deal.id)].map(csv).join(",")),
].join("\n");
await writeFile(resolve(root, "data", "dealdesk-deal-index.csv"), `${dealIndexCSV}\n`);

const dealIndexPath = "/deal-index/";
const datasetSchema = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "DealDesk Deal Index",
  description: "A current catalog-level dataset of verified DealDesk offer prices, displayed discounts, merchants, categories, conditions, and verification dates.",
  url: `${site}${dealIndexPath}`,
  dateModified: buildDate,
  creator: { "@type": "Organization", name: "DealDesk", url: site },
  distribution: [
    { "@type": "DataDownload", encodingFormat: "text/csv", contentUrl: `${site}/data/dealdesk-deal-index.csv` },
    { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${site}/data/dealdesk-deal-index.json` },
  ],
};
const categoryRows = categoryStats.map((entry) => `<tr><td><a href="/category/${entry.key}/">${esc(entry.label)}</a></td><td>${entry.count}</td><td>${Number.isFinite(entry.lowestPrice) ? money(entry.lowestPrice) : "Varies"}</td><td>${Number.isFinite(entry.medianPrice) ? money(entry.medianPrice) : "Varies"}</td><td>${entry.maxDiscount ? `${entry.maxDiscount}%` : "—"}</td><td>${entry.newestCheck}</td></tr>`).join("\n");
const merchantRows = merchantStats.slice(0, 20).map((entry) => `<tr><td><a href="/merchant/${entry.key}/">${esc(entry.name)}</a></td><td>${entry.count}</td><td>${Number.isFinite(entry.lowestPrice) ? money(entry.lowestPrice) : "Varies"}</td><td>${entry.maxDiscount ? `${entry.maxDiscount}%` : "—"}</td><td>${entry.newestCheck}</td></tr>`).join("\n");
const dealIndexHTML = `${head({ title: "DealDesk Deal Index: live prices and discounts", description: datasetSchema.description, canonicalPath: dealIndexPath, schema: [datasetSchema], bodyClass: "authority-page" })}
${header("index")}
<main class="deal-home shell authority-shell"><nav class="deal-breadcrumb"><a href="/">DealDesk</a><span>›</span><span>Deal Index</span></nav><header class="authority-hero"><span class="page-kicker"><span></span> Original DealDesk data</span><h1>DealDesk Deal Index</h1><p>${esc(datasetSchema.description)} Updated ${buildDate}. Download the <a href="/data/dealdesk-deal-index.csv">CSV</a> or <a href="/data/dealdesk-deal-index.json">JSON</a>.</p></header><section class="authority-stat-grid"><article><strong>${deals.length}</strong><span>public offers</span></article><article><strong>${merchants.length}</strong><span>merchant hubs</span></article><article><strong>${categoryStats.length}</strong><span>categories</span></article><article><strong>${Number.isFinite(overallStats.medianDiscount) ? `${Math.round(overallStats.medianDiscount)}%` : "—"}</strong><span>median displayed discount</span></article></section><section class="authority-analysis"><h2>How to read the index</h2><p>The index reports prices and reference-price discounts exactly as recorded in the current DealDesk catalog. It does not claim that every reference price is the merchant's immediately previous selling price, and it does not convert discount size into a product-quality rating. Verification dates and checkout terms remain essential.</p></section><h2>Category statistics</h2><div class="authority-table-wrap"><table class="authority-table"><thead><tr><th>Category</th><th>Offers</th><th>Lowest price</th><th>Median price</th><th>Max discount</th><th>Latest check</th></tr></thead><tbody>${categoryRows}</tbody></table></div><h2>Largest merchant catalogs</h2><div class="authority-table-wrap"><table class="authority-table"><thead><tr><th>Merchant</th><th>Offers</th><th>Lowest price</th><th>Max discount</th><th>Latest check</th></tr></thead><tbody>${merchantRows}</tbody></table></div><h2>Highest-scoring current offers</h2><div class="deal-grid authority-grid">${[...deals].sort((a, b) => scoreByID.get(b.id) - scoreByID.get(a.id)).slice(0, 12).map((deal, index) => card(deal, index === 0)).join("\n")}</div></main>
${footer}
${pageEnd}`;
await mkdir(resolve(root, "deal-index"), { recursive: true });
await writeFile(resolve(root, "deal-index", "index.html"), dealIndexHTML);
authorityPageRecords.push({ path: dealIndexPath, lastmod: buildDate });

const staticPages = [
  {
    path: "/how-we-rank-deals/",
    title: "How DealDesk ranks deals: scoring methodology",
    description: "See the objective signals behind the DealDesk Value Score, including price clarity, displayed savings, freshness, terms, condition, and comparison depth.",
    kicker: "Transparent methodology",
    heading: "How DealDesk ranks deals",
    body: `<p>DealDesk uses a 100-point Value Score to organize—not certify—offers. The score is deliberately factual and does not include fake popularity, invented reviews, or product-quality claims.</p><div class="method-grid"><article><strong>25 points</strong><h2>Publishing baseline</h2><p>The offer must already have an approved, commission-ready destination, a recorded verification date, and genuine merchant imagery.</p></article><article><strong>Up to 20</strong><h2>Price clarity</h2><p>Current monetary price and a clearly labeled reference or renewal price improve the score.</p></article><article><strong>Up to 12</strong><h2>Displayed savings</h2><p>Larger stated savings can raise the score, but a reference-price discount is never treated as proof of quality.</p></article><article><strong>Up to 12</strong><h2>Freshness</h2><p>Recently verified offers score higher. Expiration remains separate from the review reminder.</p></article><article><strong>Up to 14</strong><h2>Terms and condition</h2><p>Condition, shipping, billing, renewal, warranty, and other material terms improve decision usefulness when present.</p></article><article><strong>Up to 10</strong><h2>Comparison depth</h2><p>Offers that can be compared against closely related listings receive additional context points.</p></article><article><strong>Up to 7</strong><h2>Source detail</h2><p>A substantive source summary improves completeness, but copied merchant language alone does not create authority.</p></article></div><section class="authority-analysis"><h2>What the score does not mean</h2><p>It is not a review score, safety certification, seller rating, or promise that the offer is the lowest price anywhere. Checkout is the final source of truth. DealDesk may earn a commission, but commission size is not part of the public Value Score.</p></section>`,
  },
  {
    path: "/editorial-policy/",
    title: "DealDesk editorial and verification policy",
    description: "Read DealDesk's policy for price verification, affiliate disclosure, corrections, expired offers, reference prices, and original deal analysis.",
    kicker: "Editorial standard",
    heading: "DealDesk editorial and verification policy",
    body: `<p>DealDesk is designed to help shoppers understand price, terms, condition, merchant, and freshness before leaving for checkout.</p><div class="method-grid"><article><h2>Price and availability</h2><p>Published pages show the verification date. Prices and inventory can change, so the merchant checkout remains authoritative.</p></article><article><h2>Reference prices</h2><p>“Was,” comparison, and renewal prices are labeled according to their meaning. DealDesk does not silently convert a renewal rate into a previous selling price.</p></article><article><h2>Affiliate disclosure</h2><p>Outbound commercial links are marked sponsored and nofollow. DealDesk may earn a commission without increasing the shopper's price.</p></article><article><h2>No fabricated reviews</h2><p>DealDesk does not publish invented star ratings, testimonials, testing claims, or popularity counts.</p></article><article><h2>Corrections</h2><p>Material errors should be reported to <a href="mailto:hello.launchdesk@gmail.com">hello.launchdesk@gmail.com</a>. Corrected pages retain clear verification dates.</p></article><article><h2>Expired offers</h2><p>Expired or nonpublic offers are removed from active sitemaps and discovery paths rather than preserved as misleading deal pages.</p></article></div>`,
  },
  {
    path: "/about/",
    title: "About DealDesk and Launchdesk LLC",
    description: "DealDesk is a Launchdesk LLC product focused on transparent prices, verified affiliate destinations, comparison context, and useful deal data.",
    kicker: "About DealDesk",
    heading: "Clear prices. Better decisions.",
    body: `<p>DealDesk is operated by Launchdesk LLC. The product exists to make deal pages more useful than a bare affiliate redirect by showing the merchant, current price, comparison basis, savings, condition or billing terms, verification date, related offers, and the limits of the available evidence.</p><section class="authority-analysis"><h2>What makes DealDesk different</h2><p>The catalog combines crawlable archives, merchant hubs, product-family comparisons, a downloadable Deal Index, explicit affiliate disclosure, and a public scoring methodology. DealDesk does not promise that every offer is the best choice for every shopper.</p></section><p>Contact: <a href="mailto:hello.launchdesk@gmail.com">hello.launchdesk@gmail.com</a>.</p>`,
  },
];
for (const page of staticPages) {
  const schema = { "@context": "https://schema.org", "@type": "WebPage", name: page.heading, description: page.description, url: absolute(page.path), dateModified: buildDate, publisher: { "@type": "Organization", name: "DealDesk", url: site } };
  const html = `${head({ title: `${page.title} | DealDesk`, description: page.description, canonicalPath: page.path, schema: [schema], bodyClass: "authority-page" })}
${header(page.path.includes("rank") ? "methodology" : "")}
<main class="deal-home shell authority-shell"><nav class="deal-breadcrumb"><a href="/">DealDesk</a><span>›</span><span>${esc(page.heading)}</span></nav><header class="authority-hero"><span class="page-kicker"><span></span> ${esc(page.kicker)}</span><h1>${esc(page.heading)}</h1><p>${esc(page.description)}</p></header><div class="authority-prose">${page.body}</div></main>
${footer}
${pageEnd}`;
  const output = resolve(root, page.path.replace(/^\//, ""), "index.html");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html);
  authorityPageRecords.push({ path: page.path, lastmod: buildDate });
}

const ensureAuthorityStylesheet = (html) => {
  if (html.includes('/assets/seo-authority.css')) return html;
  return html.replace(/(<link rel="stylesheet" href="\/assets\/indexing\.css[^>]*>)/, `$1\n  <link rel="stylesheet" href="/assets/seo-authority.css?v=${buildID}" />`);
};
const replaceMeta = (html, name, value) => {
  const tagPattern = /<meta\b[^>]*>/gi;
  const cleaned = html.replace(tagPattern, (tag) => {
    const match = tag.match(/\bname\s*=\s*["']([^"']+)["']/i);
    return match?.[1]?.toLowerCase() === String(name).toLowerCase() ? "" : tag;
  });
  return cleaned.replace(/<\/title>/, `</title>\n  <meta name="${name}" content="${esc(value)}" />`);
};
const replaceProperty = (html, property, value) => {
  const tagPattern = /<meta\b[^>]*>/gi;
  const cleaned = html.replace(tagPattern, (tag) => {
    const match = tag.match(/\bproperty\s*=\s*["']([^"']+)["']/i);
    return match?.[1]?.toLowerCase() === String(property).toLowerCase() ? "" : tag;
  });
  return cleaned.replace(/<\/title>/, `</title>\n  <meta property="${property}" content="${esc(value)}" />`);
};

const seoTargets = [];
for (const deal of deals) {
  const path = dealPath(deal);
  const file = resolve(root, path.replace(/^\//, ""), "index.html");
  let html = await readFile(file, "utf8");
  html = html.replace(/\s*<!-- SEO-AUTHORITY:START -->[\s\S]*?<!-- SEO-AUTHORITY:END -->/g, "");
  html = html.replace(/\s*<script type="application\/ld\+json" data-dealdesk-authority>[\s\S]*?<\/script>/g, "");
  html = html.replace(/<meta name="dealdesk-seo" content="[^"]*" \/>\s*/g, "");
  html = ensureAuthorityStylesheet(html);

  const comparable = comparisonFor(deal);
  const position = pricePositionFor(deal, comparable);
  const score = scoreByID.get(deal.id);
  const discount = discountFrom(deal);
  const title = cleanTitle(deal.title);
  const titleTag = `${truncate(title, 82)} deal: ${deal.currentPrice || "current terms"}${discount ? `, ${discount}% off` : ""} | DealDesk`;
  const description = `Verified ${merchantName(deal)} deal for ${title}: ${deal.currentPrice || "see current terms"}${deal.originalPrice ? `, compared with ${deal.originalPrice}` : ""}. ${conditionFrom(deal)}. Checked ${isoDate(deal.verifiedAt)}. Compare similar offers and material terms.`;
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(titleTag)}</title>`);
  html = replaceMeta(html, "description", description);
  html = replaceProperty(html, "og:title", titleTag);
  html = replaceProperty(html, "og:description", description);
  html = html.replace(/<meta name="robots"/, `<meta name="dealdesk-seo" content="${buildID}" />\n  <meta name="robots"`);
  if (!html.includes('name="twitter:card"')) html = html.replace(/<meta property="og:url"[^>]+>/, `$&\n  <meta name="twitter:card" content="summary_large_image" />`);

  const merchant = merchantByDealID.get(deal.id);
  const family = familyByDealID.get(deal.id);
  const merchantPath = merchant ? `/merchant/${merchant.key}/` : "/merchants/";
  const comparisonPath = family ? `/compare/${family.key}/` : "";
  const target = targetFor(deal);
  const authoritySchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${absolute(path)}#dealdesk-analysis`,
    url: absolute(path),
    name: `${title} deal analysis`,
    description,
    dateModified: isoDate(deal.verifiedAt),
    isPartOf: { "@type": "WebSite", "@id": `${site}/#website`, name: "DealDesk", url: site },
    about: { "@type": "Thing", name: title },
    publisher: { "@type": "Organization", name: "DealDesk", url: site },
  };
  html = html.replace(/<\/head>/, `  <script type="application/ld+json" data-dealdesk-authority>${JSON.stringify(authoritySchema).replaceAll("<", "\\u003c")}</script>\n</head>`);

  const similarRows = comparable.length ? `<section class="deal-comparison-panel" aria-labelledby="similar-deals-title"><div><span class="page-kicker"><span></span> Similar offers</span><h2 id="similar-deals-title">Compare related prices before checkout</h2><p>${position ? `This offer ranks ${position.rank} of ${position.total} by displayed price among the closely related offers shown below.` : "These offers share product-family or title signals; confirm exact model, size, condition, and included accessories."}</p></div><div class="deal-comparison-list">${comparable.map((candidate) => `<a href="${dealPath(candidate)}"><span><strong>${esc(candidate.title)}</strong><small>${esc(conditionFrom(candidate))} · ${esc(merchantName(candidate))}</small></span><b>${esc(candidate.currentPrice || "See terms")}</b></a>`).join("")}</div></section>` : "";
  const authoritySection = `<!-- SEO-AUTHORITY:START -->
  <section class="deal-seo-authority" aria-labelledby="dealdesk-verdict-title">
    <div class="deal-score-card"><span>DealDesk Value Score</span><strong>${score}<small>/100</small></strong><a href="/how-we-rank-deals/">How the score works</a></div>
    <div class="deal-verdict"><span class="page-kicker"><span></span> Objective deal analysis</span><h2 id="dealdesk-verdict-title">DealDesk verdict</h2><p>${esc(verdictFor(deal, comparable))}</p></div>
  </section>
  <section class="deal-question-grid" aria-label="Deal questions answered">
    <article><h2>What is the current price?</h2><p>${esc(deal.currentPrice || "The merchant requires checkout or eligibility confirmation for current terms.")}</p></article>
    <article><h2>How much is the displayed saving?</h2><p>${deal.savingsText ? esc(deal.savingsText) : discount ? `${discount}% against the stated reference price.` : "No verified percentage saving is claimed on this page."}</p></article>
    <article><h2>What condition or billing type applies?</h2><p>${esc(conditionFrom(deal) !== "Not stated" ? conditionFrom(deal) : deal.referenceStyle === "renewal" ? "Introductory subscription pricing with a later renewal amount." : "The catalog does not state a standardized condition; confirm the merchant page.")}</p></article>
    <article><h2>Where and when was it checked?</h2><p>${esc(merchantName(deal))}, checked ${esc(isoDate(deal.verifiedAt))}. Final price, tax, shipping, eligibility, and availability are set by the merchant.</p></article>
  </section>
  ${similarRows}
  <nav class="deal-authority-links" aria-label="Deal research links"><a href="${merchantPath}">More ${esc(merchantName(deal))} deals</a>${comparisonPath ? `<a href="${comparisonPath}">Compare ${esc(family.label)} offers</a>` : ""}<a href="/deal-index/">DealDesk Deal Index</a><a href="/editorial-policy/">Editorial policy</a></nav>
  <!-- SEO-AUTHORITY:END -->`;
  html = html.replace(/\s*<section class="deal-more">/, `\n  ${authoritySection}\n    <section class="deal-more">`);
  await writeFile(file, html);
  seoTargets.push({
    id: deal.id,
    url: absolute(path),
    title: titleTag,
    primaryQuery: target.primary,
    secondaryQueries: target.secondary,
    score,
    merchantPath,
    comparisonPath,
  });
}

const authorityHub = `<!-- SEO-AUTHORITY-HUB:START --><section class="seo-authority-hub" aria-labelledby="seo-authority-hub-title"><div><span class="page-kicker"><span></span> Deal intelligence</span><h2 id="seo-authority-hub-title">Research the deal, not just the discount</h2><p>DealDesk adds merchant hubs, product-family comparisons, objective scoring, and a downloadable price index to every crawlable catalog path.</p></div><div class="seo-authority-hub-links"><a href="/deal-index/"><strong>DealDesk Deal Index</strong><span>Live catalog statistics and downloads</span></a><a href="/comparisons/"><strong>Compare similar offers</strong><span>Price, condition, and savings side by side</span></a><a href="/merchants/"><strong>Browse merchants</strong><span>Verified offers organized by store</span></a><a href="/how-we-rank-deals/"><strong>Scoring methodology</strong><span>Exactly how the Value Score works</span></a></div></section><!-- SEO-AUTHORITY-HUB:END -->`;
for (const [relativePath, titleTag, description] of [
  ["index.html", "Best deals today: verified prices and savings | DealDesk", `Browse ${deals.length} verified deals with clear prices, comparison context, merchant pages, product-family analysis, and current verification dates.`],
  ["latest-deals/index.html", `Best deals today: ${deals.length} verified offers | DealDesk`, `Compare ${deals.length} current DealDesk offers by price, savings, merchant, category, condition, and verification date.`],
]) {
  const file = resolve(root, relativePath);
  let html = await readFile(file, "utf8");
  html = html.replace(/\s*<!-- SEO-AUTHORITY-HUB:START -->[\s\S]*?<!-- SEO-AUTHORITY-HUB:END -->/g, "");
  html = html.replace(/<meta name="dealdesk-seo" content="[^"]*" \/>\s*/g, "");
  html = ensureAuthorityStylesheet(html);
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(titleTag)}</title>`);
  html = replaceMeta(html, "description", description);
  html = replaceProperty(html, "og:title", titleTag);
  html = replaceProperty(html, "og:description", description);
  html = html.replace(/<meta name="robots"/, `<meta name="dealdesk-seo" content="${buildID}" />\n    <meta name="robots"`);
  const insertion = relativePath === "index.html"
    ? /\s*<section class="deals-section"/
    : /\s*<\/main>\s*<footer class="footer">/;
  html = relativePath === "index.html"
    ? html.replace(insertion, `\n        ${authorityHub}\n\n        <section class="deals-section"`)
    : html.replace(insertion, `\n    ${authorityHub}\n  </main>\n  <footer class="footer">`);
  await writeFile(file, html);
}

const patchCollectionPage = async (file, title, description, canonicalPath, summaryHTML) => {
  let html = await readFile(file, "utf8");
  html = html.replace(/\s*<!-- SEO-COLLECTION-AUTHORITY:START -->[\s\S]*?<!-- SEO-COLLECTION-AUTHORITY:END -->/g, "");
  html = html.replace(/<meta name="dealdesk-seo" content="[^"]*" \/>\s*/g, "");
  html = ensureAuthorityStylesheet(html);
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  html = replaceMeta(html, "description", description);
  html = html.replace(/<meta name="robots"/, `<meta name="dealdesk-seo" content="${buildID}" />\n  <meta name="robots"`);
  html = html.replace(/\s*<div class="deal-grid crawl-grid">/, `\n    <!-- SEO-COLLECTION-AUTHORITY:START -->${summaryHTML}<!-- SEO-COLLECTION-AUTHORITY:END -->\n    <div class="deal-grid crawl-grid">`);
  if (!html.includes(`rel="canonical" href="${absolute(canonicalPath)}"`)) throw new Error(`Collection canonical mismatch for ${canonicalPath}`);
  await writeFile(file, html);
};

for (const [label, items] of categoryGroups.entries()) {
  const key = slugify(label);
  const pages = chunks(items, 32);
  const stats = statsFor(items);
  const familyLinks = families.filter((family) => family.deals.some((deal) => (deal.categoryLabel || deal.category || "Other") === label)).slice(0, 6);
  for (let index = 0; index < pages.length; index += 1) {
    const page = index + 1;
    const path = pagePath(`/category/${key}/`, page);
    const file = pageOutput(resolve(root, "category", key), page);
    const title = page === 1 ? `Best ${label} deals today: prices and savings | DealDesk` : `${label} deals – Page ${page} | DealDesk`;
    const description = `Compare ${items.length} verified ${label.toLowerCase()} offers. ${Number.isFinite(stats.lowestPrice) ? `Displayed prices start at ${money(stats.lowestPrice)}.` : ""} Largest stated discount: ${stats.maxDiscount || 0}%. Checked through ${stats.newestCheck}.`;
    const summaryHTML = `<section class="collection-authority"><div><h2>${page === 1 ? `Current ${esc(label)} deal signals` : `More ${esc(label)} offers`}</h2><p>${esc(description)}</p></div><dl><div><dt>Offers</dt><dd>${items.length}</dd></div><div><dt>Median price</dt><dd>${Number.isFinite(stats.medianPrice) ? money(stats.medianPrice) : "Varies"}</dd></div><div><dt>Max discount</dt><dd>${stats.maxDiscount ? `${stats.maxDiscount}%` : "—"}</dd></div><div><dt>Latest check</dt><dd>${stats.newestCheck}</dd></div></dl>${familyLinks.length ? `<nav>${familyLinks.map((family) => `<a href="/compare/${family.key}/">Compare ${esc(family.label)}</a>`).join("")}</nav>` : ""}</section>`;
    await patchCollectionPage(file, title, description, path, summaryHTML);
  }
}

const authoritySitemapRecords = [...authorityPageRecords];
await writeFile(resolve(root, "sitemap-authority.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${authoritySitemapRecords.map((record) => `  <url><loc>${xml(absolute(record.path))}</loc><lastmod>${record.lastmod}</lastmod></url>`).join("\n")}\n</urlset>\n`);
let sitemapIndex = await readFile(resolve(root, "sitemap.xml"), "utf8");
sitemapIndex = sitemapIndex.replace(/\s*<sitemap><loc>https:\/\/dealdesk\.fyi\/sitemap-authority\.xml<\/loc>[\s\S]*?<\/sitemap>/g, "");
sitemapIndex = sitemapIndex.replace(/\s*<\/sitemapindex>/, `\n  <sitemap><loc>${site}/sitemap-authority.xml</loc><lastmod>${buildDate}</lastmod></sitemap>\n</sitemapindex>`);
await writeFile(resolve(root, "sitemap.xml"), sitemapIndex);

const targetsJSON = { build: buildID, generatedAt: new Date().toISOString(), targets: seoTargets };
await writeFile(resolve(root, "data", "seo-targets.json"), `${JSON.stringify(targetsJSON, null, 2)}\n`);
const targetsCSV = [
  ["deal_id", "url", "title_tag", "primary_query", "secondary_queries", "value_score", "merchant_path", "comparison_path"].map(csv).join(","),
  ...seoTargets.map((target) => [target.id, target.url, target.title, target.primaryQuery, target.secondaryQueries.join(" | "), target.score, target.merchantPath, target.comparisonPath].map(csv).join(",")),
].join("\n");
await writeFile(resolve(root, "data", "seo-targets.csv"), `${targetsCSV}\n`);

const report = {
  build: buildID,
  generatedAt: new Date().toISOString(),
  catalogUpdatedAt: latestCatalog.updatedAt,
  publicDeals: deals.length,
  dealsEnriched: seoTargets.length,
  merchants: merchants.length,
  merchantPages: merchantPageRecords.length,
  comparisonGroups: families.length,
  comparisonPages: comparisonPageRecords.length,
  dealsWithComparisonPage: deals.filter((deal) => familyByDealID.has(deal.id)).length,
  authorityPages: authorityPageRecords.length,
  authoritySitemap: "sitemap-authority.xml",
  targetQueries: seoTargets.length,
  scores: {
    minimum: Math.min(...seoTargets.map((target) => target.score)),
    median: median(seoTargets.map((target) => target.score)),
    maximum: Math.max(...seoTargets.map((target) => target.score)),
  },
  merchantPaths: merchantPageRecords.map((record) => record.path),
  comparisonPaths: comparisonPageRecords.map((record) => record.path),
  staticPaths: ["/merchants/", "/comparisons/", "/deal-index/", ...staticPages.map((page) => page.path)],
};
await writeFile(resolve(root, "data", "seo-authority-report.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`Built DealDesk SEO authority engine for ${deals.length} deals: ${merchantPageRecords.length} merchant pages, ${comparisonPageRecords.length} comparison pages, ${authorityPageRecords.length} authority URLs.`);
