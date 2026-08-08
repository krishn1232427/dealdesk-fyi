import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const patcherPath = fileURLToPath(import.meta.url);
const buildPath = new URL("./build-indexing-hubs.mjs", import.meta.url);
const validatePath = new URL("./validate-indexing.mjs", import.meta.url);

const replaceOnce = (source, before, after, label) => {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Could not find ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Found ${label} more than once`);
  return source.slice(0, first) + after + source.slice(first + before.length);
};

let build = await readFile(buildPath, "utf8");
build = replaceOnce(
  build,
  'const buildID = "2026-08-08-crawl-v2";',
  'const buildID = "2026-08-08-crawl-v3";',
  "build identifier"
);
build = replaceOnce(
  build,
  '  const discount = original > current && current >= 0 ? Math.round((1 - current / original) * 100) : 0;\n',
  '  const badgeDiscount = String(deal.badgeText || "").match(/(\\d+)%\\s*off/i);\n  const discount = badgeDiscount ? Number(badgeDiscount[1]) : original > current && current >= 0 ? Math.round((1 - current / original) * 100) : 0;\n',
  "displayed discount calculation"
);
build = replaceOnce(
  build,
  'const archivePages = chunk(deals, archivePageSize);\nconst archiveDirectory = resolve(root, "deals");\n',
  'const archivePages = chunk(deals, archivePageSize);\nconst archiveDirectory = resolve(root, "deals");\nawait rm(resolve(archiveDirectory, "page"), { recursive: true, force: true });\nawait rm(resolve(archiveDirectory, "index.html"), { force: true });\n',
  "archive reset"
);
build = replaceOnce(
  build,
  '  const breadcrumb = `<nav class="deal-breadcrumb" aria-label="Breadcrumb"><a href="/">DealDesk</a><span aria-hidden="true">›</span><a href="/deals/">All deals</a><span aria-hidden="true">›</span><a href="/category/${category.key}/">${esc(category.label)}</a><span aria-hidden="true">›</span><span>${esc(deal.title)}</span></nav>`;\n  html = html.replace(/<nav class="deal-breadcrumb"[^>]*>.*?<\\/nav>/s, breadcrumb);\n',
  '  const breadcrumb = `<nav class="deal-breadcrumb" aria-label="Breadcrumb"><a href="/">DealDesk</a><span aria-hidden="true">›</span><a href="/deals/">All deals</a><span aria-hidden="true">›</span><a href="/category/${category.key}/">${esc(category.label)}</a><span aria-hidden="true">›</span><span>${esc(deal.title)}</span></nav>`;\n  html = html.replace(/<nav class="deal-breadcrumb"[^>]*>.*?<\\/nav>/s, breadcrumb);\n  const breadcrumbSchema = {\n    "@context": "https://schema.org",\n    "@type": "BreadcrumbList",\n    itemListElement: [\n      { "@type": "ListItem", position: 1, name: "DealDesk", item: `${site}/` },\n      { "@type": "ListItem", position: 2, name: "All deals", item: `${site}/deals/` },\n      { "@type": "ListItem", position: 3, name: category.label, item: `${site}/category/${category.key}/` },\n      { "@type": "ListItem", position: 4, name: deal.title, item: absolute(dealPath(deal)) },\n    ],\n  };\n  const breadcrumbScript = `  <script type="application/ld+json">${JSON.stringify(breadcrumbSchema).replaceAll("<", "\\\\u003c")}</script>`;\n  html = html.replace(/\\s*<script type="application\\/ld\\+json">\\{"@context":"https:\\/\\/schema\\.org","@type":"BreadcrumbList"[\\s\\S]*?<\\/script>/, `\\n${breadcrumbScript}`);\n',
  "deal breadcrumb enrichment"
);
await writeFile(buildPath, build);

let validate = await readFile(validatePath, "utf8");
validate = replaceOnce(
  validate,
  'const buildID = "2026-08-08-crawl-v2";',
  'const buildID = "2026-08-08-crawl-v3";',
  "validator build identifier"
);
validate = replaceOnce(
  validate,
  '  if (!html.includes(\'"@type":"BreadcrumbList"\')) errors.push(`${label}: breadcrumb structured data is missing`);\n',
  '  if (!html.includes(\'"@type":"BreadcrumbList"\')) errors.push(`${label}: breadcrumb structured data is missing`);\n  if (!html.includes(`"item":"${site}/deals/"`) || !html.includes(`"item":"${site}/category/${category.key}/"`)) {\n    errors.push(`${label}: breadcrumb structured data must include the static archive and category hub`);\n  }\n',
  "breadcrumb validation"
);
validate = replaceOnce(
  validate,
  'if (archiveLinkedIDs.size !== deals.length) errors.push(`archive: linked ${archiveLinkedIDs.size} of ${deals.length} deals`);\nif (Number(indexingReport.archivePages) !== archivePages.length) errors.push("data/indexing-report.json: archive-page count mismatch");\n\n',
  'if (archiveLinkedIDs.size !== deals.length) errors.push(`archive: linked ${archiveLinkedIDs.size} of ${deals.length} deals`);\nif (Number(indexingReport.archivePages) !== archivePages.length) errors.push("data/indexing-report.json: archive-page count mismatch");\nconst expectedArchivePageNumbers = Array.from({ length: Math.max(0, archivePages.length - 1) }, (_, index) => String(index + 2));\nlet actualArchivePageNumbers = [];\ntry {\n  actualArchivePageNumbers = (await readdir(resolve(root, "deals", "page"), { withFileTypes: true }))\n    .filter((entry) => entry.isDirectory() && /^\\d+$/.test(entry.name))\n    .map((entry) => entry.name)\n    .sort((a, b) => Number(a) - Number(b));\n} catch {}\nif (JSON.stringify(actualArchivePageNumbers) !== JSON.stringify(expectedArchivePageNumbers)) {\n  errors.push(`archive: generated page directories ${actualArchivePageNumbers.join(",")} do not match expected ${expectedArchivePageNumbers.join(",")}`);\n}\n\n',
  "archive directory validation"
);
await writeFile(validatePath, validate);
await rm(patcherPath);
console.log("Upgraded DealDesk crawl architecture to v3.");
