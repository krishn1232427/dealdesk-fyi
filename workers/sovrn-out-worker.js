const APPROVED_AMAZON_TRACKING_ID = "dealdesk-20";
const APPROVED_EBAY_TRACKING = {
  mkcid: "1",
  mkrid: "711-53200-19255-0",
  siteid: "0",
  campid: "5339181076",
  toolid: "20014",
  customid: "",
  mkevt: "1",
};
const APPROVED_DESTINATIONS = {
  "https://www.kqzyfj.com/click-101847838-13756265": "cj",
  "https://www.tkqlhce.com/click-101847838-15438560": "cj",
  "https://www.kqzyfj.com/click-101847838-15642853": "cj",
  "https://www.tkqlhce.com/click-101847838-17217038": "cj",
  "https://www.kqzyfj.com/click-101847838-17297159": "cj",
  "https://www.tkqlhce.com/click-101847838-17171513": "cj",
};
const APPROVED_RAKUTEN_TRACKING = {
  id: "JyyDRUQnGvw",
  offerid: "2061576.5023433051046838324",
  type: "2",
  murl: "https://sensibo.com/products/sensibo-air-bundle?variant=33051046838324",
};
const APPROVAL_CATALOG_URL = "https://dealdesk.fyi/data/outbound-approvals.json";

export default {
  async fetch(request, env) {
    const requestURL = new URL(request.url);
    const merchantURL = requestURL.searchParams.get("url");
    const subID = cleanSubID(requestURL.searchParams.get("subid"));
    const network = cleanNetwork(requestURL.searchParams.get("network"));
    const requestedValidUntil = requestURL.searchParams.get("until");

    if (!merchantURL) {
      return htmlResponse("Missing merchant URL.", 400);
    }

    let approvalCatalog;
    try {
      const approvalResponse = await fetch(APPROVAL_CATALOG_URL, {
        headers: { accept: "application/json" },
        cf: { cacheEverything: true, cacheTtl: 300 },
      });
      if (!approvalResponse.ok) throw new Error("approval catalog unavailable");
      approvalCatalog = await approvalResponse.json();
    } catch {
      return htmlResponse("DealDesk could not verify this offer. Please return to Latest deals.", 503);
    }

    const approval = (approvalCatalog.deals || []).find((deal) =>
      deal.network === network &&
      deal.affiliateURL === merchantURL &&
      deal.validUntil === requestedValidUntil
    );
    const hasHardDeadline = Boolean(approval && approval.validUntil);
    const validUntil = hasHardDeadline ? Date.parse(approval.validUntil) : Infinity;
    if (!approval || (hasHardDeadline && (!Number.isFinite(validUntil) || Date.now() > validUntil))) {
      return htmlResponse("This offer is no longer within DealDesk's verified availability window.", 410);
    }

    let destination;
    try {
      destination = new URL(merchantURL);
    } catch {
      return htmlResponse("Invalid merchant URL.", 400);
    }

    if (destination.protocol !== "http:" && destination.protocol !== "https:") {
      return htmlResponse("Only web merchant URLs are allowed.", 400);
    }

    if (network === "amazon-associates") {
      const hostname = destination.hostname.toLowerCase();
      const isAmazon = hostname === "amazon.com" || hostname === "www.amazon.com";
      if (!isAmazon || destination.searchParams.get("tag") !== APPROVED_AMAZON_TRACKING_ID) {
        return htmlResponse("Amazon link is missing DealDesk commission tracking.", 400);
      }
      return Response.redirect(destination.href, 302);
    }

    if (network === "ebay-partner-network") {
      const isEbay = destination.hostname.toLowerCase() === "www.ebay.com";
      const hasApprovedTracking = isEbay && Object.entries(APPROVED_EBAY_TRACKING)
        .every(([key, value]) => destination.searchParams.get(key) === value);
      if (!hasApprovedTracking) {
        return htmlResponse("eBay link is missing DealDesk EPN campaign tracking.", 400);
      }
      return Response.redirect(destination.href, 302);
    }

    if (network === "rakuten-advertising") {
      const parameters = [...destination.searchParams.entries()];
      const isRakuten = destination.origin === "https://click.linksynergy.com" &&
        destination.pathname === "/link" && !destination.hash;
      const hasApprovedTracking = isRakuten &&
        parameters.length === Object.keys(APPROVED_RAKUTEN_TRACKING).length &&
        Object.entries(APPROVED_RAKUTEN_TRACKING)
          .every(([key, value]) => destination.searchParams.get(key) === value);
      if (!hasApprovedTracking) {
        return htmlResponse("Rakuten link is not the exact approved DealDesk product link.", 400);
      }
      return Response.redirect(destination.href, 302);
    }

    const canonical = destination.origin + destination.pathname;
    if (APPROVED_DESTINATIONS[canonical] === network) {
      if (network === "cj" && subID) destination.searchParams.set("sid", subID);
      return Response.redirect(destination.href, 302);
    }

    return htmlResponse("Merchant does not have an approved DealDesk commission path.", 403);
  },
};

function cleanSubID(value) {
  if (!value) return "";
  return value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}

function cleanNetwork(value) {
  const approved = new Set([
    "amazon-associates",
    "ebay-partner-network",
    "cj",
    "expedia-group-direct",
    "rakuten-advertising",
  ]);
  return approved.has(value) ? value : "unapproved";
}

function htmlResponse(message, status) {
  return new Response(`<!doctype html><title>DealDesk</title><p>${escapeHTML(message)}</p>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHTML(value) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}
