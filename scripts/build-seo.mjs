import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateSearchIndexPolicy,
  SEARCH_INDEX_POLICY_NAME,
  SEARCH_INDEX_POLICY_VERSION
} from "./lib/search-index-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = "https://dealdesk.fyi";
const configuredBuildAt = process.env.DEALDESK_BUILD_AT;
const now = configuredBuildAt ? new Date(configuredBuildAt).getTime() : Date.now();
if (!Number.isFinite(now)) throw new Error("DEALDESK_BUILD_AT must be a valid date-time when provided");
const feeds = await Promise.all([
  readFile(resolve(root, "data/best-deals.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/streaming-deals.json"), "utf8").then(JSON.parse)
]);
const affiliateRegistry = JSON.parse(await readFile(resolve(root, "data/affiliate-programs.json"), "utf8"));
const commissionAccrualReadyByNetwork = new Map((affiliateRegistry.publisherAccounts || [])
  .map((account) => [account.network, account.commissionAccrualReady]));
const hasCommissionPath = (deal) => commissionAccrualReadyByNetwork.get(deal.network) === true;
const isLiveDeal = (deal) => {
  const expiresAt = deal.expiresAt ? new Date(deal.expiresAt).getTime() : Infinity;
  return deal.status === "active" &&
    deal.commissionEligible === true &&
    deal.approvalStatus === "approved" &&
    hasCommissionPath(deal) &&
    Boolean(deal.affiliateURL) &&
    Boolean(deal.verifiedAt) &&
    now <= expiresAt;
};
// recheckAfter is a freshness-review date, not an offer-expiration date.
// Only an explicit expiresAt or a non-active status can remove a deal.
const validUntilFor = (deal) => {
  const expiresAt = deal.expiresAt ? new Date(deal.expiresAt).getTime() : NaN;
  return Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : "";
};
const hasGenuineMerchantImage = (deal) => {
  try {
    const image = new URL(String(deal?.imageURL || ""));
    if (image.protocol !== "https:") return false;
    if (deal.network === "ebay-partner-network" && deal.sourceType === "ebay-product") {
      return image.hostname === "i.ebayimg.com";
    }
    return true;
  } catch {
    return false;
  }
};
const allFeedDeals = feeds.flatMap((feed) => feed.deals || []);
const commissionBlockedDealCount = allFeedDeals.filter((deal) => {
  const expiresAt = deal.expiresAt ? new Date(deal.expiresAt).getTime() : Infinity;
  return deal.status === "active" && deal.commissionEligible === true &&
    deal.approvalStatus === "approved" && !hasCommissionPath(deal) &&
    Boolean(deal.affiliateURL) && Boolean(deal.verifiedAt) &&
    now <= expiresAt;
}).length;
const verificationDueDealCount = allFeedDeals.filter((deal) => {
  const expiresAt = deal.expiresAt ? new Date(deal.expiresAt).getTime() : Infinity;
  const recheckAfter = deal.recheckAfter ? new Date(deal.recheckAfter).getTime() : Infinity;
  return deal.status === "active" && now <= expiresAt &&
    Number.isFinite(recheckAfter) && now > recheckAfter;
}).length;
const liveDeals = allFeedDeals.filter(isLiveDeal);
const deals = liveDeals.filter(hasGenuineMerchantImage);
const publicDealIDs = new Set(deals.map((deal) => deal.id));
const nonPublicDeals = allFeedDeals.filter((deal) => !publicDealIDs.has(deal.id));
const withheldDealCount = liveDeals.length - deals.length;
const searchIndexStateByID = await evaluateSearchIndexPolicy(deals, now);
const searchIndexStateFor = (deal) => searchIndexStateByID.get(deal.id) ||
  { indexable: false, reason: "quality-tier-not-selected" };

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const cleanTitle = (title) => String(title || "Deal").replace(/\s+[—–-]\s+(?:up to\s+)?\d+%\s+off\s*$/i, "");
const slugFor = (deal) => String(deal.id || "deal").replace(/-\d{8}$/, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const outboundURL = (deal, placement = "detail") => {
  const params = new URLSearchParams({
    network: deal.network,
    url: deal.affiliateURL,
    subid: `${placement}-${deal.id}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32),
    until: validUntilFor(deal),
  });
  return `/out/?${params.toString()}`;
};
const pricesFrom = (deal) => {
  const matches = String(deal?.summary || deal || "").match(/\$[\d,]+(?:\.\d{2})?/g) || [];
  const hasExplicitCurrent = Boolean(deal?.currentPrice);
  return {
    current: deal?.currentPrice || matches[0] || "",
    original: deal?.originalPrice || (hasExplicitCurrent ? "" : matches[1]) || ""
  };
};
const numberFromPrice = (price) => Number(String(price).replace(/[^0-9.]/g, ""));
const hasMonetaryPrice = (price) => /^\s*(?:US)?\$\s*\d/.test(String(price || ""));
const isoDate = (value) => {
  const date = new Date(value || now);
  return Number.isNaN(date.getTime()) ? new Date(now).toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
};
const lifecycleText = (deal) => deal.expiresAt
  ? `Offer scheduled through ${isoDate(deal.expiresAt)}`
  : `Next verification due ${isoDate(deal.recheckAfter)}`;
const discountFrom = (prices, deal) => {
  if (Number.isFinite(Number(deal?.discountPercent))) return Number(deal.discountPercent);
  const current = numberFromPrice(prices.current);
  const original = numberFromPrice(prices.original);
  return original > current && current > 0 ? Math.round((1 - current / original) * 100) : 0;
};
const rankingNumber = (deal) => {
  const score = Number(deal?.rankingScore);
  return Number.isFinite(score) ? score : discountFrom(pricesFrom(deal), deal);
};
const savingsFrom = (prices) => {
  const current = numberFromPrice(prices.current);
  const original = numberFromPrice(prices.original);
  return original > current && current > 0 ? original - current : 0;
};
const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const asinFrom = (deal) => String(deal.id || "").match(/amazon-([a-z0-9]{10})/i)?.[1]?.toUpperCase() || "";
const imageFor = (deal) => hasGenuineMerchantImage(deal) ? deal.imageURL : "";
const earningPotential = (deal) => {
  const estimate = Number(deal?.estimatedCommission);
  if (Number.isFinite(estimate) && estimate >= 0) return estimate;
  const bandValue = { "very-high": 40, high: 25, medium: 10, low: 1 }[String(deal?.earningsBand || "").toLowerCase()];
  if (Number.isFinite(bandValue)) return bandValue;
  const fixedBounty = String(deal?.commission || "").match(/^\$(\d+(?:\.\d+)?)/);
  return fixedBounty ? Number(fixedBounty[1]) : 0;
};
const itemConditionFor = (deal) => {
  const text = String(deal?.priceNote || "").toLowerCase();
  if (text.includes("refurbished")) return "https://schema.org/RefurbishedCondition";
  if (/\b(used|pre-owned|open box)\b/.test(text)) return "https://schema.org/UsedCondition";
  if (/\bnew\b/.test(text)) return "https://schema.org/NewCondition";
  return "";
};
const publicDescription = (deal, title, prices, updated) => {
  const merchant = deal.merchantName || "the merchant";
  const discount = discountFrom(prices, deal);
  if (prices.current && prices.original) {
    if (deal.referenceStyle === "renewal") {
      return `DealDesk found ${title} at ${merchant} for ${prices.current} during the introductory period. ${deal.referenceLabel || "Then"} ${prices.original}. ${deal.savingsText || "Confirm eligibility and renewal terms"}. Price checked ${isoDate(updated)}; availability can change.`;
    }
    if (deal.referenceStyle === "comparison") {
      return `DealDesk found ${title} at ${merchant} for ${prices.current}. The displayed ${deal.referenceLabel || "comparison reference"} is ${prices.original}. ${deal.savingsText || "Confirm the comparison basis with the merchant"}. Price checked ${isoDate(updated)}; availability can change.`;
    }
    const priceContext = deal.savingsText ? `. The live offer advertises ${deal.savingsText}.` : discount ? ` (${discount}% off).` : ".";
    return `DealDesk found ${title} at ${merchant} for ${prices.current}, down from ${prices.original}${priceContext} Price checked ${isoDate(updated)}; availability can change.`;
  }
  if (prices.current) {
    return `DealDesk found ${title} at ${merchant} for ${prices.current}. Price checked ${isoDate(updated)}; availability can change.`;
  }
  if (deal.summary) {
    return `${String(deal.summary).trim()} Checked ${isoDate(updated)}; eligibility and availability can change.`;
  }
  return `${title} offer from ${merchant}. Check eligibility, current pricing, and availability with the merchant.`;
};

const dealsRoot = resolve(root, "deals");
const dealSlugManifestPath = resolve(root, "data", "deal-slugs.json");
let previousDealSlugs = [];
try {
  previousDealSlugs = (await readdir(dealsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
} catch {}
try {
  const manifest = JSON.parse(await readFile(dealSlugManifestPath, "utf8"));
  previousDealSlugs = [...new Set([...previousDealSlugs, ...(manifest.slugs || [])])];
} catch {}
await rm(dealsRoot, { recursive: true, force: true });

for (const deal of deals) {
  const slug = slugFor(deal);
  const canonical = `${site}/deals/${slug}/`;
  const title = cleanTitle(deal.title);
  const prices = pricesFrom(deal);
  const image = imageFor(deal);
  const updated = deal.verifiedAt || deal.publishedAt || feeds[0].updatedAt;
  const description = publicDescription(deal, title, prices, updated);
  const asin = asinFrom(deal);
  const discount = discountFrom(prices, deal);
  const savings = savingsFrom(prices);
  const itemCondition = itemConditionFor(deal);
  const searchIndexState = searchIndexStateFor(deal);
  const isServiceOffer = deal.offerType === "subscription" ||
    String(deal.category || "").toLowerCase() === "subscriptions";
  const relatedDeals = deals.filter((candidate) =>
    candidate.id !== deal.id && candidate.category === deal.category && pricesFrom(candidate).current
  ).slice(0, 3);
  const relatedHTML = relatedDeals.map((candidate) => {
    const candidateTitle = cleanTitle(candidate.title);
    const candidatePrices = pricesFrom(candidate);
    const candidateDiscount = discountFrom(candidatePrices, candidate);
    return `<a class="related-deal" href="/deals/${slugFor(candidate)}/">
      <span class="related-deal-media"><img src="${esc(imageFor(candidate))}" alt="${esc(candidateTitle)}" loading="lazy" /></span>
      <span class="related-deal-copy"><span><strong>${esc(candidatePrices.current)}</strong>${candidatePrices.original ? candidate.referenceStyle === "renewal" ? ` <small>${esc(candidate.referenceLabel || "Then")} ${esc(candidatePrices.original)}</small>` : ` <del>${esc(candidatePrices.original)}</del>` : ""}</span><b>${esc(candidateTitle)}</b><small>${candidate.badgeText ? `${esc(candidate.badgeText)} · ` : candidateDiscount ? `${candidateDiscount}% off · ` : ""}${esc(candidate.merchantName || "Amazon")}</small></span>
    </a>`;
  }).join("\n");
  const schema = hasMonetaryPrice(prices.current) ? {
    "@context": "https://schema.org",
    "@type": isServiceOffer ? "Service" : "Product",
    name: title,
    description,
    category: deal.category || "Deals",
    url: canonical,
    mainEntityOfPage: canonical,
    dateModified: isoDate(updated),
    ...(!isServiceOffer && asin ? { sku: asin } : {}),
    ...(image ? { image: [image] } : {}),
    offers: {
      "@type": "Offer",
      url: deal.affiliateURL,
      priceCurrency: "USD",
      price: numberFromPrice(prices.current).toFixed(2),
      ...(deal.expiresAt ? { priceValidUntil: isoDate(deal.expiresAt) } : {}),
      ...(!isServiceOffer && deal.availabilityStatus === "InStock" ? { availability: "https://schema.org/InStock" } : {}),
      ...(!isServiceOffer && itemCondition ? { itemCondition } : {}),
      ...(deal.sellerName ? { seller: { "@type": "Organization", name: deal.sellerName } } : {})
    }
  } : {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${title} offer`,
    description,
    url: canonical,
    dateModified: isoDate(updated),
    ...(image ? { primaryImageOfPage: image } : {})
  };
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "DealDesk", item: `${site}/` },
      { "@type": "ListItem", position: 2, name: "Latest deals", item: `${site}/latest-deals/` },
      { "@type": "ListItem", position: 3, name: title, item: canonical }
    ]
  };
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} deal | DealDesk</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="dealdesk-index-status" content="${searchIndexState.reason}" />
  <meta name="robots" content="${searchIndexState.indexable ? "index,follow" : "noindex,follow"},max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
  <link rel="canonical" href="${canonical}" />
  <meta property="og:type" content="${hasMonetaryPrice(prices.current) && !isServiceOffer ? "product" : "website"}" />
  <meta property="og:title" content="${esc(title)} deal" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${canonical}" />
${image ? `  <meta property="og:image" content="${esc(image)}" />\n` : ""}  <link rel="icon" type="image/png" href="/assets/dealdesk-publisher-logo.png" />
  <link rel="stylesheet" href="/styles.css" />
  <script type="application/ld+json">${JSON.stringify(schema).replaceAll("<", "\\u003c")}</script>
  <script type="application/ld+json">${JSON.stringify(breadcrumbSchema).replaceAll("<", "\\u003c")}</script>
  <script>(function(){if(Date.now()>Date.parse(${JSON.stringify(validUntilFor(deal))})){document.documentElement.hidden=true;window.location.replace("/latest-deals/");}}());</script>
</head>
<body>
  <header class="site-header"><nav class="nav shell" aria-label="Primary navigation"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><div class="nav-links"><a href="/latest-deals/">Latest deals</a><a href="/category/subscriptions/">Subscription deals</a><a href="/category/streaming/">Streaming deals</a><a href="/collections/">Deal guides</a><a href="/categories/">Categories</a></div></nav></header>
  <main class="deal-detail shell">
    <nav class="deal-breadcrumb" aria-label="Breadcrumb"><a href="/">DealDesk</a><span aria-hidden="true">›</span><a href="/latest-deals/">Latest deals</a><span aria-hidden="true">›</span><span>${esc(title)}</span></nav>
    <article class="deal-detail-card">
      <div class="deal-detail-media"><img src="${esc(image)}" alt="${esc(title)}" /></div>
      <div class="deal-detail-content">
        <span class="page-kicker"><span aria-hidden="true"></span> ${esc(deal.category || "Featured deal")}</span>
        <h1>${esc(title)}</h1>
${prices.current ? `        <p class="deal-detail-price"><strong>${esc(prices.current)}</strong>${prices.original ? deal.referenceStyle === "renewal" ? ` <span>${esc(deal.referenceLabel || "Then")} ${esc(prices.original)}</span>` : ` <span>${esc(deal.referenceLabel || "Reference price")} <del>${esc(prices.original)}</del></span>` : ""}</p>\n` : ""}${deal.priceNote ? `        <p class="deal-detail-price-note">${esc(deal.priceNote)}</p>\n` : ""}        <p class="deal-detail-summary">${esc(description)}</p>
        <p class="deal-detail-meta">Found on ${esc(deal.merchantName || "the merchant site")} · Checked ${esc(isoDate(deal.verifiedAt))} · ${esc(lifecycleText(deal))}</p>
        <a class="deal-detail-cta" href="${esc(outboundURL(deal))}" rel="sponsored nofollow noopener" target="_blank">View live deal on ${esc(deal.merchantName || "Amazon")} <span aria-hidden="true">→</span></a>
        <p class="deal-detail-fineprint">Affiliate link: DealDesk may earn a commission. Price, eligibility, and availability can change; confirm final terms with the merchant.</p>
      </div>
    </article>
${prices.current ? `    <section class="deal-proof" aria-labelledby="deal-proof-title"><div><span class="page-kicker"><span aria-hidden="true"></span> Transparent deal math</span><h2 id="deal-proof-title">Why this price stands out</h2><p>${deal.savingsText ? esc(deal.savingsText) : discount ? `${discount}% below the displayed reference price` : "Current price shown clearly"}${deal.referenceStyle !== "renewal" && savings ? `, a difference of ${money(savings)} per displayed price unit` : ""}. No countdowns or popularity claims are added by DealDesk.</p></div><dl><div><dt>${deal.referenceStyle === "renewal" ? "Intro price" : "Current"}</dt><dd>${esc(prices.current)}</dd></div>${prices.original ? deal.referenceStyle === "renewal" ? `<div><dt>${esc(deal.referenceLabel || "Then")}</dt><dd>${esc(prices.original)}</dd></div>` : `<div><dt>Reference</dt><dd><del>${esc(prices.original)}</del></dd></div>` : ""}${deal.referenceStyle !== "renewal" && savings ? `<div><dt>Difference</dt><dd>${money(savings)}</dd></div>` : ""}<div><dt>Checked</dt><dd>${esc(isoDate(updated))}</dd></div></dl></section>\n` : ""}    <section class="deal-more"><h2>${relatedHTML ? "Compare three nearby picks" : "More deals worth seeing"}</h2>${relatedHTML ? `<div class="related-deals">${relatedHTML}</div>` : ""}<p><a href="/latest-deals/">Browse all current DealDesk picks</a></p></section>
  </main>
  <footer class="footer"><div class="shell footer-inner"><a class="brand footer-brand" href="/"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><p>Clear prices. Better clicks.</p><div class="footer-links"><a href="/support/">Support</a><a href="/privacy/">Privacy</a></div></div><div class="shell disclosure">DealDesk may earn a commission when you buy through our links. You never pay more because of it.</div></footer>
</body>
</html>`;
  const output = resolve(root, "deals", slug, "index.html");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html);
}

const generatedDealSlugs = new Set(deals.map(slugFor));
const knownDealSlugs = [...generatedDealSlugs].sort();
await writeFile(dealSlugManifestPath, `${JSON.stringify({
  updatedAt: new Date(Math.max(...feeds.map((feed) => new Date(feed.updatedAt || 0).getTime()), new Date(affiliateRegistry.updatedAt || 0).getTime())).toISOString(),
  slugs: knownDealSlugs
}, null, 2)}\n`);

const latestFeedTime = Math.max(...feeds.map((feed) => new Date(feed.updatedAt || 0).getTime()), new Date(affiliateRegistry.updatedAt || 0).getTime());
const lastmod = isoDate(latestFeedTime);
const latestCatalogVersion = Number.isFinite(latestFeedTime) ? latestFeedTime.toString(36) : "current";
const diversifyDeals = (items, seed = []) => {
  const pool = [...items];
  const ordered = [...seed];
  while (pool.length) {
    const recentCategories = new Set(ordered.slice(-2).map((deal) => deal.category));
    const previousMerchant = ordered.at(-1)?.merchantName;
    let index = pool.findIndex((deal) => !recentCategories.has(deal.category) && deal.merchantName !== previousMerchant);
    if (index < 0) index = pool.findIndex((deal) => deal.merchantName !== previousMerchant);
    if (index < 0) index = 0;
    ordered.push(pool.splice(index, 1)[0]);
  }
  return ordered.slice(seed.length);
};
const rankedDeals = [...deals]
  .sort((a, b) => rankingNumber(b) - rankingNumber(a) || discountFrom(pricesFrom(b), b) - discountFrom(pricesFrom(a), a) || new Date(b.verifiedAt || 0) - new Date(a.verifiedAt || 0) || Number(a.priority || 99) - Number(b.priority || 99));
const pricedDeals = diversifyDeals(rankedDeals);
const featuredDeal = pricedDeals[0];
const featuredPrices = pricesFrom(featuredDeal);
const featuredDiscount = discountFrom(featuredPrices, featuredDeal);
const featuredSavings = savingsFrom(featuredPrices);
const featuredTitle = cleanTitle(featuredDeal?.title);
const featuredCanonical = featuredDeal ? `/deals/${slugFor(featuredDeal)}/` : "/#all-deals";
const latestSchema = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "Deal listings with visible check dates",
  description: "DealDesk catalog records with displayed price, reference price, savings, merchant, and check dates shown clearly.",
  url: `${site}/latest-deals/`,
  dateModified: lastmod,
  mainEntity: {
    "@type": "ItemList",
    numberOfItems: pricedDeals.length,
    itemListElement: pricedDeals.slice(0, 18).map((deal, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: cleanTitle(deal.title),
      url: `${site}/deals/${slugFor(deal)}/`
    }))
  }
};
const categoryOptions = [...new Set(pricedDeals.map((deal) => deal.category || "Other"))].sort()
  .map((category) => `<option value="${esc(category.toLowerCase())}">${esc(category)}</option>`).join("");
const latestDealData = pricedDeals.map((deal) => {
  const title = cleanTitle(deal.title);
  const prices = pricesFrom(deal);
  const discount = discountFrom(prices, deal);
  const savings = savingsFrom(prices);
  const displayPrice = prices.current || "See terms";
  return {
    id: deal.id,
    title,
    url: `/deals/${slugFor(deal)}/`,
    category: String(deal.category || "Other").toLowerCase(),
    categoryLabel: deal.category || "Deal",
    merchant: deal.merchantName || "Amazon",
    imageURL: imageFor(deal),
    currentPrice: displayPrice,
    originalPrice: prices.original || "",
    referenceStyle: deal.referenceStyle || "",
    referenceLabel: deal.referenceLabel || (deal.referenceStyle === "renewal" ? "Then" : "Was"),
    badgeText: deal.badgeText || (discount ? `${discount}% off` : ""),
    savingsText: deal.savingsText || (savings ? `Save ${money(savings)} · ${discount}% off` : ""),
    priceNote: deal.priceNote || (!prices.current && deal.cardCopy ? deal.cardCopy : ""),
    verifiedAt: isoDate(deal.verifiedAt || deal.publishedAt || lastmod),
    expiresAt: deal.expiresAt || "",
    recheckAfter: deal.recheckAfter || ""
  };
});
const latestCardHTML = (deal) => `<article class="deal-card" data-deal-id="${esc(deal.id)}" data-category="${esc(deal.category)}" data-expires-at="${esc(deal.expiresAt)}" data-recheck-after="${esc(deal.recheckAfter)}">
    <a class="deal-card-link" href="${esc(deal.url)}" aria-label="${esc(deal.title)}, ${esc(deal.currentPrice)}. View deal details">
      <span class="deal-media">
${deal.badgeText ? `        <span class="discount-badge">${esc(deal.badgeText)}</span>\n` : ""}        <img src="${esc(deal.imageURL)}" data-merchant-image alt="${esc(deal.title)}" width="800" height="520" loading="lazy" decoding="async" />
      </span>
      <span class="deal-body">
        <span class="price-line"><strong>${esc(deal.currentPrice)}</strong>${deal.originalPrice ? deal.referenceStyle === "renewal" ? `<span class="original-price">${esc(deal.referenceLabel)} ${esc(deal.originalPrice)}</span>` : `<span class="original-price">${esc(deal.referenceLabel)} <del>${esc(deal.originalPrice)}</del></span>` : ""}</span>
${deal.savingsText ? `        <span class="saving-text">${esc(deal.savingsText)}</span>\n` : ""}${deal.priceNote ? `        <span class="price-note">${esc(deal.priceNote)}</span>\n` : ""}        <strong class="deal-title">${esc(deal.title)}</strong>
        <span class="deal-meta">${esc(deal.merchant)} · ${esc(deal.categoryLabel)} · Checked ${esc(deal.verifiedAt)}</span>
        <span class="deal-cta">View deal details</span>
      </span>
    </a>
  </article>`;
const latestCards = latestDealData.slice(1, 18).map(latestCardHTML).join("\n");
const featuredHTML = featuredDeal ? `<article class="featured-wrap latest-featured" data-deal-id="${esc(featuredDeal.id)}" data-expires-at="${esc(featuredDeal.expiresAt || "")}" data-recheck-after="${esc(featuredDeal.recheckAfter || "")}">
  <a class="featured-deal" href="${featuredCanonical}" aria-label="${esc(featuredTitle)}, ${esc(featuredPrices.current)}. View top deal">
    <span class="featured-media">
      <span class="featured-badge">Recommended</span>
      <img src="${esc(imageFor(featuredDeal))}" data-merchant-image alt="${esc(featuredTitle)}" width="800" height="520" fetchpriority="high" decoding="async" />
    </span>
    <span class="featured-content">
      <span class="featured-label">DealDesk featured pick · Checked ${esc(isoDate(featuredDeal.verifiedAt || featuredDeal.publishedAt || lastmod))}</span>
      <span class="featured-price-line"><strong>${esc(featuredPrices.current)}</strong>${featuredPrices.original ? featuredDeal.referenceStyle === "renewal" ? `<span class="featured-original">${esc(featuredDeal.referenceLabel || "Then")} ${esc(featuredPrices.original)}</span>` : `<span class="featured-original">${esc(featuredDeal.referenceLabel || "Was")} <del>${esc(featuredPrices.original)}</del></span>` : ""}</span>
      ${featuredDeal.savingsText ? `<span class="featured-saving">${esc(featuredDeal.savingsText)}</span>` : featuredSavings ? `<span class="featured-saving">Save ${money(featuredSavings)} · ${featuredDiscount}% off</span>` : ""}
      ${featuredDeal.priceNote ? `<span class="price-note">${esc(featuredDeal.priceNote)}</span>` : ""}
      <strong class="featured-title">${esc(featuredTitle)}</strong>
      <span class="featured-merchant">${esc(featuredDeal.merchantName || "Amazon")} · ${esc(featuredDeal.category || "Deal")}</span>
      <span class="featured-cta">View deal details <span aria-hidden="true">→</span></span>
      <span class="featured-fineprint">Price and availability can change at checkout.</span>
    </span>
  </a>
</article>` : "";
const latestHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Deal listings with prices and check dates | DealDesk</title>
  <meta name="description" content="Compare DealDesk catalog records with displayed prices, savings, merchants, categories, and visible check dates." />
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
  <meta name="dealdesk-build" content="2026-08-08-indexing-v1" />
  <link rel="sitemap" type="application/xml" href="/sitemap.xml" />
  <link rel="canonical" href="${site}/latest-deals/" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="Deal listings with prices and check dates | DealDesk" />
  <meta property="og:description" content="Current price, original price, savings, merchant, and freshness—without the clutter." />
  <meta property="og:url" content="${site}/latest-deals/" />
  <meta property="og:image" content="${site}/assets/dealdesk-publisher-logo.png" />
  <link rel="icon" type="image/png" href="/assets/dealdesk-publisher-logo.png" />
  <link rel="stylesheet" href="/styles.css?v=2026-08-08-indexing-v1" />
  <script src="/assets/site-shell.js?v=2026-08-08-indexing-v1" defer></script>
  <script type="application/ld+json">${JSON.stringify(latestSchema).replaceAll("<", "\\u003c")}</script>
</head>
<body class="latest-page">
  <header class="site-header"><nav class="nav shell" aria-label="Primary navigation"><a class="brand" href="/" aria-label="DealDesk home"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><form class="site-search" id="latest-deal-search-form" role="search"><label class="sr-only" for="latest-deal-search">Search deals</label><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" /></svg><input id="latest-deal-search" type="search" placeholder="Search products or merchants" autocomplete="off" /></form><div class="nav-links"><a href="/latest-deals/" aria-current="page">Latest deals</a><a href="/category/subscriptions/">Subscription deals</a><a href="/category/streaming/">Streaming deals</a><a href="/collections/">Deal guides</a><a href="/categories/">Categories</a><a class="nav-app" href="https://apps.apple.com/us/app/dealdesk/id6782424624">Get the app</a></div></nav></header>
  <main class="deal-home shell">
    <header class="page-heading">
      <div><span class="page-kicker"><span aria-hidden="true"></span> Catalog updated ${lastmod}</span><h1>Deal listings with visible check dates</h1></div>
      <p><strong id="latest-total">${pricedDeals.length}</strong> catalog records, presented in focused batches</p>
    </header>
    ${featuredHTML}
    <aside class="latest-trust-strip" aria-label="How this page is organized">
      <span><strong>Focused first view</strong><small>Start with 18 recommendations, then reveal more when you choose.</small></span>
      <span><strong>Genuine imagery only</strong><small>Offers without real merchant-provided imagery stay out of this visual catalog.</small></span>
      <span><strong>User-first ordering</strong><small>Price clarity, displayed savings, material terms, and freshness shape the order. Commission eligibility is only a publishing requirement.</small></span>
    </aside>
    <section class="deals-heading-row" aria-labelledby="latest-deals-heading">
      <div><h2 id="latest-deals-heading">More deals worth seeing</h2><p>Filter first, compare a manageable set, and expand only when useful.</p></div>
    </section>
    <section class="latest-controls" aria-label="Filter the deal catalog">
      <label for="latest-category">Category<select id="latest-category"><option value="all">All categories</option>${categoryOptions}</select></label>
      <p id="latest-catalog-status" role="status">Showing ${Math.min(18, pricedDeals.length)} of ${pricedDeals.length} catalog records</p>
    </section>
    <div class="deal-grid" id="latest-deal-grid">${latestCards}</div>
    <p class="latest-empty" id="latest-empty" hidden>No matching deal records. Try another search or category.</p>
    <div class="load-more-wrap"><button class="load-more" id="latest-load-more" type="button" hidden>Show 18 more deals</button></div>
  </main>
  <footer class="footer"><div class="shell footer-inner"><a class="brand footer-brand" href="/"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><p>Clear prices. Better clicks.</p><div class="footer-links"><a href="/support/">Support</a><a href="/privacy/">Privacy</a></div></div><div class="shell disclosure">DealDesk may earn a commission when you buy through our links. You never pay more because of it. Prices and availability can change at checkout.</div></footer>
  <script>
    (function () {
      "use strict";
      var form = document.getElementById("latest-deal-search-form");
      var input = document.getElementById("latest-deal-search");
      var grid = document.getElementById("latest-deal-grid");
      var serverCards = Array.prototype.slice.call(document.querySelectorAll(".deal-card"));
      var featured = document.querySelector(".latest-featured");
      var category = document.getElementById("latest-category");
      var status = document.getElementById("latest-catalog-status");
      var totalLabel = document.getElementById("latest-total");
      var loadMore = document.getElementById("latest-load-more");
      var empty = document.getElementById("latest-empty");
      var visibleLimit = 18;
      var catalogDeals = null;
      var catalogPromise = null;
      var rejectedIDs = new Set();
      var searchTimer;

      function timestampIsCurrent(value) {
        if (!value) return true;
        var timestamp = Date.parse(value);
        return Number.isFinite(timestamp) && Date.now() <= timestamp;
      }

      function dealIsCurrent(deal) {
        return timestampIsCurrent(deal.expiresAt);
      }

      function cardIsCurrent(card) {
        return timestampIsCurrent(card.dataset.expiresAt);
      }

      function dealMatches(deal, query, selectedCategory) {
        var queryText = [deal.title, deal.merchant, deal.categoryLabel, deal.priceNote].join(" ").toLowerCase();
        return (!query || queryText.indexOf(query) !== -1) &&
          (selectedCategory === "all" || deal.category === selectedCategory);
      }

      function addText(parent, tagName, className, value) {
        var node = document.createElement(tagName);
        if (className) node.className = className;
        node.textContent = value;
        parent.appendChild(node);
        return node;
      }

      function makeCard(deal, eager) {
        var card = document.createElement("article");
        card.className = "deal-card";
        card.dataset.dealId = deal.id;
        card.dataset.category = deal.category;
        var link = document.createElement("a");
        link.className = "deal-card-link";
        link.href = deal.url;
        link.setAttribute("aria-label", deal.title + ", " + deal.currentPrice + ". View deal details");
        var media = document.createElement("span");
        media.className = "deal-media";
        if (deal.badgeText) addText(media, "span", "discount-badge", deal.badgeText);
        var image = document.createElement("img");
        image.alt = deal.title;
        image.width = 800;
        image.height = 520;
        image.loading = eager ? "eager" : "lazy";
        if (eager) image.setAttribute("fetchpriority", "high");
        image.decoding = "async";
        image.setAttribute("data-merchant-image", "");
        var rejectCard = function () {
          if (rejectedIDs.has(deal.id)) return;
          rejectedIDs.add(deal.id);
          card.remove();
          renderDeals();
        };
        image.addEventListener("error", rejectCard);
        image.addEventListener("load", function () {
          if (image.naturalWidth <= 2 || image.naturalHeight <= 2) rejectCard();
        });
        image.src = deal.imageURL;
        media.appendChild(image);
        var body = document.createElement("span");
        body.className = "deal-body";
        var priceLine = document.createElement("span");
        priceLine.className = "price-line";
        addText(priceLine, "strong", "", deal.currentPrice);
        if (deal.originalPrice) {
          var original = document.createElement("span");
          original.className = "original-price";
          if (deal.referenceStyle === "renewal") {
            original.textContent = deal.referenceLabel + " " + deal.originalPrice;
          } else {
            original.appendChild(document.createTextNode(deal.referenceLabel + " "));
            addText(original, "del", "", deal.originalPrice);
          }
          priceLine.appendChild(original);
        }
        body.appendChild(priceLine);
        if (deal.savingsText) addText(body, "span", "saving-text", deal.savingsText);
        if (deal.priceNote) addText(body, "span", "price-note", deal.priceNote);
        addText(body, "strong", "deal-title", deal.title);
        addText(body, "span", "deal-meta", deal.merchant + " · " + deal.categoryLabel + " · Checked " + deal.verifiedAt);
        addText(body, "span", "deal-cta", "View deal details");
        link.appendChild(media);
        link.appendChild(body);
        card.appendChild(link);
        return card;
      }

      function renderDeals() {
        if (!catalogDeals) return;
        var qualifiedTotal = catalogDeals.reduce(function (count, deal) {
          return count + (rejectedIDs.has(deal.id) ? 0 : 1);
        }, 0);
        totalLabel.textContent = String(qualifiedTotal);
        var query = input.value.trim().toLowerCase();
        var selectedCategory = category.value;
        var featuredDeal = catalogDeals[0];
        var featuredMatch = Boolean(
          featured &&
          featuredDeal &&
          featured.dataset.dealId === featuredDeal.id &&
          featured.dataset.imageFailed !== "true" &&
          cardIsCurrent(featured) &&
          !rejectedIDs.has(featuredDeal.id) &&
          selectedCategory === "all" &&
          dealMatches(featuredDeal, query, selectedCategory)
        );
        if (featured) featured.hidden = !featuredMatch;
        var matching = catalogDeals.filter(function (deal, index) {
          if (rejectedIDs.has(deal.id)) return false;
          if (index === 0 && featuredMatch) return false;
          return dealMatches(deal, query, selectedCategory);
        });
        var cardLimit = Math.max(0, visibleLimit - (featuredMatch ? 1 : 0));
        var shownDeals = matching.slice(0, cardLimit);
        var fragment = document.createDocumentFragment();
        shownDeals.forEach(function (deal, index) {
          fragment.appendChild(makeCard(deal, !featuredMatch && index === 0));
        });
        grid.replaceChildren(fragment);
        var shown = shownDeals.length + (featuredMatch ? 1 : 0);
        var total = matching.length + (featuredMatch ? 1 : 0);
        status.textContent = "Showing " + shown + " of " + total + " matching catalog records";
        loadMore.hidden = total <= visibleLimit;
        empty.hidden = total !== 0;
      }

      function serverViewMatchesCatalog() {
        if (!catalogDeals || input.value.trim() || category.value !== "all") return false;
        var expected = catalogDeals.filter(function (deal) {
          return !rejectedIDs.has(deal.id);
        }).slice(0, visibleLimit).map(function (deal) { return deal.id; });
        var actual = [];
        if (featured && !featured.hidden && featured.dataset.imageFailed !== "true" && cardIsCurrent(featured)) {
          actual.push(featured.dataset.dealId);
        }
        serverCards.forEach(function (card) {
          if (!card.hidden && card.dataset.imageFailed !== "true" && cardIsCurrent(card)) {
            actual.push(card.dataset.dealId);
          }
        });
        return expected.length === actual.length && expected.every(function (id, index) {
          return id === actual[index];
        });
      }

      function filterServerCards() {
        var query = input.value.trim().toLowerCase();
        var selectedCategory = category.value;
        var shown = 0;
        serverCards.forEach(function (card) {
          var match = card.dataset.imageFailed !== "true" && cardIsCurrent(card) &&
            (!query || card.textContent.toLowerCase().indexOf(query) !== -1) &&
            (selectedCategory === "all" || card.dataset.category === selectedCategory);
          card.hidden = !match;
          if (match) shown += 1;
        });
        var featuredMatch = featured && featured.dataset.imageFailed !== "true" && cardIsCurrent(featured) &&
          selectedCategory === "all" && (!query || featured.textContent.toLowerCase().indexOf(query) !== -1);
        if (featured) featured.hidden = !featuredMatch;
        if (featuredMatch) shown += 1;
        status.textContent = "Showing " + shown + " catalog records; the full catalog is temporarily unavailable";
        loadMore.hidden = true;
        empty.hidden = shown !== 0;
      }

      function loadCatalog() {
        if (catalogDeals) return Promise.resolve(true);
        if (catalogPromise) return catalogPromise;
        catalogPromise = fetch("/data/latest-deals.json?v=${latestCatalogVersion}", { cache: "no-store" })
          .then(function (response) {
            if (!response.ok) throw new Error("Catalog unavailable");
            return response.json();
          })
          .then(function (payload) {
            if (!payload || !Array.isArray(payload.deals)) throw new Error("Catalog invalid");
            catalogDeals = payload.deals.filter(dealIsCurrent);
            totalLabel.textContent = String(catalogDeals.length);
            loadMore.hidden = catalogDeals.length <= visibleLimit;
            return true;
          })
          .catch(function () {
            catalogPromise = null;
            return false;
          });
        return catalogPromise;
      }

      function requestRender(resetLimit) {
        if (resetLimit) visibleLimit = 18;
        status.textContent = "Loading matching catalog records…";
        loadCatalog().then(function (ready) {
          if (ready) renderDeals();
          else filterServerCards();
        });
      }

      serverCards.concat(featured ? [featured] : []).forEach(function (card) {
        if (!cardIsCurrent(card)) {
          if (card.dataset.dealId) rejectedIDs.add(card.dataset.dealId);
          card.hidden = true;
          return;
        }
        var image = card.querySelector("img[data-merchant-image]");
        if (!image) return;
        var rejectCard = function () {
          if (card.dataset.imageFailed === "true") return;
          card.dataset.imageFailed = "true";
          if (card.dataset.dealId) rejectedIDs.add(card.dataset.dealId);
          card.hidden = true;
          loadCatalog().then(function (ready) {
            if (ready) renderDeals();
            else filterServerCards();
          });
        };
        image.addEventListener("error", rejectCard);
        image.addEventListener("load", function () {
          if (image.naturalWidth <= 2 || image.naturalHeight <= 2) rejectCard();
        });
        if (image.complete && (image.naturalWidth <= 2 || image.naturalHeight <= 2)) rejectCard();
      });
      input.addEventListener("input", function () {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(function () { requestRender(true); }, 140);
      });
      category.addEventListener("change", function () { requestRender(true); });
      loadMore.addEventListener("click", function () {
        visibleLimit += 18;
        requestRender(false);
      });
      form.addEventListener("submit", function (event) { event.preventDefault(); });
      var idle = window.requestIdleCallback || function (callback) { return window.setTimeout(callback, 250); };
      idle(function () {
        loadCatalog().then(function (ready) {
          if (!ready) return;
          if (!serverViewMatchesCatalog()) {
            renderDeals();
            return;
          }
          status.textContent = "Showing " + Math.min(visibleLimit, catalogDeals.length) + " of " + catalogDeals.length + " matching catalog records";
          loadMore.hidden = catalogDeals.length <= visibleLimit;
          empty.hidden = catalogDeals.length !== 0;
        });
      });
    }());
  </script>
</body>
</html>`;
await mkdir(resolve(root, "latest-deals"), { recursive: true });
const searchIndexDeals = latestDealData.map((deal) => {
  const sourceDeal = deals.find((candidate) => candidate.id === deal.id);
  const state = searchIndexStateFor(sourceDeal || deal);
  return {
    id: deal.id,
    url: deal.url,
    indexable: state.indexable,
    reason: state.reason,
    verifiedAt: deal.verifiedAt || null,
    recheckAfter: deal.recheckAfter || null,
    lastmod: deal.verifiedAt || null,
  };
});
const indexableDealCount = searchIndexDeals.filter((deal) => deal.indexable).length;
await writeFile(resolve(root, "data", "latest-deals.json"), `${JSON.stringify({
  updatedAt: new Date(latestFeedTime).toISOString(),
  total: latestDealData.length,
  deals: latestDealData
})}\n`);
await writeFile(resolve(root, "data", "search-index.json"), `${JSON.stringify({
  version: SEARCH_INDEX_POLICY_VERSION,
  policy: SEARCH_INDEX_POLICY_NAME,
  evaluatedAt: new Date(now).toISOString(),
  catalogUpdatedAt: new Date(latestFeedTime).toISOString(),
  publicDeals: searchIndexDeals.length,
  indexableDeals: indexableDealCount,
  browseOnlyDeals: searchIndexDeals.length - indexableDealCount,
  deals: searchIndexDeals,
}, null, 2)}\n`);
await writeFile(resolve(root, "data", "outbound-approvals.json"), `${JSON.stringify({
  generatedAt: new Date(latestFeedTime).toISOString(),
  deals: deals.map((deal) => ({
    id: deal.id,
    network: deal.network,
    affiliateURL: deal.affiliateURL,
    validUntil: validUntilFor(deal)
  }))
}, null, 2)}\n`);
await writeFile(resolve(root, "latest-deals", "index.html"), latestHTML);

const urls = [
  { path: "/", lastmod, changefreq: "daily", priority: "1.0" },
  { path: "/latest-deals/", lastmod, changefreq: "daily", priority: "0.9" },
  { path: "/privacy/", lastmod, changefreq: "monthly", priority: "0.3" },
  { path: "/support/", lastmod, changefreq: "monthly", priority: "0.3" },
  ...deals.filter((deal) => searchIndexStateFor(deal).indexable).map((deal) => ({
    path: `/deals/${slugFor(deal)}/`,
    lastmod: isoDate(deal.verifiedAt || deal.publishedAt || lastmod),
    changefreq: "daily",
    priority: "0.8"
  }))
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((entry) => `  <url><loc>${site}${entry.path}</loc><lastmod>${entry.lastmod}</lastmod><changefreq>${entry.changefreq}</changefreq><priority>${entry.priority}</priority></url>`).join("\n")}
</urlset>\n`;
await writeFile(resolve(root, "sitemap.xml"), sitemap);
await writeFile(resolve(root, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`);
await writeFile(resolve(root, "404.html"), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Page not found | DealDesk</title>
  <meta name="robots" content="noindex,nofollow" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="site-header"><nav class="nav shell" aria-label="Primary navigation"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><div class="nav-links"><a href="/latest-deals/">Latest deals</a><a href="/category/subscriptions/">Subscription deals</a><a href="/category/streaming/">Streaming deals</a><a href="/collections/">Deal guides</a><a href="/categories/">Categories</a></div></nav></header>
  <main class="deal-detail shell"><article class="deal-detail-card"><div class="deal-detail-content"><span class="page-kicker"><span aria-hidden="true"></span> DealDesk</span><h1>That page is no longer available</h1><p class="deal-detail-summary">The offer may have been removed because it no longer meets DealDesk's publishing requirements.</p><p><a class="deal-detail-cta" href="/latest-deals/">Browse the deal catalog</a></p></div></article></main>
</body>
</html>\n`);
console.log(`Built ${deals.length} browseable deal pages (${indexableDealCount} quality-tier indexable, ${deals.length - indexableDealCount} browse-only) and sitemap.xml; withheld ${withheldDealCount} live offers without genuine merchant imagery and ${commissionBlockedDealCount} offers without a verified commission-accrual path. ${verificationDueDealCount} active offers are due for a verification refresh but remain browseable until hard expiry or an explicit status change.`);
