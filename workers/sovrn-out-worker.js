const APPROVED_AMAZON_TRACKING_ID = "dealdesk-20";

export default {
  async fetch(request, env) {
    const requestURL = new URL(request.url);
    const merchantURL = requestURL.searchParams.get("url");
    const subID = cleanSubID(requestURL.searchParams.get("subid"));
    const network = cleanNetwork(requestURL.searchParams.get("network"));

    if (!merchantURL) {
      return htmlResponse("Missing merchant URL.", 400);
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

    return htmlResponse("Merchant does not have an approved DealDesk commission path.", 403);
  },
};

function cleanSubID(value) {
  if (!value) return "";
  return value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}

function cleanNetwork(value) {
  return value === "amazon-associates" ? value : "unapproved";
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
