import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateSearchIndexPolicy,
  SEARCH_INDEX_POLICY_NAME,
  SEARCH_INDEX_POLICY_VERSION
} from "./lib/search-index-policy.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const site = "https://dealdesk.fyi";
const buildID = "2026-08-08-crawl-v3";
const archivePageSize = 32;
const categoryPageSize = 32;
const priorityDealCount = 100;
const errors = [];

const latestCatalog = JSON.parse(await readFile(resolve(root, "data/latest-deals.json"), "utf8"));
const searchIndexPayload = JSON.parse(await readFile(resolve(root, "data/search-index.json"), "utf8"));
const indexingReport = JSON.parse(await readFile(resolve(root, "data/indexing-report.json"), "utf8"));
const [bestFeed, streamingFeed] = await Promise.all([
  readFile(resolve(root, "data/best-deals.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/streaming-deals.json"), "utf8").then(JSON.parse)
]);
const deals = Array.isArray(latestCatalog.deals) ? latestCatalog.deals : [];
const sourceByID = new Map([...bestFeed.deals, ...streamingFeed.deals].map((deal) => [deal.id, deal]));
const policyDeals = deals.map((deal) => sourceByID.get(deal.id)).filter(Boolean);
const searchIndexEntries = Array.isArray(searchIndexPayload.deals) ? searchIndexPayload.deals : [];
const searchIndexByID = new Map(searchIndexEntries.map((entry) => [entry.id, entry]));
const searchIndexEvaluatedAt = new Date(searchIndexPayload.evaluatedAt || "").getTime();

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
const assertSamePaths = (actualValue, expectedValue, label) => {
  const actual = Array.isArray(actualValue) ? actualValue : [];
  const expected = [...expectedValue];
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (!Array.isArray(actualValue)) errors.push(`${label}: path list is missing`);
  if (actualSet.size !== actual.length) errors.push(`${label}: path list contains duplicates`);
  const missing = expected.filter((path) => !actualSet.has(path));
  const unexpected = actual.filter((path) => !expectedSet.has(path));
  if (missing.length || unexpected.length) {
    errors.push(`${label}: path list mismatch${missing.length ? `; missing ${missing.join(", ")}` : ""}${unexpected.length ? `; unexpected ${unexpected.join(", ")}` : ""}`);
  }
};
const hasUnqualifiedClientRedirect = (html) =>
  html.includes('window.location.replace("/latest-deals/")') && !html.includes("Date.parse(");

if (!deals.length) errors.push("data/latest-deals.json: public catalog is empty");
if (Number(latestCatalog.total) !== deals.length) errors.push("data/latest-deals.json: total does not match deals length");
if (searchIndexPayload.version !== SEARCH_INDEX_POLICY_VERSION || searchIndexPayload.policy !== SEARCH_INDEX_POLICY_NAME ||
    !Number.isFinite(searchIndexEvaluatedAt)) {
  errors.push("data/search-index.json: unexpected policy version");
}
if (policyDeals.length !== deals.length) errors.push("Source feeds are missing public deals required by the search-index policy");
if (searchIndexEntries.length !== deals.length || searchIndexByID.size !== deals.length) {
  errors.push("data/search-index.json: must contain exactly one record for every public deal");
}
const expectedSearchIndexStates = Number.isFinite(searchIndexEvaluatedAt)
  ? await evaluateSearchIndexPolicy(policyDeals, searchIndexEvaluatedAt)
  : new Map();
for (const deal of deals) {
  const entry = searchIndexByID.get(deal.id);
  const expected = expectedSearchIndexStates.get(deal.id);
  if (!entry || !expected || entry.url !== dealPath(deal) || entry.indexable !== expected.indexable ||
      entry.reason !== expected.reason || entry.recheckAfter !== (deal.recheckAfter || null)) {
    errors.push(`data/search-index.json:${deal.id}: missing or inconsistent search-index state`);
  }
}
const indexableDeals = deals.filter((deal) => searchIndexByID.get(deal.id)?.indexable === true);
const browseOnlyDeals = deals.filter((deal) => searchIndexByID.get(deal.id)?.indexable === false);
if (Number(searchIndexPayload.publicDeals) !== deals.length ||
    Number(searchIndexPayload.indexableDeals) !== indexableDeals.length ||
    Number(searchIndexPayload.browseOnlyDeals) !== browseOnlyDeals.length) {
  errors.push("data/search-index.json: summary counts do not match the catalog");
}
if (indexingReport.build !== buildID) errors.push("data/indexing-report.json: unexpected build identifier");
if (Number(indexingReport.publicDeals) !== deals.length) errors.push("data/indexing-report.json: public deal count mismatch");
if (Number(indexingReport.indexableDeals) !== indexableDeals.length ||
    Number(indexingReport.browseOnlyDeals) !== browseOnlyDeals.length) {
  errors.push("data/indexing-report.json: search-index split mismatch");
}
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

const assertPage = (html, label, canonicalPath, { indexable = true } = {}) => {
  const expectedRobots = indexable ? 'content="index,follow' : 'content="noindex,follow';
  const forbiddenRobots = indexable ? 'content="noindex' : 'content="index,follow';
  if (!html.includes(expectedRobots)) errors.push(`${label}: missing ${indexable ? "index,follow" : "noindex,follow"} robots directive`);
  if (html.includes(forbiddenRobots)) errors.push(`${label}: contains contradictory robots directive`);
  if (html.includes('http-equiv="refresh"')) errors.push(`${label}: contains meta refresh`);
  if (hasUnqualifiedClientRedirect(html)) errors.push(`${label}: contains an unqualified client-side redirect`);
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
  assertPage(html, label, path, { indexable: page === 1 });
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
if (Number(indexingReport.indexableArchivePages) !== Math.min(1, archivePages.length)) {
  errors.push("data/indexing-report.json: indexable archive-page count mismatch");
}
const expectedArchivePageNumbers = Array.from({ length: Math.max(0, archivePages.length - 1) }, (_, index) => String(index + 2));
let actualArchivePageNumbers = [];
try {
  actualArchivePageNumbers = (await readdir(resolve(root, "deals", "page"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a) - Number(b));
} catch {}
if (JSON.stringify(actualArchivePageNumbers) !== JSON.stringify(expectedArchivePageNumbers)) {
  errors.push(`archive: generated page directories ${actualArchivePageNumbers.join(",")} do not match expected ${expectedArchivePageNumbers.join(",")}`);
}


let categoriesIndex = "";
try {
  categoriesIndex = await readFile(resolve(root, "categories", "index.html"), "utf8");
  assertPage(categoriesIndex, "categories:/categories/", "/categories/");
} catch {
  errors.push("categories:/categories/: page is missing");
}
const categoryLinkedIDs = new Set();
let categoryPageCount = 0;
const expectedCategoryPaths = [];
const expectedCategoryBrowsePaths = [];
for (const category of categories) {
  if (categoriesIndex && !categoriesIndex.includes(`href="/category/${category.key}/"`)) {
    errors.push(`categories:/categories/: missing ${category.label} link`);
  }
  const pages = chunk(category.deals, categoryPageSize);
  const selectedChildCount = category.deals.filter((deal) => searchIndexByID.get(deal.id)?.indexable === true).length;
  const basePath = `/category/${category.key}/`;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    categoryPageCount += 1;
    const page = pageIndex + 1;
    const path = pagePath(basePath, page);
    const pageIndexable = page === 1 && selectedChildCount >= 2;
    expectedCategoryBrowsePaths.push(path);
    if (pageIndexable) expectedCategoryPaths.push(path);
    const label = `category:${path}`;
    let html = "";
    try {
      html = await readFile(pageFile(resolve(root, "category", category.key), page), "utf8");
    } catch {
      errors.push(`${label}: page is missing`);
      continue;
    }
    assertPage(html, label, path, { indexable: pageIndexable });
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
if (Number(indexingReport.indexableCategoryPages) !== expectedCategoryPaths.length) {
  errors.push("data/indexing-report.json: indexable category-page count mismatch");
}
assertSamePaths(indexingReport.categoryBrowsePaths, expectedCategoryBrowsePaths, "data/indexing-report.json: category browse paths");
assertSamePaths(indexingReport.categoryPaths, expectedCategoryPaths, "data/indexing-report.json: indexable category paths");

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
  const searchIndexEntry = searchIndexByID.get(deal.id);
  assertPage(html, label, path, { indexable: searchIndexEntry?.indexable === true });
  if (searchIndexEntry?.reason && !html.includes(`name="dealdesk-index-status" content="${searchIndexEntry.reason}"`)) {
    errors.push(`${label}: search-index status marker does not match the manifest`);
  }
  if (!html.includes('class="deal-indexing-context"')) errors.push(`${label}: missing visible deal context`);
  if (!html.includes(`href="/category/${category.key}/"`)) errors.push(`${label}: missing category link`);
  if (!html.includes(`href="${pagePath("/deals/", archivePage)}"`)) errors.push(`${label}: missing archive-page link`);
  if (index > 0 && !html.includes(`href="${dealPath(deals[index - 1])}"`)) errors.push(`${label}: missing previous-deal link`);
  if (index < deals.length - 1 && !html.includes(`href="${dealPath(deals[index + 1])}"`)) errors.push(`${label}: missing next-deal link`);
  if (!html.includes('rel="sponsored nofollow noopener"')) errors.push(`${label}: outbound link qualification is missing`);
  if (!html.includes('"@type":"BreadcrumbList"')) errors.push(`${label}: breadcrumb structured data is missing`);
  if (!html.includes(`"item":"${site}/deals/"`) || !html.includes(`"item":"${site}/category/${category.key}/"`)) {
    errors.push(`${label}: breadcrumb structured data must include the static archive and category hub`);
  }
}

const homeHTML = await readFile(resolve(root, "index.html"), "utf8");
assertPage(homeHTML, "home:/", "/");
if (!homeHTML.includes('id="browse-all-deals"')) errors.push("home: crawlable hub section is missing");
if (!homeHTML.includes('href="/deals/"')) errors.push("home: all-deals link is missing");
if (!homeHTML.includes('href="/categories/"')) errors.push("home: categories link is missing");
for (const deal of indexableDeals.slice(0, 12)) {
  if (!homeHTML.includes(`href="${dealPath(deal)}"`)) errors.push(`home: priority deal link missing for ${deal.id}`);
}

const latestHTML = await readFile(resolve(root, "latest-deals", "index.html"), "utf8");
assertPage(latestHTML, "latest:/latest-deals/", "/latest-deals/");
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
const allowedDownstreamSitemaps = new Set(["sitemap-authority.xml", "sitemap-images.xml"]);
for (const filename of sitemapLocs) {
  if (!expectedSitemapFiles.includes(filename) && !allowedDownstreamSitemaps.has(filename)) {
    errors.push(`sitemap.xml: unexpected child sitemap ${filename}`);
  }
}

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
  ...(archivePages.length ? ["/deals/"] : []),
  ...expectedCategoryPaths,
]);
for (const path of expectedPagePaths) {
  if (!sitemapURLs.has(absolute(path))) errors.push(`sitemaps: missing page URL ${path}`);
}
for (const deal of indexableDeals) {
  if (!sitemapURLs.has(absolute(dealPath(deal)))) errors.push(`sitemaps: missing deal URL ${deal.id}`);
}
for (const deal of browseOnlyDeals) {
  if (sitemapURLs.has(absolute(dealPath(deal)))) errors.push(`sitemaps: browse-only deal must be excluded ${deal.id}`);
}
for (let page = 2; page <= archivePages.length; page += 1) {
  if (sitemapURLs.has(absolute(pagePath("/deals/", page)))) errors.push(`sitemaps: noindex archive page must be excluded ${page}`);
}
const indexableCategoryPaths = new Set(expectedCategoryPaths);
for (const path of expectedCategoryBrowsePaths) {
  if (!indexableCategoryPaths.has(path) && sitemapURLs.has(absolute(path))) {
    errors.push(`sitemaps: noindex category page must be excluded ${path}`);
  }
}
const expectedTotalSitemapURLs = expectedPagePaths.size + indexableDeals.length;
if (sitemapURLs.size !== expectedTotalSitemapURLs) {
  errors.push(`sitemaps: expected ${expectedTotalSitemapURLs} unique URLs, found ${sitemapURLs.size}`);
}

const prioritySitemap = await readFile(resolve(root, "sitemap-deals-priority.xml"), "utf8");
for (const deal of indexableDeals.slice(0, Math.min(priorityDealCount, indexableDeals.length))) {
  if (!prioritySitemap.includes(`<loc>${absolute(dealPath(deal))}</loc>`)) errors.push(`priority sitemap: missing ${deal.id}`);
}

const dealRootEntries = await readdir(resolve(root, "deals"), { withFileTypes: true });
for (const entry of dealRootEntries) {
  if (!entry.isDirectory() || entry.name === "page") continue;
  const page = await readFile(resolve(root, "deals", entry.name, "index.html"), "utf8");
  if (page.includes('http-equiv="refresh"') || hasUnqualifiedClientRedirect(page)) {
    errors.push(`deals/${entry.name}: redirect shell remains in the active deal tree`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Validated crawl architecture: ${deals.length} browseable deal pages (${indexableDeals.length} indexable, ${browseOnlyDeals.length} browse-only), ${archivePages.length} archive pages, ${categoryPageCount} category pages, ${sitemapURLs.size} unique sitemap URLs, and zero orphan deals.`);
