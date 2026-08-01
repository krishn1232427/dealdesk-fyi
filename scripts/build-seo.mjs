import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = "https://dealdesk.fyi";
const now = Date.now();
const feeds = await Promise.all([
  readFile(resolve(root, "data/best-deals.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/streaming-deals.json"), "utf8").then(JSON.parse)
]);
const isLiveDeal = (deal) => {
  const expiresAt = deal.expiresAt ? new Date(deal.expiresAt).getTime() : Infinity;
  const recheckAfter = deal.recheckAfter ? new Date(deal.recheckAfter).getTime() : Infinity;
  return deal.status === "active" &&
    deal.commissionEligible === true &&
    deal.approvalStatus === "approved" &&
    Boolean(deal.affiliateURL) &&
    Boolean(deal.verifiedAt) &&
    now <= expiresAt &&
    now <= recheckAfter;
};
const deals = feeds.flatMap((feed) => feed.deals || []).filter(isLiveDeal);

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
  });
  return `/out/?${params.toString()}`;
};
const pricesFrom = (deal) => {
  const matches = String(deal?.summary || deal || "").match(/\$[\d,]+(?:\.\d{2})?/g) || [];
  return {
    current: deal?.currentPrice || matches[0] || "",
    original: deal?.originalPrice || matches[1] || ""
  };
};
const numberFromPrice = (price) => Number(String(price).replace(/[^0-9.]/g, ""));
const hasMonetaryPrice = (price) => /^\s*(?:US)?\$\s*\d/.test(String(price || ""));
const isoDate = (value) => {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
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
const categoryImage = (deal) => {
  const category = String(deal?.category || "").toLowerCase();
  if (category.includes("fashion")) return "/assets/categories/fashion.svg";
  if (category.includes("electronic") || category.includes("tech")) return "/assets/categories/electronics.svg";
  if (category.includes("home")) return "/assets/categories/home.svg";
  if (category.includes("business") || category.includes("industrial")) return "/assets/categories/business.svg";
  if (category.includes("grocery")) return "/assets/categories/grocery.svg";
  return "/assets/categories/collectibles.svg";
};
const imageFor = (deal) => {
  if (deal?.imageURL) return deal.imageURL;
  const asin = asinFrom(deal);
  return asin ? `https://images-na.ssl-images-amazon.com/images/P/${asin}.01.LZZZZZZZ.jpg` : categoryImage(deal);
};
const earningPotential = (deal) => {
  const estimate = Number(deal?.estimatedCommission);
  if (Number.isFinite(estimate) && estimate >= 0) return estimate;
  const fixedBounty = String(deal?.commission || "").match(/^\$(\d+(?:\.\d+)?)/);
  return fixedBounty ? Number(fixedBounty[1]) : 0;
};
const publicDescription = (deal, title, prices, updated) => {
  const merchant = deal.merchantName || "the merchant";
  const discount = discountFrom(prices, deal);
  if (prices.current && prices.original) {
    if (deal.referenceStyle === "renewal") {
      return `DealDesk found ${title} at ${merchant} for ${prices.current} during the introductory period. ${deal.referenceLabel || "Then"} ${prices.original}. ${deal.savingsText || "Confirm eligibility and renewal terms"}. Price checked ${isoDate(updated)}; availability can change.`;
    }
    const priceContext = deal.savingsText ? `. The live offer advertises ${deal.savingsText}.` : discount ? ` (${discount}% off).` : ".";
    return `DealDesk found ${title} at ${merchant} for ${prices.current}, down from ${prices.original}${priceContext} Price checked ${isoDate(updated)}; availability can change.`;
  }
  if (prices.current) {
    return `DealDesk found ${title} at ${merchant} for ${prices.current}. Price checked ${isoDate(updated)}; availability can change.`;
  }
  return `${title} offer from ${merchant}. Check eligibility, current pricing, and availability with the merchant.`;
};

await rm(resolve(root, "deals"), { recursive: true, force: true });

for (const deal of deals) {
  const slug = slugFor(deal);
  const canonical = `${site}/deals/${slug}/`;
  const title = cleanTitle(deal.title);
  const prices = pricesFrom(deal);
  const image = imageFor(deal);
  const updated = deal.publishedAt || deal.verifiedAt || feeds[0].updatedAt;
  const description = publicDescription(deal, title, prices, updated);
  const asin = asinFrom(deal);
  const discount = discountFrom(prices, deal);
  const savings = savingsFrom(prices);
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
    "@type": "Product",
    name: title,
    description,
    category: deal.category || "Deals",
    url: canonical,
    mainEntityOfPage: canonical,
    ...(asin ? { sku: asin } : {}),
    ...(image ? { image: [image] } : {}),
    offers: {
      "@type": "Offer",
      url: deal.affiliateURL,
      priceCurrency: "USD",
      price: numberFromPrice(prices.current).toFixed(2),
      availability: "https://schema.org/InStock",
      itemCondition: "https://schema.org/NewCondition",
      seller: { "@type": "Organization", name: deal.merchantName || "Amazon" }
    }
  } : {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${title} offer`,
    description,
    url: canonical,
    ...(image ? { primaryImageOfPage: image } : {})
  };
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} deal | DealDesk</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
  <link rel="canonical" href="${canonical}" />
  <meta property="og:type" content="${hasMonetaryPrice(prices.current) ? "product" : "website"}" />
  <meta property="og:title" content="${esc(title)} deal" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${canonical}" />
${image ? `  <meta property="og:image" content="${esc(image)}" />\n` : ""}  <link rel="icon" type="image/png" href="/assets/dealdesk-publisher-logo.png" />
  <link rel="stylesheet" href="/styles.css" />
  <script type="application/ld+json">${JSON.stringify(schema).replaceAll("<", "\\u003c")}</script>
</head>
<body>
  <header class="site-header"><nav class="nav shell" aria-label="Primary navigation"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><div class="nav-links"><a href="/latest-deals/">Latest deals</a><a href="/#deal-categories">Categories</a><a href="/#how-we-check">How we check</a><a href="/#streaming">Streaming</a></div></nav></header>
  <main class="deal-detail shell">
    <nav class="deal-breadcrumb" aria-label="Breadcrumb"><a href="/">DealDesk</a><span aria-hidden="true">›</span><a href="/latest-deals/">Latest deals</a><span aria-hidden="true">›</span><span>${esc(title)}</span></nav>
    <article class="deal-detail-card">
      <div class="deal-detail-media">${image ? `<img src="${esc(image)}" alt="${esc(title)}" />` : `<span class="product-fallback" aria-hidden="true">D</span>`}</div>
      <div class="deal-detail-content">
        <span class="page-kicker"><span aria-hidden="true"></span> ${esc(deal.category || "Featured deal")}</span>
        <h1>${esc(title)}</h1>
        ${prices.current ? `<p class="deal-detail-price"><strong>${esc(prices.current)}</strong>${prices.original ? deal.referenceStyle === "renewal" ? ` <span>${esc(deal.referenceLabel || "Then")} ${esc(prices.original)}</span>` : ` <span>${esc(deal.referenceLabel || "Reference price")} <del>${esc(prices.original)}</del></span>` : ""}</p>` : ""}
${deal.priceNote ? `        <p class="deal-detail-price-note">${esc(deal.priceNote)}</p>\n` : ""}        <p class="deal-detail-summary">${esc(description)}</p>
        <p class="deal-detail-meta">Listed by ${esc(deal.merchantName || "Amazon")} · Checked ${esc(isoDate(deal.verifiedAt))} · ${esc(lifecycleText(deal))}</p>
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

const lastmod = isoDate(Math.max(...feeds.map((feed) => new Date(feed.updatedAt || 0).getTime())));
const pricedDeals = deals.filter((deal) => pricesFrom(deal).current)
  .sort((a, b) => earningPotential(b) - earningPotential(a) || rankingNumber(b) - rankingNumber(a));
const featuredDeal = pricedDeals[0];
const featuredPrices = pricesFrom(featuredDeal);
const featuredDiscount = discountFrom(featuredPrices, featuredDeal);
const featuredSavings = savingsFrom(featuredPrices);
const featuredTitle = cleanTitle(featuredDeal?.title);
const featuredCanonical = featuredDeal ? `/deals/${slugFor(featuredDeal)}/` : "/#all-deals";
const latestSchema = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "Latest verified deals",
  description: "Hand-picked deals with current price, original price, savings, merchant, and freshness shown clearly.",
  url: `${site}/latest-deals/`,
  mainEntity: {
    "@type": "ItemList",
    numberOfItems: pricedDeals.length,
    itemListElement: pricedDeals.map((deal, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: cleanTitle(deal.title),
      url: `${site}/deals/${slugFor(deal)}/`
    }))
  }
};
const latestCards = pricedDeals.slice(1).map((deal) => {
  const title = cleanTitle(deal.title);
  const prices = pricesFrom(deal);
  const discount = discountFrom(prices, deal);
  const savings = savingsFrom(prices);
  const canonical = `/deals/${slugFor(deal)}/`;
  const image = imageFor(deal);
  const updated = deal.publishedAt || deal.verifiedAt || lastmod;
  return `<article class="deal-card">
    <a class="deal-card-link" href="${canonical}" aria-label="${esc(title)}, ${esc(prices.current)}. View deal details">
      <span class="deal-media">
${deal.badgeText ? `        <span class="discount-badge">${esc(deal.badgeText)}</span>\n` : discount ? `        <span class="discount-badge">${discount}% off</span>\n` : ""}        ${image ? `<img src="${esc(image)}" alt="${esc(title)}" loading="lazy" />` : `<span class="product-fallback" aria-hidden="true">D</span>`}
      </span>
      <span class="deal-body">
        <span class="price-line"><strong>${esc(prices.current)}</strong>${prices.original ? deal.referenceStyle === "renewal" ? `<span class="original-price">${esc(deal.referenceLabel || "Then")} ${esc(prices.original)}</span>` : `<span class="original-price">${esc(deal.referenceLabel || "Was")} <del>${esc(prices.original)}</del></span>` : ""}</span>
${deal.savingsText ? `        <span class="saving-text">${esc(deal.savingsText)}</span>\n` : savings ? `        <span class="saving-text">Save ${money(savings)} · ${discount}% off</span>\n` : ""}${deal.priceNote ? `        <span class="price-note">${esc(deal.priceNote)}</span>\n` : ""}        <strong class="deal-title">${esc(title)}</strong>
        <span class="deal-meta">${esc(deal.merchantName || "Amazon")} · ${esc(deal.category || "Deal")} · Checked ${esc(isoDate(deal.verifiedAt))}</span>
        <span class="deal-cta">View deal details</span>
      </span>
    </a>
  </article>`;
}).join("\n");
const featuredHTML = featuredDeal ? `<article class="featured-wrap latest-featured">
  <a class="featured-deal" href="${featuredCanonical}" aria-label="${esc(featuredTitle)}, ${esc(featuredPrices.current)}. View top deal">
    <span class="featured-media">
      <span class="featured-badge">Top earning offer</span>
      <img src="${esc(imageFor(featuredDeal))}" alt="${esc(featuredTitle)}" />
    </span>
    <span class="featured-content">
      <span class="featured-label">DealDesk top earning pick · Checked ${esc(isoDate(featuredDeal.publishedAt || lastmod))}</span>
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
  <title>Latest verified deals | DealDesk</title>
  <meta name="description" content="Hand-picked deals with current price, original price, savings, merchant, and freshness shown clearly." />
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1" />
  <link rel="canonical" href="${site}/latest-deals/" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="Latest verified deals | DealDesk" />
  <meta property="og:description" content="Current price, original price, savings, merchant, and freshness—without the clutter." />
  <meta property="og:url" content="${site}/latest-deals/" />
  <meta property="og:image" content="${site}/assets/dealdesk-publisher-logo.png" />
  <link rel="icon" type="image/png" href="/assets/dealdesk-publisher-logo.png" />
  <link rel="stylesheet" href="/styles.css" />
  <script type="application/ld+json">${JSON.stringify(latestSchema).replaceAll("<", "\\u003c")}</script>
</head>
<body>
  <header class="site-header"><nav class="nav shell" aria-label="Primary navigation"><a class="brand" href="/" aria-label="DealDesk home"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><form class="site-search" id="latest-deal-search-form" role="search"><label class="sr-only" for="latest-deal-search">Search deals</label><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" /></svg><input id="latest-deal-search" type="search" placeholder="Search products or merchants" autocomplete="off" /></form><div class="nav-links"><a href="/latest-deals/" aria-current="page">Latest deals</a><a href="/#deal-categories">Categories</a><a href="/#how-we-check">How we check</a><a href="/#streaming">Streaming</a><a class="nav-app" href="https://apps.apple.com/us/app/dealdesk/id6782424624">Get the app</a></div></nav></header>
  <main class="deal-home shell">
    <header class="page-heading">
      <div><span class="page-kicker"><span aria-hidden="true"></span> Checked ${lastmod}</span><h1>Latest verified deals</h1></div>
      <p><strong>${pricedDeals.length}</strong> current product deals with clear savings</p>
    </header>
    ${featuredHTML}
    <section class="deals-heading-row" aria-labelledby="latest-deals-heading">
      <div><h2 id="latest-deals-heading">More deals worth seeing</h2><p>Compare current prices and savings at a glance.</p></div>
    </section>
    <div class="deal-grid">${latestCards}</div>
  </main>
  <footer class="footer"><div class="shell footer-inner"><a class="brand footer-brand" href="/"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><p>Clear prices. Better clicks.</p><div class="footer-links"><a href="/support/">Support</a><a href="/privacy/">Privacy</a></div></div><div class="shell disclosure">DealDesk may earn a commission when you buy through our links. You never pay more because of it. Prices and availability can change at checkout.</div></footer>
  <script>
    (function () {
      "use strict";
      var form = document.getElementById("latest-deal-search-form");
      var input = document.getElementById("latest-deal-search");
      var cards = Array.prototype.slice.call(document.querySelectorAll(".deal-card"));
      var featured = document.querySelector(".latest-featured");

      function filterDeals() {
        var query = input.value.trim().toLowerCase();
        cards.forEach(function (card) {
          card.hidden = Boolean(query && card.textContent.toLowerCase().indexOf(query) === -1);
        });
        if (featured) featured.hidden = Boolean(query && featured.textContent.toLowerCase().indexOf(query) === -1);
      }

      input.addEventListener("input", filterDeals);
      form.addEventListener("submit", function (event) { event.preventDefault(); });
    }());
  </script>
</body>
</html>`;
await mkdir(resolve(root, "latest-deals"), { recursive: true });
await writeFile(resolve(root, "latest-deals", "index.html"), latestHTML);

const urls = [
  { path: "/", lastmod, changefreq: "daily", priority: "1.0" },
  { path: "/latest-deals/", lastmod, changefreq: "daily", priority: "0.9" },
  { path: "/privacy/", lastmod, changefreq: "monthly", priority: "0.3" },
  { path: "/support/", lastmod, changefreq: "monthly", priority: "0.3" },
  ...deals.map((deal) => ({
    path: `/deals/${slugFor(deal)}/`,
    lastmod: isoDate(deal.publishedAt || deal.verifiedAt || lastmod),
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
console.log(`Built ${deals.length} indexable deal pages and sitemap.xml.`);
