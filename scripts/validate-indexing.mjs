import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const site = "https://dealdesk.fyi";
const buildID = "2026-08-08-crawl-v2";
const archivePageSize = 32;
const categoryPageSize = 32;
const priorityDealCount = 100;
const errors = [];

const latestCatalog = JSON.parse(await readFile(resolve(root, "data/latest-deals.json"), "utf8"));
const indexingReport = JSON.parse(await readFile(resolve(root, "data/indexing-report.json"), "utf8"));
const deals = Array.isArray(latestCatalog.deals) ? latestCatalog.deals : [];

const slugify = (value) => String(value || "other").toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "") || "other";
const dealPath = (deal) => String(deal.url || `/deals/${slugify(deal.id)}/`);
const absolute = (path) => `${site}${path}`;
const pagePath = (basePath, page) => page === 1 ? basePath : `${basePath}page/${page}/`;
const pageFile = (baseDirectory, page) => page === 1
  ? resolve(baseDirectory, "index.html")
  : resolve(baseDirectory, "page", String(page), "index.html");
const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
  items.slice(index * size, (index + 1) * size)
);
const count = (text, pattern) => (text.match(pattern) || []).length;

if (!deals.length) errors.push("data/latest-deals.json: public catalog is empty");
if (Number(latestCatalog.total) !== deals.length) errors.push("data/latest-deals.json: total does not match deals length");
if (indexingReport.build !== buildID) errors.push("data/indexing-report.json: unexpected build identifier");
if (Number(indexingReport.publicDeals) !== deals.length) errors.push("data/indexing-report.json: public deal count mismatch");
if (!Array.isArray(indexingReport.orphanDeals) || indexingReport.orphanDeals.length) {
  errors.push(`data/indexing-report.json: orphan deals must be empty (${(indexingReport.orphanDeals || []).join(", ")})`);
}

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
const categoryByDealID = new Map(categories.flatMap((category) =>
  category.deals.map((deal) => [deal.id, category])
));

const assertIndexablePage = (html, label, canonicalPath) => {
  if (!html.includes('content="index,follow')) errors.push(`${label}: missing index,follow robots directive`);
  if (html.includes('content="noindex')) errors.push(`${label}: contains noindex`);
  if (html.includes('http-equiv="refresh"')) errors.push(`${label}: contains meta refresh`);
  if (html.includes('window.location.replace("/latest-deals/")')) errors.push(`${label}: contains client-side redirect`);
  if (!html.includes(`name="dealdesk-build" content="${buildID}"`)) errors.push(`${label}: missing current build marker`);
  if (!html.includes(`rel="canonical" href="${absolute(canonicalPath)}"`)) errors.push(`${label}: canonical does not match ${canonicalPath}`);
  if (!html.includes('/assets/indexing.css')) errors.push(`${label}: missing indexing stylesheet`);
};

const archivePages = chunk(deals, archivePageSize);
const archiveLinkedIDs = new Set();
for (let pageIndex = 0; pageIndex < archivePages.length; pageIndex += 1) {
  const page = pageIndex + 1;
  const pageDeals = archivePages[pageIndex];
  const path = pagePath("/deals/", page);
  const label = `archive:${path}`;
  let html = "";
  try {
    html = await readFile(pageFile(resolve(root, "deals"), page), "utf8");
  } catch {
    errors.push(`${label}: page is missing`);
    continue;
  }
  assertIndexablePage(html, label, path);
  if (page > 1 && !html.includes(`href="${pagePath("/deals/", page - 1)}"`)) errors.push(`${label}: missing previous-page link`);
  if (page < archivePages.length && !html.includes(`href="${pagePath("/deals/", page + 1)}"`)) errors.push(`${label}: missing next-page link`);
  for (const deal of pageDeals) {
    const expected = `href="${dealPath(deal)}"`;
    if (!html.includes(expected)) errors.push(`${label}: missing deal link ${deal.id}`);
    archiveLinkedIDs.add(deal.id);
  }
  const archiveDealLinkCount = count(html, /href="\/deals\/(?!page\/)[^"]+\/"/g);
  if (archiveDealLinkCount < pageDeals.length) errors.push(`${label}: fewer crawlable deal links than expected`);
}
if (archiveLinkedIDs.size !== deals.length) errors.push(`archive: linked ${archiveLinkedIDs.size} of ${deals.length} deals`);
if (Number(indexingReport.archivePages) !== archivePages.length) errors.push("data/indexing-report.json: archive-page count mismatch");

let categoriesIndex = "";
try {
  categoriesIndex = await readFile(resolve(root, "categories", "index.html"), "utf8");
  assertIndexablePage(categoriesIndex, "categories:/categories/", "/categories/");
} catch {
  errors.push("categories:/categories/: page is missing");
}
const categoryLinkedIDs = new Set();
let categoryPageCount = 0;
for (const category of categories) {
  if (categoriesIndex && !categoriesIndex.includes(`href="/category/${category.key}/"`)) {
    errors.push(`categories:/categories/: missing ${category.label} link`);
  }
  const pages = chunk(category.deals, categoryPageSize);
  const basePath = `/category/${category.key}/`;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    categoryPageCount += 1;
    const page = pageIndex + 1;
    const path = pagePath(basePath, page);
    const label = `category:${path}`;
    let html = "";
    try {
      html = await readFile(pageFile(resolve(root, "category", category.key), page), "utf8");
    } catch {
      errors.push(`${label}: page is missing`);
      continue;
    }
    assertIndexablePage(html, label, path);
    if (!html.includes('href="/categories/"')) errors.push(`${label}: missing categories-index link`);
    if (!html.includes('href="/deals/"')) errors.push(`${label}: missing all-deals link`);
    if (page > 1 && !html.includes(`href="${pagePath(basePath, page - 1)}"`)) errors.push(`${label}: missing previous-page link`);
    if (page < pages.length && !html.includes(`href="${pagePath(basePath, page + 1)}"`)) errors.push(`${label}: missing next-page link`);
    for (const deal of pages[pageIndex]) {
      if (!html.includes(`href="${dealPath(deal)}"`)) errors.push(`${label}: missing deal link ${deal.id}`);
      categoryLinkedIDs.add(deal.id);
    }
  }
}
if (categoryLinkedIDs.size !== deals.length) errors.push(`category hubs: linked ${categoryLinkedIDs.size} of ${deals.length} deals`);
if (Number(indexingReport.categories) !== categories.length) errors.push("data/indexing-report.json: category count mismatch");
if (Number(indexingReport.categoryPages) !== categoryPageCount) errors.push("data/indexing-report.json: category-page count mismatch");

for (let index = 0; index < deals.length; index += 1) {
  const deal = deals[index];
  const path = dealPath(deal);
  const label = `deal:${deal.id}`;
  const category = categoryByDealID.get(deal.id);
  const archivePage = Math.floor(index / archivePageSize) + 1;
  let html = "";
  try {
    html = await readFile(resolve(root, path.replace(/^\//, ""), "index.html"), "utf8");
  } catch {
    errors.push(`${label}: detail page is missing`);
    continue;
  }
  assertIndexablePage(html, label, path);
  if (!html.includes('class="deal-indexing-context"')) errors.push(`${label}: missing visible deal context`);
  if (!html.includes(`href="/category/${category.key}/"`)) errors.push(`${label}: missing category link`);
  if (!html.includes(`href="${pagePath("/deals/", archivePage)}"`)) errors.push(`${label}: missing archive-page link`);
  if (index > 0 && !html.includes(`href="${dealPath(deals[index - 1])}"`)) errors.push(`${label}: missing previous-deal link`);
  if (index < deals.length - 1 && !html.includes(`href="${dealPath(deals[index + 1])}"`)) errors.push(`${label}: missing next-deal link`);
  if (!html.includes('rel="sponsored nofollow noopener"')) errors.push(`${label}: outbound link qualification is missing`);
  if (!html.includes('"@type":"BreadcrumbList"')) errors.push(`${label}: breadcrumb structured data is missing`);
}

const homeHTML = await readFile(resolve(root, "index.html"), "utf8");
assertIndexablePage(homeHTML, "home:/", "/");
if (!homeHTML.includes('id="browse-all-deals"')) errors.push("home: crawlable hub section is missing");
if (!homeHTML.includes('href="/deals/"')) errors.push("home: all-deals link is missing");
if (!homeHTML.includes('href="/categories/"')) errors.push("home: categories link is missing");
for (const deal of deals.slice(0, 12)) {
  if (!homeHTML.includes(`href="${dealPath(deal)}"`)) errors.push(`home: priority deal link missing for ${deal.id}`);
}

const latestHTML = await readFile(resolve(root, "latest-deals", "index.html"), "utf8");
assertIndexablePage(latestHTML, "latest:/latest-deals/", "/latest-deals/");
if (!latestHTML.includes('class="indexing-hubs latest-indexing-hubs"')) errors.push("latest: crawlable archive hub is missing");
if (!latestHTML.includes('href="/deals/"')) errors.push("latest: all-deals link is missing");
if (!latestHTML.includes('href="/deals/page/2/"')) errors.push("latest: second archive-page link is missing");

const robots = await readFile(resolve(root, "robots.txt"), "utf8");
if (!robots.includes(`Sitemap: ${site}/sitemap.xml`)) errors.push("robots.txt: sitemap index declaration is missing");
if (!robots.includes("Disallow: /out/")) errors.push("robots.txt: outbound redirect path should be excluded from crawling");
if (/Disallow:\s*\/(?:deals|category|categories|data)/.test(robots)) errors.push("robots.txt: indexable catalog resources are blocked");

const sitemapIndex = await readFile(resolve(root, "sitemap.xml"), "utf8");
if (!sitemapIndex.includes("<sitemapindex")) errors.push("sitemap.xml: must be a sitemap index");
const sitemapLocs = [...sitemapIndex.matchAll(/<loc>https:\/\/dealdesk\.fyi\/([^<]+)<\/loc>/g)].map((match) => match[1]);
const expectedSitemapFiles = indexingReport.sitemapFiles || [];
for (const filename of expectedSitemapFiles) {
  if (!sitemapLocs.includes(filename)) errors.push(`sitemap.xml: missing child sitemap ${filename}`);
}
if (sitemapLocs.length !== expectedSitemapFiles.length) errors.push("sitemap.xml: child sitemap count does not match report");

const sitemapURLs = new Set();
for (const filename of expectedSitemapFiles) {
  let content = "";
  try {
    content = await readFile(resolve(root, filename), "utf8");
  } catch {
    errors.push(`${filename}: child sitemap is missing`);
    continue;
  }
  if (!content.includes("<urlset")) errors.push(`${filename}: not a URL-set sitemap`);
  for (const match of content.matchAll(/<loc>(https:\/\/dealdesk\.fyi\/[^<]*)<\/loc>/g)) {
    if (sitemapURLs.has(match[1])) errors.push(`${filename}: duplicate sitemap URL ${match[1]}`);
    sitemapURLs.add(match[1]);
  }
}

const expectedPagePaths = new Set([
  "/",
  "/latest-deals/",
  "/categories/",
  "/privacy/",
  "/support/",
  ...archivePages.map((_, index) => pagePath("/deals/", index + 1)),
  ...categories.flatMap((category) => chunk(category.deals, categoryPageSize).map((_, index) => pagePath(`/category/${category.key}/`, index + 1))),
]);
for (const path of expectedPagePaths) {
  if (!sitemapURLs.has(absolute(path))) errors.push(`sitemaps: missing page URL ${path}`);
}
for (const deal of deals) {
  if (!sitemapURLs.has(absolute(dealPath(deal)))) errors.push(`sitemaps: missing deal URL ${deal.id}`);
}
const expectedTotalSitemapURLs = expectedPagePaths.size + deals.length;
if (sitemapURLs.size !== expectedTotalSitemapURLs) {
  errors.push(`sitemaps: expected ${expectedTotalSitemapURLs} unique URLs, found ${sitemapURLs.size}`);
}

const prioritySitemap = await readFile(resolve(root, "sitemap-deals-priority.xml"), "utf8");
for (const deal of deals.slice(0, Math.min(priorityDealCount, deals.length))) {
  if (!prioritySitemap.includes(`<loc>${absolute(dealPath(deal))}</loc>`)) errors.push(`priority sitemap: missing ${deal.id}`);
}

const dealRootEntries = await readdir(resolve(root, "deals"), { withFileTypes: true });
for (const entry of dealRootEntries) {
  if (!entry.isDirectory() || entry.name === "page") continue;
  const page = await readFile(resolve(root, "deals", entry.name, "index.html"), "utf8");
  if (page.includes('content="noindex') || page.includes('http-equiv="refresh"') || page.includes('window.location.replace("/latest-deals/")')) {
    errors.push(`deals/${entry.name}: retired or redirect shell remains in the active deal tree`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Validated crawl architecture: ${deals.length} deal pages, ${archivePages.length} archive pages, ${categoryPageCount} category pages, ${sitemapURLs.size} unique sitemap URLs, and zero orphan deals.`);
