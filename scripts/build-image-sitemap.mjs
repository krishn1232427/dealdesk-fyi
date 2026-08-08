import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = "https://dealdesk.fyi";
const catalog = JSON.parse(await readFile(resolve(root, "data", "latest-deals.json"), "utf8"));
const deals = Array.isArray(catalog.deals) ? catalog.deals : [];

const xml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");
const dateOnly = (value) => {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};

const records = [];
const seenPages = new Set();
for (const deal of deals) {
  const path = String(deal.url || "");
  const imageURL = String(deal.imageURL || "").trim();
  if (!path.startsWith("/") || !/^https?:\/\//i.test(imageURL)) continue;
  const pageURL = `${site}${path}`;
  if (seenPages.has(pageURL)) continue;
  seenPages.add(pageURL);
  records.push({
    pageURL,
    imageURL,
    lastmod: dateOnly(deal.verifiedAt),
  });
}
if (!records.length) throw new Error("No deal images were eligible for the image sitemap");

records.sort((left, right) => left.pageURL.localeCompare(right.pageURL));
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${records.map((record) => `  <url><loc>${xml(record.pageURL)}</loc>${record.lastmod ? `<lastmod>${record.lastmod}</lastmod>` : ""}<image:image><image:loc>${xml(record.imageURL)}</image:loc></image:image></url>`).join("\n")}\n</urlset>\n`;
await writeFile(resolve(root, "sitemap-images.xml"), sitemap);

const latestDate = records.map((record) => record.lastmod).filter(Boolean).sort().at(-1) || new Date().toISOString().slice(0, 10);
const indexPath = resolve(root, "sitemap.xml");
let index = await readFile(indexPath, "utf8");
index = index.replace(/\s*<sitemap><loc>https:\/\/dealdesk\.fyi\/sitemap-images\.xml<\/loc>[\s\S]*?<\/sitemap>/g, "");
index = index.replace(/\s*<\/sitemapindex>/, `\n  <sitemap><loc>${site}/sitemap-images.xml</loc><lastmod>${latestDate}</lastmod></sitemap>\n</sitemapindex>`);
await writeFile(indexPath, index);

console.log(`Generated an image sitemap for ${records.length} deal landing pages.`);
