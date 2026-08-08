#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEWED_AT = "2026-08-07T13:50:02.000Z";

const paths = {
  build: resolve(root, "scripts/build-seo.mjs"),
  validate: resolve(root, "scripts/validate-deals.mjs"),
  outboundPage: resolve(root, "out/index.html"),
  worker: resolve(root, "workers/sovrn-out-worker.js"),
  programs: resolve(root, "data/affiliate-programs.json"),
  networks: resolve(root, "data/affiliate-networks.json"),
  networksMarkdown: resolve(root, "data/affiliate-networks.md"),
  ticketNetworkEvidence: resolve(root, "data/affiliate-evidence/ticketnetwork-awin-approval-20260806.json"),
  malwarebytesEvidence: resolve(root, "data/affiliate-evidence/malwarebytes-cj-approval-20260807.json"),
};

function patchBlock(source, before, after, label) {
  if (source.includes(after)) return source;
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Could not find expected source block: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Expected one source block but found multiple: ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

async function updateText(path, transform) {
  const current = await readFile(path, "utf8");
  const next = transform(current);
  if (next !== current) {
    await writeFile(path, next, "utf8");
    console.log(`Updated ${path}`);
  } else {
    console.log(`No change needed for ${path}`);
  }
}

async function writeJson(path, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  let current = "";
  try { current = await readFile(path, "utf8"); } catch {}
  if (next !== current) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, next, "utf8");
    console.log(`Updated ${path}`);
  } else {
    console.log(`No change needed for ${path}`);
  }
}

function upsertById(items, record) {
  const index = items.findIndex((item) => item.id === record.id);
  if (index < 0) items.push(record);
  else items[index] = { ...items[index], ...record };
}

function upsertAdvertiser(items, record) {
  const index = items.findIndex((item) =>
    item.network === record.network && String(item.advertiserID) === String(record.advertiserID)
  );
  if (index < 0) items.push(record);
  else items[index] = { ...items[index], ...record };
}

await updateText(paths.build, (source) => {
  source = patchBlock(source,
`const isLiveDeal = (deal) => {
  const expiresAt = deal.expiresAt ? new Date(deal.expiresAt).getTime() : Infinity;
  const recheckAfter = deal.recheckAfter ? new Date(deal.recheckAfter).getTime() : Infinity;
  return deal.status === "active" &&
    deal.commissionEligible === true &&
    deal.approvalStatus === "approved" &&
    hasCommissionPath(deal) &&
    Boolean(deal.affiliateURL) &&
    Boolean(deal.verifiedAt) &&
    now <= expiresAt &&
    now <= recheckAfter;
};
const validUntilFor = (deal) => {
  const deadlines = [deal.expiresAt, deal.recheckAfter]
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  return deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : "";
};`,
`const isLiveDeal = (deal) => {
  const expiresAt = deal.expiresAt ? new Date(deal.expiresAt).getTime() : Infinity;
  return deal.status === "active" &&
    deal.commissionEligible === true &&
    deal.approvalStatus === "approved" &&
    hasCommissionPath(deal) &&
    Boolean(deal.affiliateURL) &&
    Boolean(deal.verifiedAt) &&
    now <= expiresAt;
};
// recheckAfter is a freshness-review date, not an offer-expiration date.
// Only an explicit expiresAt or a non-active status can remove a deal.
const validUntilFor = (deal) => {
  const expiresAt = deal.expiresAt ? new Date(deal.expiresAt).getTime() : NaN;
  return Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : "";
};`,
    "build lifecycle policy");

  source = patchBlock(source,
`const commissionBlockedDealCount = allFeedDeals.filter((deal) => {
  const expiresAt = deal.expiresAt ? new Date(deal.expiresAt).getTime() : Infinity;
  const recheckAfter = deal.recheckAfter ? new Date(deal.recheckAfter).getTime() : Infinity;
  return deal.status === "active" && deal.commissionEligible === true &&
    deal.approvalStatus === "approved" && !hasCommissionPath(deal) &&
    Boolean(deal.affiliateURL) && Boolean(deal.verifiedAt) &&
    now <= expiresAt && now <= recheckAfter;
}).length;`,
`const commissionBlockedDealCount = allFeedDeals.filter((deal) => {
  const expiresAt = deal.expiresAt ? new Date(deal.expiresAt).getTime() : Infinity;
  return deal.status === "active" && deal.commissionEligible === true &&
    deal.approvalStatus === "approved" && !hasCommissionPath(deal) &&
    Boolean(deal.affiliateURL) && Boolean(deal.verifiedAt) &&
    now <= expiresAt;
}).length;
const verificationDueDealCount = allFeedDeals.filter((deal) => {
  const expiresAt = deal.expiresAt ? new Date(deal.expiresAt).getTime() : Infinity;
  const recheckAfter = deal.recheckAfter ? new Date(deal.recheckAfter).getTime() : Infinity;
  return deal.status === "active" && now <= expiresAt &&
    Number.isFinite(recheckAfter) && now > recheckAfter;
}).length;`,
    "build commission-blocked count");

  source = patchBlock(source,
`      function dealIsCurrent(deal) {
        return timestampIsCurrent(deal.expiresAt) && timestampIsCurrent(deal.recheckAfter);
      }

      function cardIsCurrent(card) {
        return timestampIsCurrent(card.dataset.expiresAt) && timestampIsCurrent(card.dataset.recheckAfter);
      }`,
`      function dealIsCurrent(deal) {
        return timestampIsCurrent(deal.expiresAt);
      }

      function cardIsCurrent(card) {
        return timestampIsCurrent(card.dataset.expiresAt);
      }`,
    "browser lifecycle policy");

  source = patchBlock(source,
`console.log(\`Built \${deals.length} commission-qualified image-qualified deal pages and sitemap.xml; withheld \${withheldDealCount} live offers without genuine merchant imagery and \${commissionBlockedDealCount} offers without a verified commission-accrual path.\`);`,
`console.log(\`Built \${deals.length} commission-qualified image-qualified deal pages and sitemap.xml; withheld \${withheldDealCount} live offers without genuine merchant imagery and \${commissionBlockedDealCount} offers without a verified commission-accrual path. \${verificationDueDealCount} active offers are due for a verification refresh but remain listed until hard expiry or an explicit status change.\`);`,
    "build completion log");

  return source;
});

await updateText(paths.validate, (source) => {
  source = patchBlock(source,
`const errors = [];
const staleDeals = [];
const now = Date.now();`,
`const errors = [];
const staleDeals = [];
const dueForRecheckDeals = [];
const now = Date.now();`,
    "validator review tracking");

  source = patchBlock(source,
`const validUntilFor = (deal) => {
  const deadlines = [deal.expiresAt, deal.recheckAfter]
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  return deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : "";
};`,
`const validUntilFor = (deal) => {
  const expiresAt = deal.expiresAt ? new Date(deal.expiresAt).getTime() : NaN;
  return Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : "";
};`,
    "validator hard deadline");

  source = patchBlock(source,
`const isPublicDeal = (deal) => {
  const expiresAt = validDate(deal.expiresAt) ? new Date(deal.expiresAt).getTime() : Infinity;
  const recheckAfter = validDate(deal.recheckAfter) ? new Date(deal.recheckAfter).getTime() : Infinity;
  return deal.status === "active" && deal.commissionEligible === true &&
    deal.approvalStatus === "approved" && hasCommissionPath(deal) &&
    Boolean(deal.affiliateURL) && Boolean(deal.verifiedAt) &&
    now <= expiresAt && now <= recheckAfter && hasGenuineMerchantImage(deal);
};`,
`const isPublicDeal = (deal) => {
  const expiresAt = validDate(deal.expiresAt) ? new Date(deal.expiresAt).getTime() : Infinity;
  return deal.status === "active" && deal.commissionEligible === true &&
    deal.approvalStatus === "approved" && hasCommissionPath(deal) &&
    Boolean(deal.affiliateURL) && Boolean(deal.verifiedAt) &&
    now <= expiresAt && hasGenuineMerchantImage(deal);
};`,
    "validator public lifecycle policy");

  source = patchBlock(source,
`    const expiresAt = validDate(deal.expiresAt) ? new Date(deal.expiresAt).getTime() : Infinity;
    const recheckAfter = validDate(deal.recheckAfter) ? new Date(deal.recheckAfter).getTime() : Infinity;
    if (expiresAt <= now || recheckAfter <= now) staleDeals.push({ deal, label });`,
`    const expiresAt = validDate(deal.expiresAt) ? new Date(deal.expiresAt).getTime() : Infinity;
    const recheckAfter = validDate(deal.recheckAfter) ? new Date(deal.recheckAfter).getTime() : Infinity;
    if (expiresAt <= now) staleDeals.push({ deal, label });
    else if (deal.status === "active" && recheckAfter <= now) dueForRecheckDeals.push({ deal, label });`,
    "validator expiry versus review");

  source = patchBlock(source,
`if (staleDeals.length) console.log(\`Withheld \${staleDeals.length} expired or due-for-recheck deals from public output.\`);
console.log(\`Validated \${seenIDs.size} affiliate deal records; \${publicDeals.length} are currently commission-qualified and public.\`);`,
`if (staleDeals.length) console.log(\`Withheld \${staleDeals.length} expired deals from public output.\`);
if (dueForRecheckDeals.length) {
  console.warn(\`\${dueForRecheckDeals.length} active deals are due for verification refresh but remain public until hard expiry or an explicit status change.\`);
}
console.log(\`Validated \${seenIDs.size} affiliate deal records; \${publicDeals.length} are currently commission-qualified and public.\`);`,
    "validator output");

  return source;
});

await updateText(paths.outboundPage, (source) => patchBlock(source,
`        var validUntil = approval ? Date.parse(approval.validUntil) : NaN;
        if (!approval || !Number.isFinite(validUntil) || Date.now() > validUntil) {
          fail("This offer is no longer within DealDesk's verified availability window.");
          return;
        }`,
`        var hasHardDeadline = Boolean(approval && approval.validUntil);
        var validUntil = hasHardDeadline ? Date.parse(approval.validUntil) : Infinity;
        if (!approval || (hasHardDeadline && (!Number.isFinite(validUntil) || Date.now() > validUntil))) {
          fail("This offer is no longer within DealDesk's verified availability window.");
          return;
        }`,
  "browser outbound hard deadline"));

await updateText(paths.worker, (source) => patchBlock(source,
`    const validUntil = approval ? Date.parse(approval.validUntil) : NaN;
    if (!approval || !Number.isFinite(validUntil) || Date.now() > validUntil) {
      return htmlResponse("This offer is no longer within DealDesk's verified availability window.", 410);
    }`,
`    const hasHardDeadline = Boolean(approval && approval.validUntil);
    const validUntil = hasHardDeadline ? Date.parse(approval.validUntil) : Infinity;
    if (!approval || (hasHardDeadline && (!Number.isFinite(validUntil) || Date.now() > validUntil))) {
      return htmlResponse("This offer is no longer within DealDesk's verified availability window.", 410);
    }`,
  "worker outbound hard deadline"));

const registry = JSON.parse(await readFile(paths.programs, "utf8"));
registry.publisherAccounts ||= [];
registry.programs ||= [];

const awinAccount = registry.publisherAccounts.find((account) => account.network === "awin");
if (awinAccount) {
  awinAccount.status = "active publisher account; BLUETTI US and TicketNetwork are approved advertiser relationships; payment remains blocked until required Awin tax information is complete";
  awinAccount.approvedAdvertisers ||= [];
  upsertAdvertiser(awinAccount.approvedAdvertisers, {
    network: "awin",
    merchantName: "TicketNetwork",
    advertiserID: "89223",
    relationship: "approved",
    approvedAt: "2026-08-06T18:41:05.000Z",
    trackingLinkStatus: "unverified"
  });
}

const cjAccount = registry.publisherAccounts.find((account) => account.network === "cj");
if (cjAccount) {
  cjAccount.status = "active; payout onboarding verified; Malwarebytes is approved in addition to the existing verified advertiser relationships";
  cjAccount.approvedAdvertisers ||= [];
  upsertAdvertiser(cjAccount.approvedAdvertisers, {
    network: "cj",
    merchantName: "Malwarebytes",
    advertiserID: "3743656",
    relationship: "active",
    approvedAt: "2026-08-07T13:50:02.000Z",
    trackingLinkStatus: "unverified"
  });
}

const maxPriority = Math.max(0, ...registry.programs.map((program) => Number(program.priority) || 0));
const existingTicketNetwork = registry.programs.find((program) => program.id === "awin-ticketnetwork-89223");
const existingMalwarebytes = registry.programs.find((program) => program.id === "cj-malwarebytes-3743656");

upsertById(registry.programs, {
  id: "awin-ticketnetwork-89223",
  network: "awin",
  merchantName: "TicketNetwork",
  advertiserID: "89223",
  publisherID: "2973087",
  merchantURL: "https://www.ticketnetwork.com/",
  profileURL: "https://ui.awin.com/awin/affiliate/2973087/merchant-profile/89223",
  category: "Live event tickets",
  commission: "Not stated in the authenticated approval email; verify the current signed-in Awin terms before publication",
  attribution: "Not stated in the authenticated approval email; verify in Awin before publication",
  status: "Active advertiser relationship — exact payable tracking link, commercial terms, destination, and approved creative remain unverified",
  applicationStatus: "active",
  approvedAt: "2026-08-06T18:41:05.000Z",
  relationshipEvidence: "Authenticated Awin email: Welcome to the TicketNetwork Affiliate Program",
  trackingLinkStatus: "unverified",
  commissionEligible: false,
  publicPublishingAllowed: false,
  restrictions: "Do not publish TicketNetwork offers until Awin tax onboarding is complete and the exact DealDesk tracking link, current terms, event availability, pricing disclosures, and approved imagery are verified together.",
  summary: "Awin confirmed that DealDesk was approved for TicketNetwork advertiser 89223. The approval email directs publishers to Awin Linking Methods for banners and tracking links, but it does not state the commission schedule or attribution window. The relationship is recorded as active but remains nonpublic until payout readiness and an exact payable link are verified.",
  evidenceRecord: "data/affiliate-evidence/ticketnetwork-awin-approval-20260806.json",
  priority: existingTicketNetwork?.priority ?? maxPriority + 1
});

upsertById(registry.programs, {
  id: "cj-malwarebytes-3743656",
  network: "cj",
  merchantName: "Malwarebytes",
  advertiserID: "3743656",
  publisherID: "8007406",
  merchantURL: "https://www.malwarebytes.com/",
  profileURL: "https://members.cj.com/member/7685648/publisher/advertisers/findAdvertisers.cj",
  category: "Cybersecurity software",
  commission: "30% per qualifying sale",
  attribution: "45-day referral period",
  paymentTiming: "Approval email states commission is received within 30 days",
  priceReference: "Approval email advertised a one-year, one-device PC or Mac subscription at $44.99",
  status: "Active advertiser relationship — exact CJ tracking link and live customer offer remain unverified",
  applicationStatus: "active",
  approvedAt: "2026-08-07T13:50:02.000Z",
  relationshipEvidence: "Authenticated CJ advertiser email: Welcome to the Malwarebytes Affiliate Program",
  trackingLinkStatus: "unverified",
  commissionEligible: false,
  publicPublishingAllowed: false,
  restrictions: "Publish only after generating and verifying an exact DealDesk CJ link, current price or promotion, destination, eligibility, customer disclosures, and genuine Malwarebytes creative.",
  summary: "CJ advertiser 3743656 welcomed DealDesk to the Malwarebytes affiliate program. The authenticated email states a 30% sale commission, 45-day referral period, seasonal promotions, and advertiser-handled billing and support. No exact DealDesk tracking link was included, so the approval is recorded without exposing a public offer.",
  evidenceRecord: "data/affiliate-evidence/malwarebytes-cj-approval-20260807.json",
  priority: existingMalwarebytes?.priority ?? maxPriority + (existingTicketNetwork ? 1 : 2)
});

registry.updatedAt = REVIEWED_AT;
await writeJson(paths.programs, registry);

const networks = JSON.parse(await readFile(paths.networks, "utf8"));
const awinNetwork = (networks.networks || []).find((network) => network.id === "awin");
if (awinNetwork) {
  awinNetwork.dealDeskStatus = "onboarding";
  awinNetwork.payoutReadiness = "unverified";
  awinNetwork.commissionAccess = true;
  awinNetwork.canPublish = false;
  awinNetwork.blockingReason = "BLUETTI US and TicketNetwork are approved advertiser relationships, but Awin states it cannot pay DealDesk until required tax information is complete. TicketNetwork's exact payable link and signed-in commercial terms are also unverified.";
  awinNetwork.nextAction = "Complete Awin tax onboarding; then verify TicketNetwork advertiser 89223 terms and an exact payable link, and reverify every BLUETTI or TicketNetwork offer before publication.";
  awinNetwork.lastCheckedAt = REVIEWED_AT;
}
const cjNetwork = (networks.networks || []).find((network) => network.id === "cj");
if (cjNetwork) {
  cjNetwork.nextAction = "Keep NordVPN, Surfshark, NordPass, Magzter, and Proton links verified. Malwarebytes advertiser 3743656 is now active; generate and verify its first exact CJ link and live offer before publication.";
  cjNetwork.lastCheckedAt = REVIEWED_AT;
}
networks.updatedAt = REVIEWED_AT;
await writeJson(paths.networks, networks);

await updateText(paths.networksMarkdown, (source) => {
  const lines = source.split("\n");
  const refreshedIndex = lines.findIndex((line) => line.startsWith("Last refreshed:"));
  if (refreshedIndex >= 0) lines[refreshedIndex] = `Last refreshed: ${REVIEWED_AT}`;
  const cjIndex = lines.findIndex((line) => line.startsWith("| [CJ]("));
  if (cjIndex >= 0) {
    lines[cjIndex] = `| [CJ](https://www.cj.com/) | affiliate network | global | active payable | verified | Yes — program-specific | [Apply / enroll](https://public.cj.com/signup/publisher) | [Official source](https://www.cj.com/publisher) | ${REVIEWED_AT} | Keep NordVPN, Surfshark, NordPass, Magzter, and Proton links verified. Malwarebytes advertiser 3743656 is now active; generate and verify its first exact CJ link and live offer before publication. |`;
  }
  const awinIndex = lines.findIndex((line) => line.startsWith("| [Awin]("));
  if (awinIndex >= 0) {
    lines[awinIndex] = `| [Awin](https://www.awin.com/us/) | affiliate network | global | onboarding | unverified | No | [Apply / enroll](https://ui.awin.com/publisher-signup/en/awin) | [Official source](https://www.awin.com/us/news-and-events/awin-news/awin-shareasale-new-era) | ${REVIEWED_AT} | Complete Awin tax onboarding; then verify TicketNetwork advertiser 89223 terms and an exact payable link, and reverify every BLUETTI or TicketNetwork offer before publication. |`;
  }
  return lines.join("\n");
});

await writeJson(paths.ticketNetworkEvidence, {
  version: 1,
  reviewedAt: "2026-08-06T18:41:05.000Z",
  source: "Authenticated Awin approval email delivered to hello.launchdesk@gmail.com",
  publisher: {
    legalName: "Launchdesk LLC",
    publisherID: "2973087",
    channel: "DealDesk"
  },
  advertiser: {
    name: "TicketNetwork",
    advertiserID: "89223",
    relationship: "Approved"
  },
  evidence: {
    subject: "Welcome to the TicketNetwork Affiliate Program",
    statement: "Awin confirmed approval and directed DealDesk to Merchants > Linking Methods for current banners and tracking links.",
    followupSubject: "TicketNetwork (89223): This Week's Top Sellers & Upcoming Onsales"
  },
  commercialTerms: {
    verified: false,
    reason: "The approval and promotional emails did not state the signed-in commission schedule or attribution window."
  },
  tracking: {
    status: "unverified",
    requirement: "Generate an exact DealDesk Awin tracking link from Linking Methods and verify attribution, destination, current event availability, disclosures, and approved imagery."
  },
  publication: {
    allowed: false,
    reason: "Awin tax onboarding remains incomplete and no exact payable TicketNetwork link with verified commercial terms is recorded."
  },
  privacy: "No passwords, cookies, tax documents, banking details, or session tokens are stored in this evidence record."
});

await writeJson(paths.malwarebytesEvidence, {
  version: 1,
  reviewedAt: "2026-08-07T13:50:02.000Z",
  source: "Authenticated CJ advertiser approval email delivered to hello.launchdesk@gmail.com",
  publisher: {
    companyID: "8007406",
    memberRouteID: "7685648",
    trackingSiteID: "101847838"
  },
  advertiser: {
    name: "Malwarebytes",
    advertiserID: "3743656",
    relationship: "Active"
  },
  terms: {
    saleCommissionRate: 0.30,
    referralDays: 45,
    paymentTiming: "Within 30 days, as stated in the authenticated welcome email",
    seasonalPromotions: true,
    billingAndProductSupportHandledByAdvertiser: true,
    priceReference: "One-year subscription for one PC or Mac advertised at $44.99 in the welcome email"
  },
  tracking: {
    status: "unverified",
    requirement: "Generate an exact DealDesk CJ tracking link and verify its link ID, redirect destination, live customer offer, eligibility, disclosures, and genuine Malwarebytes creative."
  },
  publication: {
    allowed: false,
    reason: "The advertiser relationship and terms are verified, but the email did not include an exact payable DealDesk tracking link or a currently verified promotion."
  },
  privacy: "No passwords, cookies, payment data, tax data, or session tokens are stored in this evidence record."
});

console.log("DealDesk lifecycle rules and the TicketNetwork and Malwarebytes approvals are synchronized.");
