#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const homepagePath = resolve(root, "index.html");
const validatorPath = resolve(root, "scripts/validate-deals.mjs");

const homepage = await readFile(homepagePath, "utf8");
const eligiblePattern = /        function eligible\(deal\) \{[\s\S]*?\n        \}\n\n        function hasGenuineMerchantImage/;
const eligibleMatches = homepage.match(new RegExp(eligiblePattern.source, "g")) || [];
if (eligibleMatches.length !== 1) {
  throw new Error(`Expected exactly one homepage eligible() function, found ${eligibleMatches.length}`);
}

const fixedEligible = `        function eligible(deal) {
          var now = Date.now();
          var expiresAt = deal && deal.expiresAt ? new Date(deal.expiresAt).getTime() : Infinity;
          return Boolean(
            deal &&
              deal.status === "active" &&
              deal.commissionEligible === true &&
              deal.approvalStatus === "approved" &&
              commissionAccrualReadyByNetwork[deal.network] === true &&
              deal.trackingID &&
              deal.affiliateURL &&
              deal.verifiedAt &&
              (!deal.expiresAt || (Number.isFinite(expiresAt) && now <= expiresAt)) &&
              hasGenuineMerchantImage(deal)
          );
        }

        function hasGenuineMerchantImage`;

const nextHomepage = homepage.replace(eligiblePattern, fixedEligible);
if (nextHomepage === homepage) throw new Error("Homepage lifecycle replacement made no change");
if (nextHomepage.includes("now <= recheckAfter") || nextHomepage.includes("!deal.recheckAfter")) {
  throw new Error("Homepage still contains a recheckAfter hard-expiration gate");
}
await writeFile(homepagePath, nextHomepage, "utf8");

let validator = await readFile(validatorPath, "utf8");
const regressionCheck = `if (homepageSource.includes("now <= recheckAfter") ||
    homepageSource.includes("!deal.recheckAfter")) {
  errors.push("index.html: homepage must not treat recheckAfter as a hard expiration");
}
`;
if (!validator.includes(regressionCheck)) {
  const marker = `if (!lifecycleOutboundPage.includes("/data/outbound-approvals.json") ||`;
  const markerIndex = validator.indexOf(marker);
  if (markerIndex < 0) throw new Error("Could not locate validator homepage/outbound boundary");
  validator = validator.slice(0, markerIndex) + regressionCheck + validator.slice(markerIndex);
  await writeFile(validatorPath, validator, "utf8");
}

console.log("Homepage now uses only explicit expiresAt as its hard deal deadline.");
