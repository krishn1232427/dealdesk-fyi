const SOVRN_REDIRECT_ENDPOINT = "https://redirect.viglink.com/";

export default {
  async fetch(request, env) {
    const requestURL = new URL(request.url);
    const merchantURL = requestURL.searchParams.get("url");
    const subID = cleanSubID(requestURL.searchParams.get("subid"));

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

    if (!env.SOVRN_API_KEY) {
      return Response.redirect(destination.href, 302);
    }

    const sovrnURL = new URL(SOVRN_REDIRECT_ENDPOINT);
    sovrnURL.searchParams.set("key", env.SOVRN_API_KEY);
    sovrnURL.searchParams.set("u", destination.href);
    if (subID) {
      sovrnURL.searchParams.set("cuid", subID);
    }

    return Response.redirect(sovrnURL.href, 302);
  },
};

function cleanSubID(value) {
  if (!value) return "";
  return value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
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
