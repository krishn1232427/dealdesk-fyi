import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = "https://dealdesk.fyi";
const fail = (message) => { throw new Error(message); };
const escapeXML = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");
const occurrences = (text, needle) => text.split(needle).length - 1;

const [catalog, searchIndexPayload, sitemap, sitemapIndex] = await Promise.all([
  readFile(resolve(root, "data", "latest-deals.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "data", "search-index.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "sitemap-images.xml"), "utf8"),
  readFile(resolve(root, "sitemap.xml"), "utf8"),
]);
const deals = Array.isArray(catalog.deals) ? catalog.deals : [];
const searchIndexEntries = Array.isArray(searchIndexPayload.deals) ? searchIndexPayload.deals : [];
const searchIndexByID = new Map(searchIndexEntries.map((entry) => [entry.id, entry]));
if (searchIndexPayload.version !== 2 || searchIndexPayload.policy !== "quality-diversity-v2" ||
    searchIndexEntries.length !== deals.length || searchIndexByID.size !== deals.length) {
  fail("Search-index manifest must contain exactly one quality-diversity-v2 record for every public deal");
}
for (const deal of deals) {
  const entry = searchIndexByID.get(deal.id);
  if (!entry || entry.url !== deal.url || typeof entry.indexable !== "boolean") {
    fail(`Search-index manifest is inconsistent for ${deal.id}`);
  }
}
const browseOnlyDeals = deals.filter((deal) => searchIndexByID.get(deal.id)?.indexable === false);
const eligible = deals.filter((deal) => searchIndexByID.get(deal.id)?.indexable === true &&
  String(deal.url || "").startsWith("/") && /^https?:\/\//i.test(String(deal.imageURL || "").trim()));
const uniquePages = new Map(eligible.map((deal) => [`${site}${deal.url}`, deal]));

if (!sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) fail("Image sitemap XML declaration is missing");
if (!sitemap.includes('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"')) fail("Image sitemap namespace is missing");
if (occurrences(sitemap, "<url>") !== uniquePages.size) fail(`Image sitemap has ${occurrences(sitemap, "<url>")} URLs; expected ${uniquePages.size}`);
if (occurrences(sitemap, "<image:image>") !== uniquePages.size) fail("Each image sitemap URL must contain exactly one image record");
if (/<image:(?:caption|title|license|geo_location)>/i.test(sitemap)) fail("Deprecated image sitemap tags are present");
if (occurrences(sitemapIndex, `<loc>${site}/sitemap-images.xml</loc>`) !== 1) fail("Image sitemap is missing or duplicated in the sitemap index");

for (const [pageURL, deal] of uniquePages) {
  const pageLoc = `<loc>${escapeXML(pageURL)}</loc>`;
  const imageLoc = `<image:loc>${escapeXML(String(deal.imageURL).trim())}</image:loc>`;
  if (occurrences(sitemap, pageLoc) !== 1) fail(`Image sitemap page URL missing or duplicated: ${pageURL}`);
  if (!sitemap.includes(imageLoc)) fail(`Image sitemap image URL missing for ${deal.id || pageURL}`);

  const pageFile = resolve(root, String(deal.url).replace(/^\//, ""), "index.html");
  const pageHTML = await readFile(pageFile, "utf8");
  if (!pageHTML.includes('content="index,follow') || pageHTML.includes('content="noindex')) {
    fail(`Image sitemap landing page is not indexable: ${deal.id || pageURL}`);
  }
  if (!pageHTML.includes(String(deal.imageURL).replaceAll("&", "&amp;")) && !pageHTML.includes(String(deal.imageURL))) {
    fail(`Landing page does not reference its sitemap image: ${deal.id || pageURL}`);
  }
}
for (const deal of browseOnlyDeals) {
  if (sitemap.includes(`<loc>${escapeXML(`${site}${deal.url}`)}</loc>`)) {
    fail(`Image sitemap contains browse-only deal ${deal.id}`);
  }
}

const size = (await stat(resolve(root, "sitemap-images.xml"))).size;
if (size >= 50 * 1024 * 1024) fail("Image sitemap exceeds the 50 MB uncompressed sitemap limit");
console.log(`Validated ${uniquePages.size} image sitemap entries from ${deals.length - browseOnlyDeals.length} indexable of ${deals.length} browseable deals (${size} bytes).`);
