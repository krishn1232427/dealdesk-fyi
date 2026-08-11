import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const concurrencyArg = args.find((arg) => arg.startsWith("--concurrency="));
const concurrency = Number(concurrencyArg?.split("=")[1] || 4);
const overwrite = args.includes("--overwrite");

if (positional.length < 2 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
  throw new Error("Usage: node scripts/capture-ebay-promotion-products.mjs <events.json> <output.json> [--concurrency=4] [--overwrite]");
}

const eventsPath = resolve(root, positional[0]);
const outputPath = resolve(root, positional[1]);
const feedPath = resolve(root, "data/best-deals.json");
const registryPath = resolve(root, "data/affiliate-programs.json");
const eventsSource = JSON.parse(await readFile(eventsPath, "utf8"));
const feed = JSON.parse(await readFile(feedPath, "utf8"));
const registry = JSON.parse(await readFile(registryPath, "utf8"));
const program = (registry.programs || []).find((item) => item.id === "ebay-partner-network-default");
const eventByURL = new Map((eventsSource.events || []).map((event) => [event.url, event]));
const promotionURLs = [...new Set((feed.deals || [])
  .filter((deal) => deal.network === "ebay-partner-network" && deal.sourceType === "ebay-product")
  .map((deal) => deal.sourcePromotionURL)
  .filter(Boolean))];

if (!program || program.applicationStatus !== "active" || program.commissionEligible !== true ||
    program.publicPublishingAllowed !== true) {
  throw new Error("The approved eBay Partner Network program is not active");
}
if (!promotionURLs.length) throw new Error("The current catalog does not identify any eBay promotion pages");
const unknownPromotionURLs = promotionURLs.filter((url) => !eventByURL.has(url));
if (unknownPromotionURLs.length) {
  throw new Error(`${unknownPromotionURLs.length} catalog promotion pages are absent from the supplied event source`);
}

const decode = (value) => JSON.parse(`"${value}"`);
const money = (value) => `$${Number(value).toFixed(2)}`;
const validImage = (value) => {
  try {
    const image = new URL(value);
    return image.protocol === "https:" && image.hostname === "i.ebayimg.com" ? image.href : "";
  } catch {
    return "";
  }
};
const cardSignature = (card) => JSON.stringify({
  title: card.title,
  condition: card.condition,
  currentPrice: card.currentPrice,
  originalPrice: card.originalPrice || "",
  imageURL: card.imageURL,
  freeShipping: card.freeShipping
});

const extractCards = (html, pageURL, fetchedAt) => {
  const event = eventByURL.get(pageURL);
  const chunks = html.split('{"__typename":"GridItemModule"').slice(1);
  const cards = [];
  const rejected = { missingIdentity: 0, missingDetails: 0, priceRange: 0, unusablePrice: 0, auction: 0, invalidImage: 0 };

  for (const chunk of chunks) {
    const idMatch = chunk.match(/"itemId":"(\d+)"[\s\S]{0,500}?"variationId":(null|"(\d+)")/);
    if (!idMatch) {
      rejected.missingIdentity += 1;
      continue;
    }
    const titleMatch = chunk.match(/"GridItemModuleDetailTitle","textLabel":"((?:\\.|[^"\\])*)"/);
    const conditionMatch = chunk.match(/"GridItemModuleDetailConditionAspects"[\s\S]{0,240}?"condition":"((?:\\.|[^"\\])*)"/);
    const imageMatch = chunk.match(/"image":\{[\s\S]{0,300}?"url":"((?:\\.|[^"\\])*)"/);
    if (!titleMatch || !conditionMatch || !imageMatch) {
      rejected.missingDetails += 1;
      continue;
    }
    if (/"GridItemModulePriceRange"/.test(chunk)) {
      rejected.priceRange += 1;
      continue;
    }
    const discountedMatch = chunk.match(/"GridItemModulePriceDiscounted","currencyCode":"([A-Z]{3})","newScalar":([0-9.]+),"oldScalar":([0-9.]+)/);
    const singleMatch = chunk.match(/"GridItemModulePrice","currencyCode":"([A-Z]{3})","scalar":([0-9.]+)/);
    const price = discountedMatch
      ? { currency: discountedMatch[1], current: Number(discountedMatch[2]), original: Number(discountedMatch[3]) }
      : singleMatch
        ? { currency: singleMatch[1], current: Number(singleMatch[2]) }
        : null;
    if (!price || price.currency !== "USD" || !Number.isFinite(price.current) || price.current <= 0) {
      rejected.unusablePrice += 1;
      continue;
    }

    const title = decode(titleMatch[1]).trim();
    let condition = decode(conditionMatch[1]).trim();
    if (/\b\d+\s+bids?\b/i.test(chunk) || /\bauction\b/i.test(title)) {
      rejected.auction += 1;
      continue;
    }
    const imageURL = validImage(decode(imageMatch[1]));
    if (!imageURL) {
      rejected.invalidImage += 1;
      continue;
    }
    if (/^Certified - Refurbished$/i.test(condition)) condition = "Certified Refurbished";

    const itemId = idMatch[1];
    const variationId = idMatch[3] || null;
    const merchantURL = `https://www.ebay.com/itm/${itemId}${variationId ? `?var=${variationId}` : ""}`;
    const freeShipping = /"GridItemModuleDetailShipping","isFree":true/.test(chunk);
    const rawLines = [
      title,
      condition,
      money(price.current),
      ...(price.original > price.current ? [money(price.original)] : []),
      ...(freeShipping ? ["Free shipping"] : [])
    ];

    cards.push({
      eventTitle: event.title,
      eventDescription: event.description || "",
      eventCategory: event.category,
      eventURL: pageURL,
      expiresAt: null,
      title,
      condition,
      currentPrice: money(price.current),
      ...(price.original > price.current ? { originalPrice: money(price.original) } : {}),
      freeShipping,
      imageURL,
      merchantURL,
      rawText: rawLines.join("\n"),
      fetchedAt
    });
  }

  return { cards, rejected, moduleCount: chunks.length };
};

const fetchPage = async (pageURL) => {
  const response = await fetch(pageURL, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9"
    }
  });
  const html = await response.text();
  const fetchedAt = new Date().toISOString();
  if (!response.ok || !html.includes('"__typename":"GridItemModule"')) {
    throw new Error(`${pageURL} did not return a usable eBay product grid (HTTP ${response.status})`);
  }
  return {
    pageURL,
    responseURL: response.url,
    responseStatus: response.status,
    responseSha256: createHash("sha256").update(html).digest("hex"),
    fetchedAt,
    ...extractCards(html, pageURL, fetchedAt)
  };
};

const pageResults = new Array(promotionURLs.length);
let cursor = 0;
const workers = Array.from({ length: Math.min(concurrency, promotionURLs.length) }, async () => {
  while (cursor < promotionURLs.length) {
    const index = cursor;
    cursor += 1;
    pageResults[index] = await fetchPage(promotionURLs[index]);
  }
});
await Promise.all(workers);

const recordsByKey = new Map();
const conflictKeys = new Set();
for (const page of pageResults) {
  for (const record of page.cards) {
    const parsed = new URL(record.merchantURL);
    const itemId = parsed.pathname.split("/").at(-1);
    const key = `${itemId}|${parsed.searchParams.get("var") || "0"}`;
    if (conflictKeys.has(key)) continue;
    const previous = recordsByKey.get(key);
    if (!previous) {
      recordsByKey.set(key, record);
      continue;
    }
    if (cardSignature(previous) !== cardSignature(record)) {
      conflictKeys.add(key);
      recordsByKey.delete(key);
    }
  }
}

const capturedAt = new Date().toISOString();
const payload = {
  version: 2,
  capturedAt,
  source: "Public eBay promotion-page product cards (SSR) captured for DealDesk",
  trackingParameters: program.trackingParameters,
  capturedEventURLs: promotionURLs,
  pageEvidence: pageResults.map((page) => ({
    url: page.pageURL,
    responseURL: page.responseURL,
    responseStatus: page.responseStatus,
    fetchedAt: page.fetchedAt,
    responseSha256: page.responseSha256,
    moduleCount: page.moduleCount,
    acceptedCardCount: page.cards.length,
    rejected: page.rejected
  })),
  captureSummary: {
    pageCount: pageResults.length,
    moduleCount: pageResults.reduce((sum, page) => sum + page.moduleCount, 0),
    acceptedRecordCount: recordsByKey.size,
    conflictingKeyCount: conflictKeys.size,
    rejected: pageResults.reduce((totals, page) => {
      for (const [reason, count] of Object.entries(page.rejected)) totals[reason] = (totals[reason] || 0) + count;
      return totals;
    }, {})
  },
  records: [...recordsByKey.values()]
};

await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: overwrite ? "w" : "wx" });
console.log(`Captured ${payload.records.length} exact fixed-price eBay cards across ${pageResults.length} promotion pages; rejected ${conflictKeys.size} conflicting keys.`);
