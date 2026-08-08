import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "scripts", "build-seo-authority.mjs");
let source = await readFile(target, "utf8");
const marker = "const tagPattern = /<meta\\b[^>]*>/gi;";

if (source.includes(marker)) {
  console.log("SEO metadata deduplication is already installed.");
  process.exit(0);
}

const start = source.indexOf("const replaceMeta = (html, name, value) => {");
const end = source.indexOf("\n\nconst seoTargets = [];", start);
if (start < 0 || end < 0) {
  throw new Error("Could not locate the SEO metadata helper block.");
}

const replacement = [
  'const replaceMeta = (html, name, value) => {',
  '  const tagPattern = /<meta\\b[^>]*>/gi;',
  '  const cleaned = html.replace(tagPattern, (tag) => {',
  "    const match = tag.match(/\\bname\\s*=\\s*[\"']([^\"']+)[\"']/i);",
  '    return match?.[1]?.toLowerCase() === String(name).toLowerCase() ? "" : tag;',
  '  });',
  '  return cleaned.replace(/<\\/title>/, `</title>\\n  <meta name="${name}" content="${esc(value)}" />`);',
  '};',
  'const replaceProperty = (html, property, value) => {',
  '  const tagPattern = /<meta\\b[^>]*>/gi;',
  '  const cleaned = html.replace(tagPattern, (tag) => {',
  "    const match = tag.match(/\\bproperty\\s*=\\s*[\"']([^\"']+)[\"']/i);",
  '    return match?.[1]?.toLowerCase() === String(property).toLowerCase() ? "" : tag;',
  '  });',
  '  return cleaned.replace(/<\\/title>/, `</title>\\n  <meta property="${property}" content="${esc(value)}" />`);',
  '};',
].join("\n");

source = `${source.slice(0, start)}${replacement}${source.slice(end)}`;
await writeFile(target, source);
console.log("Installed robust SEO metadata deduplication.");
