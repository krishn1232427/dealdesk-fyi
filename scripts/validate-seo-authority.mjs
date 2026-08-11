import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const site = "https://dealdesk.fyi";
const buildID = "2026-08-08-authority-v1";
const merchantPageSize = 32;
const errors = [];

const [latestCatalog, searchIndexPayload, report, targetsPayload, categoryGuidePayload, searchCollectionPayload] = await Promise.all([
  readFile(resolve(root, "data/latest-deals.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/search-index.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/seo-authority-report.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/seo-targets.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/seo-category-guides.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data/search-collections.json"), "utf8").then(JSON.parse),
]);
const deals = Array.isArray(latestCatalog.deals) ? latestCatalog.deals : [];
const searchIndexEntries = Array.isArray(searchIndexPayload.deals) ? searchIndexPayload.deals : [];
const searchIndexByID = new Map(searchIndexEntries.map((entry) => [entry.id, entry]));
const targets = Array.isArray(targetsPayload.targets) ? targetsPayload.targets : [];
const targetByID = new Map(targets.map((target) => [target.id, target]));
const isSearchIndexable = (id) => searchIndexByID.get(id)?.indexable === true;

const slugify = (value) => String(value || "other").toLowerCase()
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "") || "other";
const dealPath = (deal) => String(deal.url || `/deals/${slugify(deal.id)}/`);
const absolute = (path) => `${site}${path}`;
const readPage = (path) => readFile(resolve(root, path.replace(/^\//, ""), "index.html"), "utf8");
const decodeEntities = (value) => String(value || "")
  .replaceAll("&amp;", "&")
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">");
const titleFrom = (html) => decodeEntities(html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || "");
const descriptionFrom = (html) => decodeEntities(html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1]?.trim() || "");
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
const countTargetsByPath = (pathsForTarget) => {
  const counts = new Map();
  for (const target of targets) {
    for (const path of pathsForTarget(target)) {
      if (!path) continue;
      const count = counts.get(path) || { total: 0, selected: 0 };
      count.total += 1;
      if (isSearchIndexable(target.id)) count.selected += 1;
      counts.set(path, count);
    }
  }
  return counts;
};
const assertIndexable = (html, label, canonicalPath) => {
  if (!html.includes('content="index,follow')) errors.push(`${label}: missing index,follow`);
  if (html.includes('content="noindex')) errors.push(`${label}: contains noindex`);
  if (!html.includes(`rel="canonical" href="${absolute(canonicalPath)}"`)) errors.push(`${label}: canonical mismatch`);
  if (!html.includes(`/assets/seo-authority.css`)) errors.push(`${label}: authority stylesheet missing`);
  if (!html.includes(`name="dealdesk-seo" content="${buildID}"`)) errors.push(`${label}: authority build marker missing`);
};
const assertBrowseOnly = (html, label, canonicalPath) => {
  if (!html.includes('content="noindex,follow')) errors.push(`${label}: missing noindex,follow`);
  if (html.includes('content="index,follow')) errors.push(`${label}: unexpectedly indexable`);
  if (!html.includes(`rel="canonical" href="${absolute(canonicalPath)}"`)) errors.push(`${label}: canonical mismatch`);
  if (!html.includes(`/assets/seo-authority.css`)) errors.push(`${label}: authority stylesheet missing`);
  if (!html.includes(`name="dealdesk-seo" content="${buildID}"`)) errors.push(`${label}: authority build marker missing`);
};

if (report.build !== buildID) errors.push("data/seo-authority-report.json: build mismatch");
if (targetsPayload.build !== buildID) errors.push("data/seo-targets.json: build mismatch");
if (searchIndexPayload.version !== 2 || searchIndexPayload.policy !== "quality-diversity-v2") errors.push("data/search-index.json: policy mismatch");
if (!deals.length) errors.push("data/latest-deals.json: empty public catalog");
if (report.publicDeals !== deals.length) errors.push("report public-deal count mismatch");
if (report.indexableDeals !== searchIndexEntries.filter((entry) => entry.indexable).length) errors.push("report indexable-deal count mismatch");
if (report.browseOnlyDeals !== searchIndexEntries.filter((entry) => !entry.indexable).length) errors.push("report browse-only-deal count mismatch");
if (report.dealsEnriched !== deals.length) errors.push("report enriched-deal count mismatch");
if (targets.length !== deals.length) errors.push("SEO target count mismatch");
if (searchIndexEntries.length !== deals.length || searchIndexByID.size !== deals.length) errors.push("search-index count mismatch");
for (const deal of deals) {
  const entry = searchIndexByID.get(deal.id);
  if (!entry || entry.url !== deal.url || typeof entry.indexable !== "boolean") errors.push(`search-index:${deal.id}: inconsistent entry`);
}
if (new Set(targets.map((target) => target.id)).size !== targets.length) errors.push("SEO targets contain duplicate deal IDs");
if (new Set(targets.map((target) => target.url)).size !== targets.length) errors.push("SEO targets contain duplicate URLs");
if (new Set(targets.map((target) => target.title)).size !== targets.length) errors.push("SEO targets contain duplicate title tags");

const dealDescriptions = new Set();
for (const deal of deals) {
  const target = targetByID.get(deal.id);
  if (!target) {
    errors.push(`deal:${deal.id}: missing SEO target`);
    continue;
  }
  const path = dealPath(deal);
  let html = "";
  try {
    html = await readPage(path);
  } catch {
    errors.push(`deal:${deal.id}: page missing`);
    continue;
  }
  const shouldIndex = searchIndexByID.get(deal.id)?.indexable === true;
  if (target.indexable !== shouldIndex) errors.push(`deal:${deal.id}: SEO target indexability mismatch`);
  if (shouldIndex) assertIndexable(html, `deal:${deal.id}`, path);
  else assertBrowseOnly(html, `deal:${deal.id}`, path);
  if (!/<title>[^<]*deal(?::|\s)[^<]*\| DealDesk<\/title>/i.test(html)) errors.push(`deal:${deal.id}: query-focused title missing`);
  if (!html.includes('class="deal-seo-authority"')) errors.push(`deal:${deal.id}: authority analysis missing`);
  if (!html.includes('class="deal-question-grid"')) errors.push(`deal:${deal.id}: question-answer block missing`);
  if (!html.includes('data-dealdesk-authority')) errors.push(`deal:${deal.id}: authority WebPage schema missing`);
  if (!html.includes('href="/how-we-rank-deals/"')) errors.push(`deal:${deal.id}: methodology link missing`);
  if (!html.includes(`href="${target.merchantPath}"`)) errors.push(`deal:${deal.id}: merchant hub link missing`);
  if (target.comparisonPath && !html.includes(`href="${target.comparisonPath}"`)) errors.push(`deal:${deal.id}: comparison link missing`);
  for (const collectionPath of target.collectionPaths || []) {
    if (!html.includes(`href="${collectionPath}"`)) errors.push(`deal:${deal.id}: collection link missing ${collectionPath}`);
  }
  if (html.includes('"@type":"AggregateRating"') || html.includes('"@type":"Review"')) errors.push(`deal:${deal.id}: fabricated review markup is prohibited`);
  if (!target.primaryQuery || !Array.isArray(target.secondaryQueries) || target.secondaryQueries.length < 3) errors.push(`deal:${deal.id}: incomplete search target`);
  if (!Number.isFinite(Number(target.score)) || Number(target.score) < 0 || Number(target.score) > 100) errors.push(`deal:${deal.id}: invalid Value Score`);
  if (titleFrom(html).length > 72) errors.push(`deal:${deal.id}: title exceeds 72 characters`);
  const descriptionLength = descriptionFrom(html).length;
  if (descriptionLength < 70 || descriptionLength > 160) errors.push(`deal:${deal.id}: description length ${descriptionLength} is outside 70-160`);
  if (dealDescriptions.has(descriptionFrom(html))) errors.push(`deal:${deal.id}: duplicate meta description`);
  dealDescriptions.add(descriptionFrom(html));
}

const staticPaths = report.staticPaths || [];
for (const path of ["/merchants/", "/comparisons/", "/collections/"]) {
  if (!staticPaths.includes(path)) errors.push(`static paths: missing required directory root ${path}`);
}
for (const path of staticPaths) {
  let html = "";
  try {
    html = await readPage(path);
  } catch {
    errors.push(`static:${path}: page missing`);
    continue;
  }
  assertIndexable(html, `static:${path}`, path);
}

const merchantCounts = countTargetsByPath((target) => /^\/merchant\/[^/]+\/$/.test(target.merchantPath || "") ? [target.merchantPath] : []);
const expectedMerchantBrowsePaths = [...merchantCounts.entries()].flatMap(([path, counts]) =>
  Array.from({ length: Math.ceil(counts.total / merchantPageSize) }, (_, index) => index === 0 ? path : `${path}page/${index + 1}/`)
);
const expectedMerchantPaths = [...merchantCounts.entries()].filter(([, counts]) => counts.selected >= 2).map(([path]) => path);
const comparisonCounts = countTargetsByPath((target) => target.comparisonPath ? [target.comparisonPath] : []);
const expectedComparisonBrowsePaths = [...comparisonCounts.keys()];
const expectedComparisonPaths = [...comparisonCounts.entries()].filter(([, counts]) => counts.selected >= 2).map(([path]) => path);
const collectionCounts = countTargetsByPath((target) => Array.isArray(target.collectionPaths) ? target.collectionPaths : []);
const expectedCollectionBrowsePaths = [...collectionCounts.keys()];
const expectedCollectionPaths = [...collectionCounts.entries()].filter(([, counts]) => counts.selected >= 2).map(([path]) => path);

assertSamePaths(report.merchantBrowsePaths, expectedMerchantBrowsePaths, "merchant browse paths");
assertSamePaths(report.merchantPaths, expectedMerchantPaths, "indexable merchant paths");
assertSamePaths(report.comparisonBrowsePaths, expectedComparisonBrowsePaths, "comparison browse paths");
assertSamePaths(report.comparisonPaths, expectedComparisonPaths, "indexable comparison paths");
assertSamePaths(report.collectionBrowsePaths, expectedCollectionBrowsePaths, "collection browse paths");
assertSamePaths(report.collectionPaths, expectedCollectionPaths, "indexable collection paths");
if (report.merchants !== merchantCounts.size) errors.push("merchant-group count mismatch");
if (report.comparisonGroups !== comparisonCounts.size) errors.push("comparison-group count mismatch");
if (report.collectionGroups !== collectionCounts.size) errors.push("collection-group count mismatch");
if (report.dealsWithComparisonPage !== targets.filter((target) => target.comparisonPath).length) errors.push("comparison-linked deal count mismatch");
if (report.dealsWithCollectionPage !== targets.filter((target) => (target.collectionPaths || []).length).length) errors.push("collection-linked deal count mismatch");

for (const path of report.merchantPaths || []) {
  let html = "";
  try {
    html = await readPage(path);
  } catch {
    errors.push(`merchant:${path}: page missing`);
    continue;
  }
  assertIndexable(html, `merchant:${path}`, path);
  if (!html.includes('class="authority-stat-grid"')) errors.push(`merchant:${path}: statistics missing`);
  if (!/href="\/deals\/[^"]+\/"/.test(html)) errors.push(`merchant:${path}: no crawlable deal links`);
}

const indexableMerchantPaths = new Set(report.merchantPaths || []);
for (const path of report.merchantBrowsePaths || []) {
  if (indexableMerchantPaths.has(path)) continue;
  let html = "";
  try {
    html = await readPage(path);
  } catch {
    errors.push(`merchant-browse:${path}: page missing`);
    continue;
  }
  assertBrowseOnly(html, `merchant-browse:${path}`, path);
  if (!/href="\/deals\/[^"]+\/"/.test(html)) errors.push(`merchant-browse:${path}: no crawlable deal links`);
}

for (const path of report.comparisonPaths || []) {
  let html = "";
  try {
    html = await readPage(path);
  } catch {
    errors.push(`comparison:${path}: page missing`);
    continue;
  }
  assertIndexable(html, `comparison:${path}`, path);
  if (!html.includes('class="authority-table"')) errors.push(`comparison:${path}: comparison table missing`);
  const dealLinks = (html.match(/href="\/deals\/[^"]+\/"/g) || []).length;
  if (dealLinks < 2) errors.push(`comparison:${path}: fewer than two deal links`);
  if (titleFrom(html).length > 70) errors.push(`comparison:${path}: title exceeds 70 characters`);
  const descriptionLength = descriptionFrom(html).length;
  if (descriptionLength < 70 || descriptionLength > 160) errors.push(`comparison:${path}: description length ${descriptionLength} is outside 70-160`);
}

const indexableComparisonPaths = new Set(report.comparisonPaths || []);
for (const path of report.comparisonBrowsePaths || []) {
  if (indexableComparisonPaths.has(path)) continue;
  let html = "";
  try {
    html = await readPage(path);
  } catch {
    errors.push(`comparison-browse:${path}: page missing`);
    continue;
  }
  assertBrowseOnly(html, `comparison-browse:${path}`, path);
  if (!html.includes('class="authority-table"')) errors.push(`comparison-browse:${path}: comparison table missing`);
  const dealLinks = (html.match(/href="\/deals\/[^\"]+\/"/g) || []).length;
  if (dealLinks < 2) errors.push(`comparison-browse:${path}: fewer than two deal links`);
  if (titleFrom(html).length > 70) errors.push(`comparison-browse:${path}: title exceeds 70 characters`);
  const descriptionLength = descriptionFrom(html).length;
  if (descriptionLength < 70 || descriptionLength > 160) errors.push(`comparison-browse:${path}: description length ${descriptionLength} is outside 70-160`);
}

for (const path of report.collectionPaths || []) {
  let html = "";
  try {
    html = await readPage(path);
  } catch {
    errors.push(`collection:${path}: page missing`);
    continue;
  }
  assertIndexable(html, `collection:${path}`, path);
  if (!html.includes('class="collection-considerations"')) errors.push(`collection:${path}: buyer considerations missing`);
  if (!html.includes('class="authority-table"')) errors.push(`collection:${path}: comparison table missing`);
  if (!html.includes('class="collection-related"')) errors.push(`collection:${path}: related-guide links missing`);
  const dealLinks = new Set((html.match(/href="(\/deals\/[^"]+\/)"/g) || []));
  if (dealLinks.size < 3) errors.push(`collection:${path}: fewer than three crawlable deal links`);
  if (path === "/collections/vpn-deals/" && (!html.includes("Recorded billing details") || !html.includes("monthly and upfront price formats"))) {
    errors.push(`collection:${path}: mixed-basis VPN billing comparison is incomplete`);
  }
}

const indexableCollectionPaths = new Set(report.collectionPaths || []);
for (const path of report.collectionBrowsePaths || []) {
  if (indexableCollectionPaths.has(path)) continue;
  let html = "";
  try {
    html = await readPage(path);
  } catch {
    errors.push(`collection-browse:${path}: page missing`);
    continue;
  }
  assertBrowseOnly(html, `collection-browse:${path}`, path);
  if (!html.includes('class="collection-considerations"')) errors.push(`collection-browse:${path}: buyer considerations missing`);
  if (!html.includes('class="authority-table"')) errors.push(`collection-browse:${path}: comparison table missing`);
  if (!html.includes('class="collection-related"')) errors.push(`collection-browse:${path}: related-guide links missing`);
  const dealLinks = new Set((html.match(/href="(\/deals\/[^\"]+\/)"/g) || []));
  if (dealLinks.size < 3) errors.push(`collection-browse:${path}: fewer than three crawlable deal links`);
  if (path === "/collections/vpn-deals/" && (!html.includes("Recorded billing details") || !html.includes("monthly and upfront price formats"))) {
    errors.push(`collection-browse:${path}: mixed-basis VPN billing comparison is incomplete`);
  }
}

for (const [path, marker] of [
  ["/", 'id="seo-authority-hub-title"'],
  ["/latest-deals/", 'id="seo-authority-hub-title"'],
]) {
  let html = "";
  try { html = await readPage(path); } catch { errors.push(`hub:${path}: page missing`); continue; }
  assertIndexable(html, `hub:${path}`, path);
  if (!html.includes(marker)) errors.push(`hub:${path}: authority hub missing`);
  for (const required of ["/collections/", "/deal-index/", "/comparisons/", "/merchants/", "/how-we-rank-deals/"]) {
    if (!html.includes(`href="${required}"`)) errors.push(`hub:${path}: missing ${required} link`);
  }
}

const categoryTitles = new Set();
const categoryDescriptions = new Set();
const publicCategoryLabels = [...new Set(deals.map((deal) => deal.categoryLabel || deal.category || "Other"))];
for (const label of publicCategoryLabels) {
  const profile = categoryGuidePayload.categories?.[label];
  if (!profile) {
    errors.push(`category:${label}: missing category search guide configuration`);
    continue;
  }
  const path = `/category/${slugify(label)}/`;
  let html = "";
  try { html = await readPage(path); } catch { errors.push(`category:${path}: page missing`); continue; }
  const selectedChildCount = deals.filter((deal) => (deal.categoryLabel || deal.category || "Other") === label && isSearchIndexable(deal.id)).length;
  if (selectedChildCount >= 2) assertIndexable(html, `category:${path}`, path);
  else assertBrowseOnly(html, `category:${path}`, path);
  if (!html.includes(`>${profile.heading}</h1>`)) errors.push(`category:${path}: configured search heading missing`);
  if (!html.includes('class="category-search-guide"')) errors.push(`category:${path}: substantive buyer guide missing`);
  if (!html.includes('"@type":"BreadcrumbList"')) errors.push(`category:${path}: breadcrumb structured data missing`);
  const title = titleFrom(html);
  const description = descriptionFrom(html);
  if (categoryTitles.has(title)) errors.push(`category:${path}: duplicate page title`);
  if (categoryDescriptions.has(description)) errors.push(`category:${path}: duplicate meta description`);
  categoryTitles.add(title);
  categoryDescriptions.add(description);
  if (title.length > 72) errors.push(`category:${path}: title exceeds 72 characters`);
  if (description.length < 70 || description.length > 160) errors.push(`category:${path}: description length ${description.length} is outside 70-160`);
}

if ((report.collectionBrowsePaths || []).length !== (searchCollectionPayload.collections || []).length) {
  errors.push("collection report count does not match configured collections that meet their minimum inventory");
}

let methodology = "";
try { methodology = await readPage("/how-we-rank-deals/"); } catch { errors.push("methodology page missing"); }
if (methodology && (!methodology.includes("100-point Value Score") || !methodology.includes("What the score does not mean"))) {
  errors.push("methodology page does not explain scoring limits");
}
let editorial = "";
try { editorial = await readPage("/editorial-policy/"); } catch { errors.push("editorial-policy page missing"); }
if (editorial && (!editorial.includes("No fabricated reviews") || !editorial.includes("Affiliate disclosure"))) {
  errors.push("editorial policy is incomplete");
}
let dealIndex = "";
try { dealIndex = await readPage("/deal-index/"); } catch { errors.push("deal-index page missing"); }
if (dealIndex && (!dealIndex.includes('"@type":"Dataset"') || !dealIndex.includes("dealdesk-deal-index.csv"))) {
  errors.push("deal-index page is missing Dataset markup or data download");
}

const indexJSON = JSON.parse(await readFile(resolve(root, "data/dealdesk-deal-index.json"), "utf8"));
if (indexJSON.publicDeals !== deals.length) errors.push("deal index JSON count mismatch");
const indexCSV = await readFile(resolve(root, "data/dealdesk-deal-index.csv"), "utf8");
if (indexCSV.trim().split(/\r?\n/).length !== deals.length + 1) errors.push("deal index CSV row count mismatch");
const targetsCSV = await readFile(resolve(root, "data/seo-targets.csv"), "utf8");
if (targetsCSV.trim().split(/\r?\n/).length !== deals.length + 1) errors.push("SEO targets CSV row count mismatch");

const authoritySitemap = await readFile(resolve(root, "sitemap-authority.xml"), "utf8");
const rootSitemap = await readFile(resolve(root, "sitemap.xml"), "utf8");
if (!rootSitemap.includes(`${site}/sitemap-authority.xml`)) errors.push("root sitemap does not reference authority sitemap");
for (const path of [...staticPaths, ...(report.merchantPaths || []), ...(report.comparisonPaths || []), ...(report.collectionPaths || [])]) {
  if (!authoritySitemap.includes(`<loc>${absolute(path)}</loc>`)) errors.push(`authority sitemap missing ${path}`);
}
for (const path of report.merchantBrowsePaths || []) {
  if (!indexableMerchantPaths.has(path) && authoritySitemap.includes(`<loc>${absolute(path)}</loc>`)) {
    errors.push(`authority sitemap contains noindex merchant pagination ${path}`);
  }
}
for (const path of report.comparisonBrowsePaths || []) {
  if (!indexableComparisonPaths.has(path) && authoritySitemap.includes(`<loc>${absolute(path)}</loc>`)) {
    errors.push(`authority sitemap contains noindex comparison page ${path}`);
  }
}
for (const path of report.collectionBrowsePaths || []) {
  if (!indexableCollectionPaths.has(path) && authoritySitemap.includes(`<loc>${absolute(path)}</loc>`)) {
    errors.push(`authority sitemap contains noindex collection page ${path}`);
  }
}
if (report.authorityPages !== [...staticPaths, ...(report.merchantPaths || []), ...(report.comparisonPaths || []), ...(report.collectionPaths || [])].length) {
  errors.push("authority-page count does not match paths");
}
if (report.merchantPages !== (report.merchantBrowsePaths || []).length) errors.push("merchant browse-page count mismatch");
if (report.indexableMerchantPages !== (report.merchantPaths || []).length) errors.push("indexable merchant-page count mismatch");
if (report.comparisonPages !== (report.comparisonBrowsePaths || []).length) errors.push("comparison browse-page count mismatch");
if (report.indexableComparisonPages !== (report.comparisonPaths || []).length) errors.push("indexable comparison-page count mismatch");
if (report.collectionPages !== (report.collectionBrowsePaths || []).length) errors.push("collection browse-page count mismatch");
if (report.indexableCollectionPages !== (report.collectionPaths || []).length) errors.push("indexable collection-page count mismatch");
if (report.targetQueries !== deals.length) errors.push("target-query count mismatch");
if (!Number.isFinite(Number(report.scores?.minimum)) || !Number.isFinite(Number(report.scores?.median)) || !Number.isFinite(Number(report.scores?.maximum))) {
  errors.push("score distribution is incomplete");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Validated DealDesk SEO authority engine: ${deals.length} deal pages, ${report.merchantPages} merchant pages, ${report.comparisonPages} comparison pages, and ${report.authorityPages} authority URLs.`);
