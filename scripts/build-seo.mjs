import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = "https://dealdesk.fyi";
const feeds = await Promise.all([
  readFile(resolve(root, "data/best-deals.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/streaming-deals.json"), "utf8").then(JSON.parse)
]);
const deals = feeds.flatMap((feed) => feed.deals || []).filter((deal) =>
  deal.commissionEligible === true && deal.approvalStatus === "approved" && deal.affiliateURL
);

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const cleanTitle = (title) => String(title || "Deal").replace(/\s+[—–-]\s+\d+%\s+off\s*$/i, "");
const slugFor = (deal) => String(deal.id || "deal").replace(/-\d{8}$/, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pricesFrom = (summary) => {
  const matches = String(summary || "").match(/\$[\d,]+(?:\.\d{2})?/g) || [];
  return { current: matches[0] || "", original: matches[1] || "" };
};
const numberFromPrice = (price) => Number(String(price).replace(/[^0-9.]/g, ""));
const isoDate = (value) => {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
};

await rm(resolve(root, "deals"), { recursive: true, force: true });

for (const deal of deals) {
  const slug = slugFor(deal);
  const canonical = `${site}/deals/${slug}/`;
  const title = cleanTitle(deal.title);
  const prices = pricesFrom(deal.summary);
  const image = deal.imageURL || "";
  const updated = deal.publishedAt || deal.verifiedAt || feeds[0].updatedAt;
  const schema = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: title,
    description: deal.summary,
    category: deal.category || "Deals",
    url: canonical,
    ...(image ? { image: [image] } : {}),
    offers: {
      "@type": "Offer",
      url: deal.affiliateURL,
      priceCurrency: "USD",
      ...(prices.current ? { price: numberFromPrice(prices.current).toFixed(2) } : {}),
      availability: "https://schema.org/InStock",
      seller: { "@type": "Organization", name: deal.merchantName || "Amazon" }
    }
  };
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} deal | DealDesk</title>
  <meta name="description" content="${esc(deal.summary)}" />
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
  <link rel="canonical" href="${canonical}" />
  <meta property="og:type" content="product" />
  <meta property="og:title" content="${esc(title)} deal" />
  <meta property="og:description" content="${esc(deal.summary)}" />
  <meta property="og:url" content="${canonical}" />
  ${image ? `<meta property="og:image" content="${esc(image)}" />` : ""}
  <link rel="stylesheet" href="/styles.css" />
  <script type="application/ld+json">${JSON.stringify(schema).replaceAll("<", "\\u003c")}</script>
</head>
<body>
  <header class="site-header"><nav class="nav shell" aria-label="Primary navigation"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><div class="nav-links"><a href="/#all-deals">All deals</a><a href="/#streaming">Streaming</a></div></nav></header>
  <main class="deal-detail shell">
    <nav class="deal-breadcrumb" aria-label="Breadcrumb"><a href="/">DealDesk</a><span aria-hidden="true">›</span><a href="/#all-deals">Deals</a><span aria-hidden="true">›</span><span>${esc(title)}</span></nav>
    <article class="deal-detail-card">
      <div class="deal-detail-media">${image ? `<img src="${esc(image)}" alt="${esc(title)}" />` : `<span class="product-fallback" aria-hidden="true">D</span>`}</div>
      <div class="deal-detail-content">
        <span class="page-kicker"><span aria-hidden="true"></span> ${esc(deal.category || "Featured deal")}</span>
        <h1>${esc(title)}</h1>
        ${prices.current ? `<p class="deal-detail-price"><strong>${esc(prices.current)}</strong>${prices.original ? ` <span>Reference price <del>${esc(prices.original)}</del></span>` : ""}</p>` : ""}
        <p class="deal-detail-summary">${esc(deal.summary)}</p>
        <p class="deal-detail-meta">Listed by ${esc(deal.merchantName || "Amazon")} · Checked ${esc(isoDate(updated))}</p>
        <a class="deal-detail-cta" href="${esc(deal.affiliateURL)}" rel="sponsored nofollow noopener" target="_blank">Check current price on ${esc(deal.merchantName || "Amazon")} <span aria-hidden="true">→</span></a>
        <p class="deal-detail-fineprint">Price, eligibility, and availability can change. Confirm the final terms with the merchant before purchasing.</p>
      </div>
    </article>
    <section class="deal-more"><h2>More deals worth seeing</h2><p><a href="/#all-deals">Browse all current DealDesk picks</a></p></section>
  </main>
  <footer class="footer"><div class="shell footer-inner"><a class="brand footer-brand" href="/"><span class="brand-mark" aria-hidden="true">D</span><span>DealDesk</span></a><p>Clear prices. Better clicks.</p><div class="footer-links"><a href="/support/">Support</a><a href="/privacy/">Privacy</a></div></div><div class="shell disclosure">DealDesk may earn a commission when you buy through our links. You never pay more because of it.</div></footer>
</body>
</html>`;
  const output = resolve(root, "deals", slug, "index.html");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html);
}

const lastmod = isoDate(Math.max(...feeds.map((feed) => new Date(feed.updatedAt || 0).getTime())));
const urls = ["/", "/privacy/", "/support/", ...deals.map((deal) => `/deals/${slugFor(deal)}/`)];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((path) => `  <url><loc>${site}${path}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n")}
</urlset>\n`;
await writeFile(resolve(root, "sitemap.xml"), sitemap);
await writeFile(resolve(root, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`);
console.log(`Built ${deals.length} indexable deal pages and sitemap.xml.`);
