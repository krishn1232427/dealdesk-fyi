import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let changed = false;

const authorityPath = resolve(root, "scripts", "build-seo-authority.mjs");
let authority = await readFile(authorityPath, "utf8");
if (!authority.includes("const priceBasisFor = (deal) =>")) {
  const start = authority.indexOf("const comparisonFor = (deal) => {");
  const end = authority.indexOf("\n\nconst verdictFor = (deal, comparable) => {", start);
  if (start < 0 || end < 0) throw new Error("Could not locate comparison helpers in build-seo-authority.mjs");
  const replacement = `const comparisonStopwords = new Set([\n  "plan", "plans", "year", "years", "month", "months", "subscription", "subscriptions", "trial", "trials",\n  "premium", "basic", "starter", "standard", "annual", "monthly", "bundle", "bundles", "offer", "offers"\n]);\nconst priceBasisFor = (deal) => {\n  const current = String(deal.currentPrice || "").toLowerCase();\n  if (/(?:\\/|\\bper\\s+)(?:mo|month)\\b|\\bmonthly\\b/.test(current)) return "monthly";\n  if (/(?:\\/|\\bper\\s+)(?:yr|year)\\b|\\bannual(?:ly)?\\b/.test(current)) return "annual";\n  if (isMoney(current)) return "total";\n  return "non-monetary";\n};\nconst distinctiveComparisonTokens = (deal) => new Set(\n  modelTokens(deal.title).filter((token) => !comparisonStopwords.has(token) && !/^\\d+$/.test(token))\n);\n\nconst comparisonFor = (deal) => {\n  const family = familyByDealID.get(deal.id);\n  const basis = priceBasisFor(deal);\n  if (family) {\n    return family.deals\n      .filter((candidate) => candidate.id !== deal.id)\n      .sort((a, b) => {\n        const aSameBasis = priceBasisFor(a) === basis;\n        const bSameBasis = priceBasisFor(b) === basis;\n        if (aSameBasis !== bSameBasis) return aSameBasis ? -1 : 1;\n        const left = moneyNumber(a.currentPrice);\n        const right = moneyNumber(b.currentPrice);\n        if (aSameBasis && Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;\n        return scoreByID.get(b.id) - scoreByID.get(a.id);\n      })\n      .slice(0, 6);\n  }\n  const tokens = distinctiveComparisonTokens(deal);\n  if (tokens.size < 2 || basis === "non-monetary") return [];\n  return deals\n    .filter((candidate) => candidate.id !== deal.id && candidate.category === deal.category && priceBasisFor(candidate) === basis)\n    .map((candidate) => {\n      const candidateTokens = distinctiveComparisonTokens(candidate);\n      let shared = 0;\n      for (const token of tokens) if (candidateTokens.has(token)) shared += 1;\n      return { candidate, shared, similarity: jaccard(tokens, candidateTokens) };\n    })\n    .filter(({ shared, similarity }) => shared >= 2 && similarity >= 0.34)\n    .sort((a, b) => b.similarity - a.similarity || b.shared - a.shared || scoreByID.get(b.candidate.id) - scoreByID.get(a.candidate.id))\n    .slice(0, 4)\n    .map(({ candidate }) => candidate);\n};\n\nconst pricePositionFor = (deal, comparable) => {\n  const basis = priceBasisFor(deal);\n  const items = [deal, ...comparable].filter((item) =>\n    priceBasisFor(item) === basis && Number.isFinite(moneyNumber(item.currentPrice))\n  );\n  if (items.length < 2 || basis === "non-monetary" || !Number.isFinite(moneyNumber(deal.currentPrice))) return null;\n  const sorted = [...items].sort((a, b) => moneyNumber(a.currentPrice) - moneyNumber(b.currentPrice));\n  const rank = sorted.findIndex((item) => item.id === deal.id) + 1;\n  const prices = sorted.map((item) => moneyNumber(item.currentPrice));\n  const med = median(prices);\n  const current = moneyNumber(deal.currentPrice);\n  const delta = Number.isFinite(med) && med > 0 ? Math.round(((current - med) / med) * 100) : 0;\n  return { rank, total: sorted.length, median: med, delta, basis };\n};`;
  authority = `${authority.slice(0, start)}${replacement}${authority.slice(end)}`;
  await writeFile(authorityPath, authority);
  changed = true;
}

if (!authority.includes("const comparisonRows = position")) {
  const rowsStart = authority.indexOf("  const similarRows = comparable.length ?");
  const rowsEnd = authority.indexOf("\n  const authoritySection =", rowsStart);
  if (rowsStart < 0 || rowsEnd < 0) throw new Error("Could not locate comparison rendering in build-seo-authority.mjs");
  const rowsReplacement = [
    '  const comparisonRows = position',
    '    ? comparable.filter((candidate) => priceBasisFor(candidate) === priceBasisFor(deal))',
    '    : comparable;',
    '  const comparisonExplanation = position',
    '    ? `This offer ranks ${position.rank} of ${position.total} by displayed price among closely related offers using the same price basis.`',
    '    : "These offers share product-family or title signals. Prices may use different billing bases, conditions, sizes, or accessories, so compare terms instead of raw numbers.";',
    '  const similarRows = comparisonRows.length ? `<section class="deal-comparison-panel" aria-labelledby="similar-deals-title"><div><span class="page-kicker"><span></span> Similar offers</span><h2 id="similar-deals-title">Compare related prices before checkout</h2><p>${comparisonExplanation}</p></div><div class="deal-comparison-list">${comparisonRows.map((candidate) => `<a href="${dealPath(candidate)}"><span><strong>${esc(candidate.title)}</strong><small>${esc(conditionFrom(candidate))} · ${esc(merchantName(candidate))}</small></span><b>${esc(candidate.currentPrice || "See terms")}</b></a>`).join("")}</div></section>` : "";',
  ].join("\n");
  authority = `${authority.slice(0, rowsStart)}${rowsReplacement}${authority.slice(rowsEnd)}`;
  await writeFile(authorityPath, authority);
  changed = true;
}

const historyPath = resolve(root, "scripts", "build-price-history.mjs");
let history = await readFile(historyPath, "utf8");
if (!history.includes("const lowObservation =")) {
  const oldMetrics = `  const low = amounts.length ? Math.min(...amounts) : null;\n  const high = amounts.length ? Math.max(...amounts) : null;`;
  const newMetrics = `  const lowObservation = numeric.length ? numeric.reduce((best, item) => item.currentPriceAmount < best.currentPriceAmount ? item : best) : null;\n  const highObservation = numeric.length ? numeric.reduce((best, item) => item.currentPriceAmount > best.currentPriceAmount ? item : best) : null;\n  const low = lowObservation?.currentPriceAmount ?? null;\n  const high = highObservation?.currentPriceAmount ?? null;`;
  if (!history.includes(oldMetrics)) throw new Error("Could not locate price-history extrema calculation");
  history = history.replace(oldMetrics, newMetrics);
  history = history.replace(
    "return { current, numeric, low, high, changeAmount, changePercent, priceChanges };",
    "return { current, numeric, low, high, lowObservation, highObservation, changeAmount, changePercent, priceChanges };"
  );
  history = history.replace(
    '${Number.isFinite(metrics.low) ? esc(money(metrics.low)) : "Not available"}',
    '${metrics.lowObservation ? esc(metrics.lowObservation.currentPrice || money(metrics.low)) : "Not available"}'
  );
  history = history.replace(
    '${Number.isFinite(metrics.high) ? esc(money(metrics.high)) : "Not available"}',
    '${metrics.highObservation ? esc(metrics.highObservation.currentPrice || money(metrics.high)) : "Not available"}'
  );
  await writeFile(historyPath, history);
  changed = true;
}

console.log(changed ? "Installed DealDesk content-integrity safeguards." : "Content-integrity safeguards are already installed.");
