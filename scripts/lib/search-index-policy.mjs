import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SEARCH_INDEX_POLICY_VERSION = 2;
export const SEARCH_INDEX_POLICY_NAME = "quality-diversity-v2";
export const SEARCH_INDEX_GLOBAL_CAP = 100;
export const SEARCH_INDEX_EBAY_PER_SOURCE_CAP = 3;
export const SEARCH_INDEX_MIN_EBAY_AGE_MS = 24 * 60 * 60 * 1000;
export const SEARCH_INDEX_MIN_REMAINING_MS = 6 * 60 * 60 * 1000;

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const money = (value) => Number(String(value || "").replace(/[^0-9.]/g, ""));
const knownCondition = /\b(?:new|open box|refurbished|used|pre-owned)\b/i;
const shippingSignal = /\b(?:free )?shipping\b/i;
const isEbayProduct = (deal) =>
  deal.network === "ebay-partner-network" && deal.sourceType === "ebay-product";
const valueSort = (left, right) => {
  const leftCondition = knownCondition.test(String(left.priceNote || "")) ? 1 : 0;
  const rightCondition = knownCondition.test(String(right.priceNote || "")) ? 1 : 0;
  if (leftCondition !== rightCondition) return rightCondition - leftCondition;
  const leftShipping = shippingSignal.test(String(left.priceNote || "")) ? 1 : 0;
  const rightShipping = shippingSignal.test(String(right.priceNote || "")) ? 1 : 0;
  if (leftShipping !== rightShipping) return rightShipping - leftShipping;
  const leftComparison = money(left.originalPrice) > money(left.currentPrice) ? 1 : 0;
  const rightComparison = money(right.originalPrice) > money(right.currentPrice) ? 1 : 0;
  if (leftComparison !== rightComparison) return rightComparison - leftComparison;
  const leftSavings = Math.max(0, money(left.originalPrice) - money(left.currentPrice));
  const rightSavings = Math.max(0, money(right.originalPrice) - money(right.currentPrice));
  if (leftSavings !== rightSavings) return rightSavings - leftSavings;
  const leftScore = Number(left.rankingScore) || 0;
  const rightScore = Number(right.rankingScore) || 0;
  if (leftScore !== rightScore) return rightScore - leftScore;
  return String(left.id).localeCompare(String(right.id));
};

const ebayObservationStats = async () => {
  const names = (await readdir(resolve(root, "data")))
    .filter((name) => /^ebay-products-[a-zA-Z0-9:-]+\.json$/.test(name))
    .sort();
  const stats = new Map();
  for (const name of names) {
    const capture = JSON.parse(await readFile(resolve(root, "data", name), "utf8"));
    const capturedAt = new Date(capture.capturedAt || "").getTime();
    const urls = new Set((capture.records || []).map((record) => record.merchantURL).filter(Boolean));
    for (const url of urls) {
      const prior = stats.get(url) || { count: 0, latestAt: -Infinity };
      stats.set(url, {
        count: prior.count + 1,
        latestAt: Number.isFinite(capturedAt) ? Math.max(prior.latestAt, capturedAt) : prior.latestAt,
      });
    }
  }
  return stats;
};

export const evaluateSearchIndexPolicy = async (deals, evaluatedAt = Date.now()) => {
  const now = Number(evaluatedAt);
  if (!Number.isFinite(now)) throw new Error("Search-index policy requires a finite evaluation timestamp");
  const observations = await ebayObservationStats();
  const states = new Map();
  const qualityCandidates = [];
  const ebayCandidatesBySource = new Map();

  for (const deal of deals) {
    const recheckAt = deal.recheckAfter ? new Date(deal.recheckAfter).getTime() : NaN;
    if (!Number.isFinite(recheckAt)) {
      states.set(deal.id, { indexable: false, reason: "recheck-missing-or-invalid" });
      continue;
    }
    if (now > recheckAt) {
      states.set(deal.id, { indexable: false, reason: "verification-overdue" });
      continue;
    }
    if (recheckAt - now < SEARCH_INDEX_MIN_REMAINING_MS) {
      states.set(deal.id, { indexable: false, reason: "verification-window-too-short" });
      continue;
    }
    if (!isEbayProduct(deal)) {
      qualityCandidates.push(deal);
      continue;
    }

    const publishedAt = new Date(deal.publishedAt || "").getTime();
    const observation = observations.get(deal.merchantURL) || { count: 0, latestAt: -Infinity };
    if (!Number.isFinite(publishedAt) || now - publishedAt < SEARCH_INDEX_MIN_EBAY_AGE_MS ||
        observation.latestAt - publishedAt < SEARCH_INDEX_MIN_EBAY_AGE_MS) {
      states.set(deal.id, { indexable: false, reason: "first-seen-quarantine" });
      continue;
    }
    if (observation.count < 2) {
      states.set(deal.id, { indexable: false, reason: "insufficient-repeat-observation" });
      continue;
    }
    const source = String(deal.sourcePromotionURL || "unassigned-source");
    const group = ebayCandidatesBySource.get(source) || [];
    group.push(deal);
    ebayCandidatesBySource.set(source, group);
  }

  const manuallyReviewed = qualityCandidates.sort(valueSort);
  const selectedManual = manuallyReviewed.slice(0, SEARCH_INDEX_GLOBAL_CAP);
  const selectedManualIDs = new Set(selectedManual.map((deal) => deal.id));
  for (const deal of manuallyReviewed) {
    states.set(deal.id, selectedManualIDs.has(deal.id)
      ? { indexable: true, reason: "verification-current-curated" }
      : { indexable: false, reason: "catalog-cap" });
  }

  const sourceWinners = [];
  for (const source of [...ebayCandidatesBySource.keys()].sort()) {
    const candidates = ebayCandidatesBySource.get(source).sort(valueSort);
    const winners = candidates.slice(0, SEARCH_INDEX_EBAY_PER_SOURCE_CAP);
    const winnerIDs = new Set(winners.map((deal) => deal.id));
    sourceWinners.push(...winners);
    for (const deal of candidates) {
      if (!winnerIDs.has(deal.id)) states.set(deal.id, { indexable: false, reason: "source-diversity-cap" });
    }
  }

  const remainingCapacity = Math.max(0, SEARCH_INDEX_GLOBAL_CAP - selectedManual.length);
  const selectedEbay = sourceWinners.sort(valueSort).slice(0, remainingCapacity);
  const selectedEbayIDs = new Set(selectedEbay.map((deal) => deal.id));
  for (const deal of sourceWinners) {
    states.set(deal.id, selectedEbayIDs.has(deal.id)
      ? { indexable: true, reason: "verification-current-repeat-observed-curated" }
      : { indexable: false, reason: "catalog-cap" });
  }

  for (const deal of deals) {
    if (!states.has(deal.id)) states.set(deal.id, { indexable: false, reason: "quality-tier-not-selected" });
  }
  return states;
};
