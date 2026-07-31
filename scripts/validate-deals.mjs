import { readFile } from "node:fs/promises";

const feedPaths = ["data/best-deals.json", "data/streaming-deals.json"];
const seenIDs = new Set();
const errors = [];

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
    if (!deal.trackingID) errors.push(`${label}: trackingID is required`);
    if (!deal.affiliateURL) errors.push(`${label}: affiliateURL is required`);
    if (!deal.title || !deal.summary) errors.push(`${label}: title and summary are required`);

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
    } else {
      errors.push(`${label}: network is not yet approved for the public DealDesk feed`);
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Validated ${seenIDs.size} commission-eligible deals.`);
