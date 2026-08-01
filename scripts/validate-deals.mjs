import { readFile } from "node:fs/promises";

const feedPaths = ["data/best-deals.json", "data/streaming-deals.json"];
const affiliateRegistry = JSON.parse(await readFile(new URL("../data/affiliate-programs.json", import.meta.url), "utf8"));
const cjPrograms = new Map((affiliateRegistry.programs || [])
  .filter((program) => program.network === "cj")
  .map((program) => [String(program.advertiserID), program]));
const expediaPrograms = new Map((affiliateRegistry.programs || [])
  .filter((program) => program.network === "expedia-group-direct")
  .map((program) => [String(program.trackingID), program]));
const ebayProgram = (affiliateRegistry.programs || [])
  .find((program) => program.id === "ebay-partner-network-default");
const seenIDs = new Set();
const errors = [];
const now = Date.now();
const validDate = (value) => value && Number.isFinite(new Date(value).getTime());

for (const feedPath of feedPaths) {
  const feed = JSON.parse(await readFile(new URL(`../${feedPath}`, import.meta.url), "utf8"));

  if (!Array.isArray(feed.deals) || feed.deals.length === 0) {
    errors.push(`${feedPath}: feed must contain at least one deal`);
    continue;
  }

  for (const deal of feed.deals) {
    const label = `${feedPath}:${deal.id || "missing-id"}`;

    if (!deal.id || seenIDs.has(deal.id)) errors.push(`${label}: missing or duplicate id`);
    if (deal.id) seenIDs.add(deal.id);
    if (deal.commissionEligible !== true) errors.push(`${label}: commissionEligible must be true`);
    if (deal.approvalStatus !== "approved") errors.push(`${label}: approvalStatus must be approved`);
    if (deal.status !== "active") errors.push(`${label}: status must be active`);
    if (!deal.trackingID) errors.push(`${label}: trackingID is required`);
    if (!deal.affiliateURL) errors.push(`${label}: affiliateURL is required`);
    if (!deal.title || !deal.summary || !deal.merchantName || !deal.category) {
      errors.push(`${label}: title, summary, merchantName, and category are required`);
    }
    if (!validDate(deal.verifiedAt)) errors.push(`${label}: verifiedAt must be a valid timestamp`);
    if (!validDate(deal.publishedAt)) errors.push(`${label}: publishedAt must be a valid timestamp`);
    if (!validDate(deal.expiresAt) && !validDate(deal.recheckAfter)) {
      errors.push(`${label}: expiresAt or recheckAfter is required`);
    }
    if (validDate(deal.expiresAt) && new Date(deal.expiresAt).getTime() <= now) {
      errors.push(`${label}: expiresAt is in the past`);
    }
    if (validDate(deal.recheckAfter) && new Date(deal.recheckAfter).getTime() <= now) {
      errors.push(`${label}: recheckAfter is in the past`);
    }

    let affiliateURL;
    try {
      affiliateURL = new URL(deal.affiliateURL);
    } catch {
      errors.push(`${label}: affiliateURL is invalid`);
      continue;
    }

    if (affiliateURL.protocol !== "https:") errors.push(`${label}: affiliateURL must use HTTPS`);

    if (deal.network === "amazon-associates") {
      if (affiliateURL.hostname !== "www.amazon.com") {
        errors.push(`${label}: Amazon Associates links must use www.amazon.com`);
      }
      if (affiliateURL.searchParams.get("tag") !== deal.trackingID) {
        errors.push(`${label}: Amazon tag must match trackingID`);
      }
    } else if (deal.network === "cj") {
      const allowedCJHosts = new Set(["www.kqzyfj.com", "www.tkqlhce.com"]);
      const expectedPath = `/click-${deal.trackingID}-${deal.linkID}`;
      const program = cjPrograms.get(String(deal.advertiserID || ""));

      if (!allowedCJHosts.has(affiliateURL.hostname)) {
        errors.push(`${label}: CJ link must use an approved CJ tracking host`);
      }
      if (!deal.linkID || affiliateURL.pathname !== expectedPath) {
        errors.push(`${label}: CJ path must match trackingID and linkID`);
      }
      if (!program) {
        errors.push(`${label}: CJ advertiser is missing from affiliate-programs.json`);
      } else {
        if (program.applicationStatus !== "active") errors.push(`${label}: CJ advertiser relationship is not active`);
        if (program.trackingLinkStatus !== "verified") errors.push(`${label}: CJ tracking link is not verified`);
        if (program.commissionEligible !== true) errors.push(`${label}: CJ program is not commission eligible`);
        if (program.publicPublishingAllowed !== true) errors.push(`${label}: CJ program is not approved for public publishing`);
        if (program.trackingURL !== deal.affiliateURL) errors.push(`${label}: CJ URL does not match the verified program URL`);
        if (String(program.linkID) !== String(deal.linkID)) errors.push(`${label}: CJ linkID does not match the verified program linkID`);
      }
    } else if (deal.network === "expedia-group-direct") {
      const program = expediaPrograms.get(String(deal.trackingID || ""));
      const expectedPath = `/affiliate/${deal.trackingID}`;

      if (affiliateURL.hostname !== "www.hotels.com") {
        errors.push(`${label}: Expedia Group public travel deal must use the verified Hotels.com host`);
      }
      if (affiliateURL.pathname !== expectedPath) {
        errors.push(`${label}: Hotels.com affiliate path must match trackingID`);
      }
      if (!program) {
        errors.push(`${label}: Expedia Group tracking relationship is missing from affiliate-programs.json`);
      } else {
        if (program.applicationStatus !== "active") errors.push(`${label}: Expedia Group relationship is not active`);
        if (program.trackingLinkStatus !== "verified") errors.push(`${label}: Expedia Group tracking link is not verified`);
        if (program.commissionEligible !== true) errors.push(`${label}: Expedia Group program is not commission eligible`);
        if (program.publicPublishingAllowed !== true) errors.push(`${label}: Expedia Group program is not approved for public publishing`);
        if (program.trackingURL !== deal.affiliateURL) errors.push(`${label}: Hotels.com URL does not match the verified program URL`);
      }
    } else if (deal.network === "ebay-partner-network") {
      const allowedEbayHosts = new Set(["rover.ebay.com", "ebay.us", "www.ebay.com"]);
      const hasTrackingSignal = affiliateURL.hostname !== "www.ebay.com" ||
        affiliateURL.searchParams.has("campid") || affiliateURL.searchParams.has("mkcid");

      if (!allowedEbayHosts.has(affiliateURL.hostname) || !hasTrackingSignal) {
        errors.push(`${label}: eBay URL must be an EPN-generated tracking link`);
      }
      if (deal.affiliateURL === deal.merchantURL) {
        errors.push(`${label}: eBay affiliateURL cannot equal the untracked merchantURL`);
      }
      if (!ebayProgram || ebayProgram.applicationStatus !== "active" ||
          ebayProgram.commissionEligible !== true || ebayProgram.publicPublishingAllowed !== true) {
        errors.push(`${label}: eBay Partner Network relationship is not approved for publishing`);
      }
      if (deal.trackingID !== ebayProgram?.campaignName) {
        errors.push(`${label}: eBay trackingID must match the approved campaign`);
      }
    } else {
      errors.push(`${label}: network is not approved for the public DealDesk feed`);
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Validated ${seenIDs.size} commission-eligible deals.`);
