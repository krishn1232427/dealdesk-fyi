#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_ID = "2026-08-08-indexing-v1";

const paths = {
  homepage: resolve(root, "index.html"),
  build: resolve(root, "scripts/build-seo.mjs"),
  validate: resolve(root, "scripts/validate-deals.mjs"),
};

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing expected block: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Expected one block but found multiple: ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

async function update(path, transform) {
  const current = await readFile(path, "utf8");
  const next = transform(current);
  if (next === current) {
    console.log(`No change needed: ${path}`);
    return;
  }
  await writeFile(path, next, "utf8");
  console.log(`Updated: ${path}`);
}

await update(paths.homepage, (source) => {
  source = replaceOnce(
    source,
    '    <meta name="theme-color" content="#ff5a1f" />',
    `    <meta name="theme-color" content="#ff5a1f" />\n    <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />\n    <meta name="dealdesk-build" content="${BUILD_ID}" />\n    <link rel="sitemap" type="application/xml" href="/sitemap.xml" />`,
    "homepage indexing metadata"
  );
  source = source
    .replace('/styles.css?v=20260802-genuine-stream-images', `/styles.css?v=${BUILD_ID}`)
    .replace('/assets/site-shell.js?v=20260802-latest-mobile-parity', `/assets/site-shell.js?v=${BUILD_ID}`);
  source = replaceOnce(
    source,
    `    <script src="/assets/site-shell.js?v=${BUILD_ID}" defer></script>`,
    `    <script src="/assets/site-shell.js?v=${BUILD_ID}" defer></script>\n    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"https://dealdesk.fyi/#organization","name":"DealDesk","url":"https://dealdesk.fyi/","logo":{"@type":"ImageObject","url":"https://dealdesk.fyi/assets/dealdesk-publisher-logo.png"}},{"@type":"WebSite","@id":"https://dealdesk.fyi/#website","name":"DealDesk","url":"https://dealdesk.fyi/","publisher":{"@id":"https://dealdesk.fyi/#organization"}}]}</script>`,
    "homepage organization schema"
  );
  source = replaceOnce(
    source,
    "            <p>Every offer here uses an approved, payable DealDesk link.</p>",
    "            <p>Every live offer here uses an approved, payable DealDesk link. Newly approved programs such as Malwarebytes and TicketNetwork appear only after their exact tracking links and current customer terms pass verification.</p>",
    "partner verification disclosure"
  );
  return source;
});

await update(paths.build, (source) => {
  source = replaceOnce(
    source,
    "    mainEntityOfPage: canonical,",
    "    mainEntityOfPage: canonical,\n    dateModified: isoDate(updated),",
    "product dateModified"
  );
  source = replaceOnce(
    source,
    "      price: numberFromPrice(prices.current).toFixed(2),",
    "      price: numberFromPrice(prices.current).toFixed(2),\n      ...(deal.expiresAt ? { priceValidUntil: isoDate(deal.expiresAt) } : {}),",
    "offer priceValidUntil"
  );
  source = replaceOnce(
    source,
    "    name: `${title} offer`,\n    description,\n    url: canonical,",
    "    name: `${title} offer`,\n    description,\n    url: canonical,\n    dateModified: isoDate(updated),",
    "webpage dateModified"
  );
  source = replaceOnce(
    source,
    "  };\n  const html = `<!doctype html>",
    `  };\n  const breadcrumbSchema = {\n    "@context": "https://schema.org",\n    "@type": "BreadcrumbList",\n    itemListElement: [\n      { "@type": "ListItem", position: 1, name: "DealDesk", item: \`${'${site}'}/\` },\n      { "@type": "ListItem", position: 2, name: "Latest deals", item: \`${'${site}'}/latest-deals/\` },\n      { "@type": "ListItem", position: 3, name: title, item: canonical }\n    ]\n  };\n  const html = \`<!doctype html>`,
    "breadcrumb schema definition"
  );
  source = replaceOnce(
    source,
    '  <script type="application/ld+json">${JSON.stringify(schema).replaceAll("<", "\\\\u003c")}</script>',
    '  <script type="application/ld+json">${JSON.stringify(schema).replaceAll("<", "\\\\u003c")}</script>\n  <script type="application/ld+json">${JSON.stringify(breadcrumbSchema).replaceAll("<", "\\\\u003c")}</script>',
    "breadcrumb schema output"
  );

  const retiredStart = source.indexOf("const retiredDealHTML =");
  const latestStart = source.indexOf("const latestFeedTime =", retiredStart);
  if (retiredStart < 0 || latestStart < 0) {
    throw new Error("Could not locate retired-deal generation block");
  }
  const replacement = `const generatedDealSlugs = new Set(deals.map(slugFor));\nconst knownDealSlugs = [...generatedDealSlugs].sort();\nawait writeFile(dealSlugManifestPath, \`${'${JSON.stringify({'}\n  updatedAt: new Date(Math.max(...feeds.map((feed) => new Date(feed.updatedAt || 0).getTime()), new Date(affiliateRegistry.updatedAt || 0).getTime())).toISOString(),\n  slugs: knownDealSlugs\n}, null, 2)}\\n\`);\n\n`;
  source = source.slice(0, retiredStart) + replacement + source.slice(latestStart);

  source = replaceOnce(
    source,
    "const latestFeedTime = Math.max(...feeds.map((feed) => new Date(feed.updatedAt || 0).getTime()));",
    "const latestFeedTime = Math.max(...feeds.map((feed) => new Date(feed.updatedAt || 0).getTime()), new Date(affiliateRegistry.updatedAt || 0).getTime());",
    "latest content timestamp"
  );
  source = replaceOnce(
    source,
    "  url: `${site}/latest-deals/`,\n  mainEntity:",
    "  url: `${site}/latest-deals/`,\n  dateModified: lastmod,\n  mainEntity:",
    "latest collection dateModified"
  );
  source = replaceOnce(
    source,
    "    itemListElement: pricedDeals.map((deal, index) => ({",
    "    itemListElement: pricedDeals.slice(0, 18).map((deal, index) => ({",
    "visible ItemList scope"
  );
  source = replaceOnce(
    source,
    '  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1" />',
    `  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />\n  <meta name="dealdesk-build" content="${BUILD_ID}" />\n  <link rel="sitemap" type="application/xml" href="/sitemap.xml" />`,
    "latest page indexing metadata"
  );
  source = source
    .replace('/styles.css?v=20260802-genuine-stream-images', `/styles.css?v=${BUILD_ID}`)
    .replace('/assets/site-shell.js?v=20260802-latest-mobile-parity', `/assets/site-shell.js?v=${BUILD_ID}`);
  return source;
});

await update(paths.validate, (source) => {
  source = replaceOnce(
    source,
    'import { readFile } from "node:fs/promises";',
    'import { readFile, readdir } from "node:fs/promises";',
    "validator directory import"
  );
  source = replaceOnce(
    source,
    "  if (!detailPage.includes(`Date.parse(${JSON.stringify(validUntilFor(deal))})`)) {",
    `  if (detailPage.includes('content="noindex')) {\n    errors.push(\`deals/\${slugFor(deal)}: public deal page must be indexable\`);\n  }\n  if (!detailPage.includes('"@type":"BreadcrumbList"')) {\n    errors.push(\`deals/\${slugFor(deal)}: public deal page is missing breadcrumb structured data\`);\n  }\n  if (deal.expiresAt) {\n    const expectedPriceValidUntil = new Date(deal.expiresAt).toISOString().slice(0, 10);\n    if (!detailPage.includes(\`"priceValidUntil":"\${expectedPriceValidUntil}"\`)) {\n      errors.push(\`deals/\${slugFor(deal)}: expiring offer is missing priceValidUntil\`);\n    }\n  }\n  if (!detailPage.includes(\`Date.parse(\${JSON.stringify(validUntilFor(deal))})\`)) {`,
    "public detail SEO checks"
  );
  source = replaceOnce(
    source,
    "if (!homepageSource.includes('/data/affiliate-programs.json') ||",
    `if (!homepageSource.includes('name="dealdesk-build" content="${BUILD_ID}"')) {\n  errors.push("index.html: deployment build marker is missing");\n}\nif (!homepageSource.includes('/data/affiliate-programs.json') ||`,
    "homepage build marker check"
  );

  const staleStart = source.lastIndexOf("if (staleDeals.length) {");
  const errorsStart = source.indexOf("if (errors.length) {", staleStart);
  if (staleStart < 0 || errorsStart < 0) {
    throw new Error("Could not locate stale-deal validation block");
  }
  const staleReplacement = `if (staleDeals.length) {\n  const latestDeals = JSON.parse(await readFile(new URL("../data/latest-deals.json", import.meta.url), "utf8"));\n  const latestDealIDs = new Set((latestDeals.deals || []).map((deal) => deal.id));\n  const sitemap = await readFile(new URL("../sitemap.xml", import.meta.url), "utf8");\n\n  for (const { deal, label } of staleDeals) {\n    const slug = slugFor(deal);\n    try {\n      await readFile(new URL(\`../deals/\${slug}/index.html\`, import.meta.url), "utf8");\n      errors.push(\`\${label}: expired or nonpublic detail page must be removed so the host returns a real 404\`);\n    } catch {}\n    if (latestDealIDs.has(deal.id)) {\n      errors.push(\`\${label}: stale deal must not appear in latest-deals.json\`);\n    }\n    if (sitemap.includes(\`/deals/\${slug}/\`)) {\n      errors.push(\`\${label}: stale deal must not appear in sitemap.xml\`);\n    }\n  }\n}\n\nconst generatedDealDirectories = await readdir(new URL("../deals/", import.meta.url), { withFileTypes: true });\nfor (const entry of generatedDealDirectories) {\n  if (!entry.isDirectory()) continue;\n  const detailPage = await readFile(new URL(\`../deals/\${entry.name}/index.html\`, import.meta.url), "utf8");\n  if (detailPage.includes('content="noindex') || detailPage.includes('http-equiv="refresh"')) {\n    errors.push(\`deals/\${entry.name}: generated deal directories must not contain retired noindex or redirect shells\`);\n  }\n}\n\nconst latestPageSource = await readFile(new URL("../latest-deals/index.html", import.meta.url), "utf8");\nconst latestSchemaListItemCount = (latestPageSource.match(/"@type":"ListItem"/g) || []).length;\nif (latestSchemaListItemCount > 18) {\n  errors.push("latest-deals/index.html: ItemList structured data must describe only the initially visible cards");\n}\n\n`;
  source = source.slice(0, staleStart) + staleReplacement + source.slice(errorsStart);
  return source;
});

console.log(`Applied DealDesk deployment and indexing fixes for ${BUILD_ID}.`);
