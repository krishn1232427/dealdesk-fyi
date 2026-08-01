import { readFile, writeFile } from "node:fs/promises";

const feedPaths = ["data/best-deals.json", "data/streaming-deals.json"];

for (const feedPath of feedPaths) {
  const url = new URL(`../${feedPath}`, import.meta.url);
  const feed = JSON.parse(await readFile(url, "utf8"));

  feed.deals = (feed.deals || []).map((deal) => {
    const verifiedAt = deal.verifiedAt || deal.publishedAt;
    const base = new Date(verifiedAt).getTime();
    const days = deal.network === "amazon-associates" && /^amazon-[a-z0-9]{10}-/i.test(deal.id)
      ? 3
      : 7;
    const recheckAfter = deal.recheckAfter || new Date(base + days * 86_400_000).toISOString();

    return {
      ...deal,
      status: deal.status || "active",
      publishedAt: deal.publishedAt || verifiedAt,
      verifiedAt,
      recheckAfter: deal.expiresAt ? deal.recheckAfter : recheckAfter
    };
  });

  await writeFile(url, `${JSON.stringify(feed, null, 2)}\n`);
}

console.log("Added lifecycle metadata to existing DealDesk listings.");
