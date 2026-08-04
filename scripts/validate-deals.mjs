import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const feedPaths = ["data/best-deals.json", "data/streaming-deals.json"];
const affiliateRegistry = JSON.parse(await readFile(new URL("../data/affiliate-programs.json", import.meta.url), "utf8"));
const magzterEvidence = JSON.parse(await readFile(new URL("../data/affiliate-evidence/magzter-cj-20260803.json", import.meta.url), "utf8"));
const protonEvidence = JSON.parse(await readFile(new URL("../data/affiliate-evidence/proton-cj-20260804.json", import.meta.url), "utf8"));
const sensiboEvidence = JSON.parse(await readFile(new URL("../data/affiliate-evidence/sensibo-rakuten-20260803.json", import.meta.url), "utf8"));
const sensiboExclusionSnapshot = await readFile(new URL("../data/affiliate-evidence/sensibo-rakuten-20260803-exclusions.csv", import.meta.url), "utf8");
const sensiboExclusionSnapshotHash = createHash("sha256").update(sensiboExclusionSnapshot).digest("hex");
const sensiboExclusionSnapshotSKUs = sensiboExclusionSnapshot.trim().split(/\r?\n/)
  .map((row) => row.split("\t", 1)[0]);
const cjPrograms = new Map((affiliateRegistry.programs || [])
  .filter((program) => program.network === "cj")
  .map((program) => [String(program.advertiserID), program]));
const expediaPrograms = new Map((affiliateRegistry.programs || [])
  .filter((program) => program.network === "expedia-group-direct")
  .map((program) => [String(program.trackingID), program]));
const rakutenPrograms = new Map((affiliateRegistry.programs || [])
  .filter((program) => program.network === "rakuten-advertising")
  .map((program) => [String(program.advertiserID), program]));
const ebayProgram = (affiliateRegistry.programs || [])
  .find((program) => program.id === "ebay-partner-network-default");
const commissionAccrualReadyByNetwork = new Map((affiliateRegistry.publisherAccounts || [])
  .map((account) => [account.network, account.commissionAccrualReady]));
const hasCommissionPath = (deal) => commissionAccrualReadyByNetwork.get(deal.network) === true;
const seenIDs = new Set();
const seenNetworks = new Set();
const seenDeals = [];
const errors = [];
const staleDeals = [];
const now = Date.now();
const validDate = (value) => value && Number.isFinite(new Date(value).getTime());
const usdNumber = (value) => Number(String(value || "").replace(/[$,]/g, ""));
const slugFor = (deal) => String(deal.id || "deal").replace(/-\d{8}$/, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const validUntilFor = (deal) => {
  const deadlines = [deal.expiresAt, deal.recheckAfter]
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  return deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : "";
};
const hasGenuineMerchantImage = (deal) => {
  try {
    const image = new URL(String(deal?.imageURL || ""));
    if (image.protocol !== "https:") return false;
    if (deal.network === "ebay-partner-network" && deal.sourceType === "ebay-product") {
      return image.hostname === "i.ebayimg.com";
    }
    return true;
  } catch {
    return false;
  }
};
const isPublicDeal = (deal) => {
  const expiresAt = validDate(deal.expiresAt) ? new Date(deal.expiresAt).getTime() : Infinity;
  const recheckAfter = validDate(deal.recheckAfter) ? new Date(deal.recheckAfter).getTime() : Infinity;
  return deal.status === "active" && deal.commissionEligible === true &&
    deal.approvalStatus === "approved" && hasCommissionPath(deal) &&
    Boolean(deal.affiliateURL) && Boolean(deal.verifiedAt) &&
    now <= expiresAt && now <= recheckAfter && hasGenuineMerchantImage(deal);
};

for (const feedPath of feedPaths) {
  const feed = JSON.parse(await readFile(new URL(`../${feedPath}`, import.meta.url), "utf8"));

  if (!Array.isArray(feed.deals) || feed.deals.length === 0) {
    errors.push(`${feedPath}: feed must contain at least one deal`);
    continue;
  }

  for (const deal of feed.deals) {
    const label = `${feedPath}:${deal.id || "missing-id"}`;
    seenDeals.push(deal);
    if (deal.network) seenNetworks.add(deal.network);

    if (!deal.id || seenIDs.has(deal.id)) errors.push(`${label}: missing or duplicate id`);
    if (deal.id) seenIDs.add(deal.id);
    if (deal.commissionEligible !== true) errors.push(`${label}: commissionEligible must be true`);
    if (deal.approvalStatus !== "approved") errors.push(`${label}: approvalStatus must be approved`);
    if (!["active", "unavailable", "superseded"].includes(deal.status)) {
      errors.push(`${label}: status must be active, unavailable, or superseded`);
    }
    if (deal.status === "unavailable" && !validDate(deal.unavailableAt)) {
      errors.push(`${label}: unavailableAt is required for unavailable deals`);
    }
    if (deal.status === "superseded" && !deal.supersededBy) {
      errors.push(`${label}: supersededBy is required for superseded deals`);
    }
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
    const expiresAt = validDate(deal.expiresAt) ? new Date(deal.expiresAt).getTime() : Infinity;
    const recheckAfter = validDate(deal.recheckAfter) ? new Date(deal.recheckAfter).getTime() : Infinity;
    if (expiresAt <= now || recheckAfter <= now) staleDeals.push({ deal, label });

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
      if (String(deal.advertiserID) === "5305397") {
        const expectedEvidenceRecord = "data/affiliate-evidence/magzter-cj-20260803.json";
        let merchantURL;
        let imageURL;
        try { merchantURL = new URL(deal.merchantURL); } catch {}
        try { imageURL = new URL(deal.imageURL); } catch {}

        if (program?.evidenceRecord !== expectedEvidenceRecord || deal.evidenceRecord !== expectedEvidenceRecord) {
          errors.push(`${label}: Magzter program and deal must reference the authenticated evidence record`);
        }
        if (magzterEvidence?.advertiser?.relationship !== "Active" ||
            String(magzterEvidence?.advertiser?.advertiserID) !== String(deal.advertiserID) ||
            String(magzterEvidence?.publisher?.cjSiteID) !== String(deal.trackingID) ||
            String(magzterEvidence?.promotion?.linkID) !== String(deal.linkID) ||
            magzterEvidence?.promotion?.trackingURL !== deal.affiliateURL ||
            magzterEvidence?.promotion?.destinationURL !== deal.merchantURL ||
            magzterEvidence?.merchantOffer?.imageURL !== deal.imageURL ||
            magzterEvidence?.reviewedAt !== deal.verifiedAt) {
          errors.push(`${label}: Magzter deal does not match its authenticated evidence record`);
        }
        if (merchantURL?.hostname !== "www.magzter.com" ||
            merchantURL.pathname !== "/magztergold/1year-subscription-offer") {
          errors.push(`${label}: Magzter must use the verified annual GOLD offer page`);
        }
        if (imageURL?.hostname !== "cdn.magzter.com" || imageURL.pathname !== "/home/banner/web.webp") {
          errors.push(`${label}: Magzter must use the verified genuine merchant hero image`);
        }
        if (deal.sourceType !== "cj-text-link" || deal.offerType !== "subscription") {
          errors.push(`${label}: Magzter must be a verified CJ subscription link`);
        }
        if (usdNumber(deal.currentPrice) !== magzterEvidence?.merchantOffer?.priceUSD ||
            usdNumber(deal.originalPrice) !== magzterEvidence?.merchantOffer?.compareAtPriceUSD ||
            Number(deal.discountPercent) !== 50 ||
            Number(deal.estimatedCommission) !== magzterEvidence?.commission?.conservativeEstimatedCommissionUSD) {
          errors.push(`${label}: Magzter price, discount, or conservative commission estimate does not match evidence`);
        }
        const expectedGoldCommission = Math.floor(
          Number(magzterEvidence?.merchantOffer?.priceUSD) *
          Number(magzterEvidence?.commission?.goldSubscriptionRate) * 100
        ) / 100;
        if (magzterEvidence?.commission?.goldSubscriptionRate !== 0.5 ||
            magzterEvidence?.commission?.goldTrialRenewalUSD !== 5 ||
            magzterEvidence?.commission?.individualPublicationRate !== 0.3 ||
            magzterEvidence?.commission?.cookieDays !== 30 ||
            magzterEvidence?.commission?.conservativeRate !== 0.5 ||
            magzterEvidence?.commission?.conservativeEstimatedCommissionUSD !== expectedGoldCommission ||
            deal.commission !== "50% of qualifying Magzter GOLD sale" ||
            program?.commissionSchedule?.goldSubscriptionRate !== 0.5 ||
            program?.commissionSchedule?.goldTrialRenewalUSD !== 5 ||
            program?.commissionSchedule?.individualPublicationRate !== 0.3 ||
            program?.commissionSchedule?.cookieDays !== 30) {
          errors.push(`${label}: Magzter commission schedule must match the authenticated GOLD-specific CJ terms`);
        }
        if (deal.expiresAt !== magzterEvidence?.promotion?.endsAt || program?.offerExpiresAt !== deal.expiresAt) {
          errors.push(`${label}: Magzter promotion deadline does not match the verified CJ schedule`);
        }
        const verifiedAt = new Date(deal.verifiedAt).getTime();
        const recheckAfter = new Date(deal.recheckAfter).getTime();
        if (!Number.isFinite(verifiedAt) || !Number.isFinite(recheckAfter) ||
            recheckAfter <= verifiedAt || recheckAfter - verifiedAt > 24 * 60 * 60 * 1000 + 1000) {
          errors.push(`${label}: Magzter verification window must be no more than 24 hours`);
        }
      }
      if (String(deal.advertiserID) === "5227916") {
        const expectedEvidenceRecord = "data/affiliate-evidence/proton-cj-20260804.json";
        let merchantURL;
        let imageURL;
        let checkoutURL;
        let redirectDestinationURL;
        try { merchantURL = new URL(deal.merchantURL); } catch {}
        try { imageURL = new URL(deal.imageURL); } catch {}
        try { checkoutURL = new URL(protonEvidence?.promotion?.checkoutURL); } catch {}
        try { redirectDestinationURL = new URL(protonEvidence?.promotion?.redirectDestinationURL); } catch {}

        if (program?.evidenceRecord !== expectedEvidenceRecord || deal.evidenceRecord !== expectedEvidenceRecord) {
          errors.push(`${label}: Proton program and deal must reference the authenticated evidence record`);
        }
        if (protonEvidence?.advertiser?.relationship !== "Active" ||
            String(protonEvidence?.advertiser?.advertiserID) !== String(deal.advertiserID) ||
            String(protonEvidence?.publisher?.cjSiteID) !== String(deal.trackingID) ||
            String(protonEvidence?.promotion?.linkID) !== String(deal.linkID) ||
            protonEvidence?.promotion?.trackingURL !== deal.affiliateURL ||
            protonEvidence?.merchantOffer?.landingURL !== deal.merchantURL ||
            protonEvidence?.merchantOffer?.imageURL !== deal.imageURL ||
            protonEvidence?.reviewedAt !== deal.verifiedAt ||
            program?.offerVerifiedAt !== deal.verifiedAt) {
          errors.push(`${label}: Proton deal does not match its authenticated evidence record`);
        }
        if (merchantURL?.origin !== "https://protonvpn.com" ||
            merchantURL.pathname !== "/l/special-partner-offer" || merchantURL.search || merchantURL.hash) {
          errors.push(`${label}: Proton must use the verified partner-offer landing page`);
        }
        if (redirectDestinationURL?.origin !== "https://protonvpn.com" ||
            redirectDestinationURL.pathname !== "/l/special-partner-offer" ||
            redirectDestinationURL.searchParams.get("utm_source") !== "aid-cj-8007406") {
          errors.push(`${label}: Proton CJ redirect destination is not the verified DealDesk partner landing`);
        }
        if (checkoutURL?.origin !== "https://account.protonvpn.com" || checkoutURL.pathname !== "/signup" ||
            checkoutURL.searchParams.get("plan") !== "vpn2024" ||
            checkoutURL.searchParams.get("billing") !== "24" ||
            checkoutURL.searchParams.get("currency") !== "USD" ||
            checkoutURL.searchParams.get("coupon") !== "VPNINTROPRICE2025") {
          errors.push(`${label}: Proton evidence must use the verified two-year USD checkout`);
        }
        if (imageURL?.hostname !== "vpncdn.protonweb.com" || imageURL.pathname !== "/image-transformation/" ||
            imageURL.searchParams.get("image") !== "proton_vpn_one_vpn_limitless_possibilities_1fbfebb9d7.png" ||
            imageURL.searchParams.get("width") !== "1280" || imageURL.searchParams.get("height") !== "586") {
          errors.push(`${label}: Proton must use the verified genuine merchant product-interface image`);
        }
        if (deal.sourceType !== "cj-text-link" || deal.offerType !== "subscription") {
          errors.push(`${label}: Proton must be a verified CJ subscription link`);
        }
        if (usdNumber(deal.currentPrice) !== protonEvidence?.merchantOffer?.priceUSD ||
            usdNumber(deal.originalPrice) !== protonEvidence?.merchantOffer?.compareAtTotalUSD ||
            Number(deal.discountPercent) !== protonEvidence?.merchantOffer?.discountPercent ||
            Number(deal.estimatedCommission) !== protonEvidence?.commission?.conservativeEstimatedInitialCommissionUSD ||
            deal.referenceStyle !== "comparison" || deal.referenceLabel !== "24-month monthly-price equivalent" ||
            !String(deal.priceNote || "").includes("$83.88/year")) {
          errors.push(`${label}: Proton price, renewal disclosure, discount, or conservative commission estimate does not match evidence`);
        }
        if (deal.expiresAt) {
          errors.push(`${label}: Proton must not invent an offer expiration that was not supplied`);
        }
        const verifiedAt = new Date(deal.verifiedAt).getTime();
        const recheckAfter = new Date(deal.recheckAfter).getTime();
        if (!Number.isFinite(verifiedAt) || !Number.isFinite(recheckAfter) ||
            recheckAfter <= verifiedAt || recheckAfter - verifiedAt > 24 * 60 * 60 * 1000 + 1000) {
          errors.push(`${label}: Proton verification window must be no more than 24 hours`);
        }
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
    } else if (deal.network === "rakuten-advertising") {
      const program = rakutenPrograms.get(String(deal.advertiserID || ""));
      const expectedEvidenceRecord = "data/affiliate-evidence/sensibo-rakuten-20260803.json";
      const expectedOfferID = `${deal.offerID}.${deal.linkID}`;
      const expectedParamNames = new Set(["id", "offerid", "type", "murl"]);
      const affiliateParams = [...affiliateURL.searchParams.entries()];

      if (affiliateURL.origin !== "https://click.linksynergy.com" || affiliateURL.pathname !== "/link" || affiliateURL.hash) {
        errors.push(`${label}: Rakuten link must use the approved click.linksynergy.com path`);
      }
      if (affiliateParams.length !== 4 || affiliateParams.some(([name]) => !expectedParamNames.has(name))) {
        errors.push(`${label}: Rakuten link contains missing, duplicate, or unapproved parameters`);
      }
      if (affiliateURL.searchParams.get("id") !== deal.trackingID) {
        errors.push(`${label}: Rakuten publisher token must match trackingID`);
      }
      if (!deal.offerID || !deal.linkID || affiliateURL.searchParams.get("offerid") !== expectedOfferID) {
        errors.push(`${label}: Rakuten offerid must match offerID and linkID`);
      }
      if (affiliateURL.searchParams.get("type") !== "2") {
        errors.push(`${label}: Rakuten product link type must be 2`);
      }
      if (affiliateURL.searchParams.get("murl") !== deal.merchantURL) {
        errors.push(`${label}: Rakuten merchant destination must match merchantURL exactly`);
      }
      if (!program) {
        errors.push(`${label}: Rakuten advertiser is missing from affiliate-programs.json`);
      } else {
        if (program.applicationStatus !== "active") errors.push(`${label}: Rakuten advertiser relationship is not active`);
        if (program.trackingLinkStatus !== "verified") errors.push(`${label}: Rakuten tracking link is not verified`);
        if (program.commissionEligible !== true) errors.push(`${label}: Rakuten program is not commission eligible`);
        if (program.publicPublishingAllowed !== true) errors.push(`${label}: Rakuten program is not approved for public publishing`);
        if (program.trackingURL !== deal.affiliateURL) errors.push(`${label}: Rakuten URL does not match the verified program URL`);
        if (String(program.trackingID) !== String(deal.trackingID)) errors.push(`${label}: Rakuten trackingID does not match the verified program`);
        if (String(program.offerID) !== String(deal.offerID)) errors.push(`${label}: Rakuten offerID does not match the verified program`);
        if (String(program.linkID) !== String(deal.linkID)) errors.push(`${label}: Rakuten linkID does not match the verified program`);
        if (String(program.productSKU) !== String(deal.productSKU)) errors.push(`${label}: Rakuten product SKU does not match the verified program`);
        if (String(program.rakutenCatalogSKU) !== String(deal.catalogVariantID)) errors.push(`${label}: Rakuten catalog variant does not match the verified program`);
        if (program.evidenceRecord !== expectedEvidenceRecord || deal.evidenceRecord !== expectedEvidenceRecord) errors.push(`${label}: Rakuten program and deal must reference the authenticated evidence record`);
      }

      const excludedSKUs = sensiboEvidence?.exclusionFile?.excludedMerchantSKUs || [];
      if (sensiboEvidence?.advertiser?.relationship !== "Partnered" ||
          String(sensiboEvidence?.advertiser?.mid) !== String(deal.advertiserID) ||
          String(sensiboEvidence?.offer?.groupOfferID) !== String(deal.offerID) ||
          String(sensiboEvidence?.offer?.exclusionListID) !== String(deal.skuExclusionListID) ||
          String(sensiboEvidence?.productLink?.linkID) !== String(deal.linkID) ||
          String(sensiboEvidence?.productLink?.catalogVariantID) !== String(deal.catalogVariantID) ||
          sensiboEvidence?.productLink?.trackingURL !== deal.affiliateURL ||
          sensiboEvidence?.merchantProduct?.merchantSKU !== deal.productSKU ||
          sensiboEvidence?.merchantProduct?.merchantURL !== deal.merchantURL ||
          sensiboEvidence?.merchantProduct?.imageURL !== deal.imageURL ||
          sensiboEvidence?.merchantProduct?.availability !== deal.availabilityStatus ||
          sensiboEvidence?.reviewedAt !== deal.verifiedAt) {
        errors.push(`${label}: Sensibo deal does not match its authenticated evidence record`);
      }
      if (sensiboEvidence?.exclusionFile?.rowCount !== excludedSKUs.length || excludedSKUs.includes(deal.productSKU)) {
        errors.push(`${label}: Sensibo merchant SKU is missing from or excluded by the reviewed offer-rule evidence`);
      }
      if (sensiboEvidence?.exclusionFile?.sanitizedSnapshotSha256 !== sensiboExclusionSnapshotHash ||
          JSON.stringify(excludedSKUs) !== JSON.stringify(sensiboExclusionSnapshotSKUs)) {
        errors.push(`${label}: Sensibo exclusion snapshot does not match its evidence manifest`);
      }

      let merchantURL;
      let imageURL;
      try { merchantURL = new URL(deal.merchantURL); } catch {}
      try { imageURL = new URL(deal.imageURL); } catch {}
      if (deal.sourceType !== "rakuten-product") errors.push(`${label}: Rakuten deal must be a verified product link`);
      if (merchantURL?.hostname !== "sensibo.com" || merchantURL.pathname !== "/products/sensibo-air-bundle") {
        errors.push(`${label}: Sensibo product must use the verified merchant product page`);
      }
      if (imageURL?.hostname !== "cdn.shopify.com" || !imageURL.pathname.includes("/files/Bundle_")) {
        errors.push(`${label}: Sensibo product must use the verified genuine Shopify product image`);
      }
      if (deal.productSKU !== "SEN-AIR-SET-01" || deal.skuEligibilityStatus !== "verified_not_excluded" || deal.skuExclusionListID !== "2061577") {
        errors.push(`${label}: Sensibo SKU must be verified against the active offer exclusion list`);
      }
      if (deal.availabilityStatus !== "InStock") errors.push(`${label}: Sensibo product must be verified in stock`);
      if (!/^\$[\d,]+(?:\.\d{2})?$/.test(String(deal.currentPrice || "")) ||
          !/^\$[\d,]+(?:\.\d{2})?$/.test(String(deal.originalPrice || ""))) {
        errors.push(`${label}: Sensibo product must have exact current and compare-at USD prices`);
      }
      if (usdNumber(deal.currentPrice) !== sensiboEvidence?.merchantProduct?.priceUSD ||
          usdNumber(deal.originalPrice) !== sensiboEvidence?.merchantProduct?.compareAtPriceUSD) {
        errors.push(`${label}: Sensibo prices do not match the authenticated merchant evidence`);
      }
      const verifiedAt = new Date(deal.verifiedAt).getTime();
      const recheckAfter = new Date(deal.recheckAfter).getTime();
      if (!Number.isFinite(verifiedAt) || !Number.isFinite(recheckAfter) ||
          recheckAfter <= verifiedAt || recheckAfter - verifiedAt > 24 * 60 * 60 * 1000 + 1000) {
        errors.push(`${label}: Sensibo verification window must be no more than 24 hours`);
      }
    } else if (deal.network === "ebay-partner-network") {
      const hasTrackingSignal = affiliateURL.searchParams.has("campid") &&
        affiliateURL.searchParams.has("mkcid");

      if (affiliateURL.hostname !== "www.ebay.com" || !hasTrackingSignal) {
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
      if (deal.sourceType === "ebay-product") {
        let merchantURL;
        let imageURL;
        try { merchantURL = new URL(deal.merchantURL); } catch {}
        try { imageURL = new URL(deal.imageURL); } catch {}
        if (merchantURL?.hostname !== "www.ebay.com" || !/^\/itm\/\d+/.test(merchantURL.pathname)) {
          errors.push(`${label}: eBay product must have a canonical item URL`);
        }
        if (imageURL?.hostname !== "i.ebayimg.com" ||
            !imageURL.pathname.startsWith("/images/g/") ||
            !imageURL.pathname.endsWith("/s-l640.webp")) {
          errors.push(`${label}: eBay product must have a genuine 640px item image`);
        }
        if (!/^\$[\d,]+(?:\.\d{2})?$/.test(String(deal.currentPrice || ""))) {
          errors.push(`${label}: eBay product must have an exact USD price`);
        }
        if (deal.listingFormat !== "FixedPrice") {
          errors.push(`${label}: eBay product must be a verified fixed-price listing`);
        }
        if (deal.availabilityStatus !== "InStock") {
          errors.push(`${label}: eBay product must be verified in stock`);
        }
        if (!String(deal.verificationSource || "").includes("eBay promotion-page product cards")) {
          errors.push(`${label}: eBay product must include verification provenance`);
        }
        const verifiedAt = new Date(deal.verifiedAt).getTime();
        const recheckAfter = new Date(deal.recheckAfter).getTime();
        if (!Number.isFinite(verifiedAt) || !Number.isFinite(recheckAfter) ||
            recheckAfter <= verifiedAt || recheckAfter - verifiedAt > 24 * 60 * 60 * 1000 + 1000) {
          errors.push(`${label}: eBay product verification window must be no more than 24 hours`);
        }
      }
      for (const [key, value] of Object.entries(ebayProgram?.trackingParameters || {})) {
        if (affiliateURL.searchParams.get(key) !== value) {
          errors.push(`${label}: eBay ${key} does not match the approved EPN tracking value`);
        }
      }
    } else {
      errors.push(`${label}: network is not approved for the public DealDesk feed`);
    }
  }
}

if (seenNetworks.has("ebay-partner-network")) {
  const outboundPage = await readFile(new URL("../out/index.html", import.meta.url), "utf8");
  if (!outboundPage.includes('affiliateNetwork === "ebay-partner-network"')) {
    errors.push("out/index.html: eBay Partner Network links are not enabled in the outbound safety gate");
  }
  for (const value of Object.values(ebayProgram?.trackingParameters || {})) {
    if (!outboundPage.includes(JSON.stringify(value))) {
      errors.push(`out/index.html: approved eBay tracking value ${value} is missing`);
    }
  }
}

if (seenNetworks.has("cj")) {
  const outboundPage = await readFile(new URL("../out/index.html", import.meta.url), "utf8");
  const workerSource = await readFile(new URL("../workers/sovrn-out-worker.js", import.meta.url), "utf8");
  const currentCJDeals = seenDeals.filter((deal) => deal.network === "cj" && isPublicDeal(deal));
  for (const source of [outboundPage, workerSource]) {
    for (const deal of currentCJDeals) {
      if (!source.includes(JSON.stringify(deal.affiliateURL))) {
        errors.push(`Outbound safety gate is missing verified CJ URL ${deal.affiliateURL}`);
      }
    }
  }
}

if (seenNetworks.has("rakuten-advertising")) {
  const outboundPage = await readFile(new URL("../out/index.html", import.meta.url), "utf8");
  const workerSource = await readFile(new URL("../workers/sovrn-out-worker.js", import.meta.url), "utf8");
  const sensiboProgram = rakutenPrograms.get("50234");
  for (const source of [outboundPage, workerSource]) {
    if (!source.includes('rakuten-advertising')) {
      errors.push("Rakuten Advertising links are not enabled in every outbound safety gate");
    }
    for (const value of [sensiboProgram?.trackingID, sensiboProgram?.offerID, sensiboProgram?.linkID, sensiboProgram?.merchantProductURL]) {
      if (value && !source.includes(String(value))) {
        errors.push(`Outbound safety gate is missing verified Rakuten value ${value}`);
      }
    }
  }
}

const outboundApprovals = JSON.parse(await readFile(new URL("../data/outbound-approvals.json", import.meta.url), "utf8"));
const approvalByID = new Map();
for (const approval of outboundApprovals.deals || []) {
  if (!approval.id || approvalByID.has(approval.id)) {
    errors.push(`data/outbound-approvals.json: missing or duplicate approval id ${approval.id || "unknown"}`);
    continue;
  }
  approvalByID.set(approval.id, approval);
}

const publicDeals = seenDeals.filter(isPublicDeal);
const publicDealIDs = new Set(publicDeals.map((deal) => deal.id));
for (const deal of publicDeals) {
  const approval = approvalByID.get(deal.id);
  if (!approval) {
    errors.push(`data/outbound-approvals.json:${deal.id}: current public deal is missing`);
    continue;
  }
  if (approval.network !== deal.network || approval.affiliateURL !== deal.affiliateURL ||
      approval.validUntil !== validUntilFor(deal)) {
    errors.push(`data/outbound-approvals.json:${deal.id}: approval does not exactly match the verified deal and deadline`);
  }
  let detailPage = "";
  try {
    detailPage = await readFile(new URL(`../deals/${slugFor(deal)}/index.html`, import.meta.url), "utf8");
  } catch {
    errors.push(`deals/${slugFor(deal)}: current public deal detail page is missing`);
    continue;
  }
  if (!detailPage.includes(`Date.parse(${JSON.stringify(validUntilFor(deal))})`)) {
    errors.push(`deals/${slugFor(deal)}: detail page is missing its exact runtime verification deadline`);
  }
  const ctaMatch = detailPage.match(/class="deal-detail-cta" href="([^"]+)"/);
  let ctaURL;
  try {
    ctaURL = new URL(String(ctaMatch?.[1] || "").replaceAll("&amp;", "&"), "https://dealdesk.fyi");
  } catch {}
  if (ctaURL?.pathname !== "/out/" || ctaURL.searchParams.get("network") !== deal.network ||
      ctaURL.searchParams.get("url") !== deal.affiliateURL ||
      ctaURL.searchParams.get("until") !== validUntilFor(deal)) {
    errors.push(`deals/${slugFor(deal)}: detail CTA must carry the exact approved URL and verification deadline`);
  }
}
for (const approval of approvalByID.values()) {
  if (!publicDealIDs.has(approval.id)) {
    errors.push(`data/outbound-approvals.json:${approval.id}: nonpublic deal must not have an outbound approval`);
  }
}

const lifecycleOutboundPage = await readFile(new URL("../out/index.html", import.meta.url), "utf8");
const lifecycleWorkerSource = await readFile(new URL("../workers/sovrn-out-worker.js", import.meta.url), "utf8");
const homepageSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
if (!homepageSource.includes('/data/affiliate-programs.json') ||
    !homepageSource.includes('commissionAccrualReadyByNetwork[deal.network] === true')) {
  errors.push("index.html: homepage listings must fail closed against verified network commission-accrual readiness");
}
if (!lifecycleOutboundPage.includes("/data/outbound-approvals.json") ||
    !lifecycleOutboundPage.includes("deal.validUntil === requestedValidUntil") ||
    !lifecycleOutboundPage.includes("Date.now() > validUntil")) {
  errors.push("out/index.html: outbound links must fail closed against the generated approval catalog and deadline");
}
if (!lifecycleWorkerSource.includes("https://dealdesk.fyi/data/outbound-approvals.json") ||
    !lifecycleWorkerSource.includes("deal.affiliateURL === merchantURL") ||
    !lifecycleWorkerSource.includes("deal.validUntil === requestedValidUntil") ||
    !lifecycleWorkerSource.includes("Date.now() > validUntil")) {
  errors.push("workers/sovrn-out-worker.js: outbound links must fail closed against the generated approval catalog and deadline");
}

if (staleDeals.length) {
  const latestDeals = JSON.parse(await readFile(new URL("../data/latest-deals.json", import.meta.url), "utf8"));
  const latestDealIDs = new Set((latestDeals.deals || []).map((deal) => deal.id));
  const sitemap = await readFile(new URL("../sitemap.xml", import.meta.url), "utf8");

  for (const { deal, label } of staleDeals) {
    const slug = slugFor(deal);
    let detailPage = "";
    try {
      detailPage = await readFile(new URL(`../deals/${slug}/index.html`, import.meta.url), "utf8");
    } catch {
      errors.push(`${label}: stale deal must have a retired detail page`);
      continue;
    }
    if (!detailPage.includes('content="noindex,nofollow"')) {
      errors.push(`${label}: stale detail page must be noindex,nofollow`);
    }
    if (detailPage.includes(deal.affiliateURL) || detailPage.includes("View live deal")) {
      errors.push(`${label}: stale detail page must not expose a live affiliate CTA`);
    }
    if (latestDealIDs.has(deal.id)) {
      errors.push(`${label}: stale deal must not appear in latest-deals.json`);
    }
    if (sitemap.includes(`/deals/${slug}/`)) {
      errors.push(`${label}: stale deal must not appear in sitemap.xml`);
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

if (staleDeals.length) console.log(`Withheld ${staleDeals.length} expired or due-for-recheck deals from public output.`);
console.log(`Validated ${seenIDs.size} affiliate deal records; ${publicDeals.length} are currently commission-qualified and public.`);
