# DealDesk offer refresh

`recheckAfter` is a review deadline, not an expiration date. An overdue offer stays
browseable but is removed from search discovery until a new merchant check is
recorded. Never advance `verifiedAt` or `recheckAfter` without fresh source evidence.

## eBay batch refresh

1. Export a fresh EPN Sales + Events capture with `extractedAt`, the approved
   `trackingParameters`, and the complete `events` array. Save the sanitized
   export under `data/` so every refreshed promotion keeps an immutable evidence
   reference; never include cookies, passwords, or session tokens.
2. Capture the current public product grids:

   ```sh
   node scripts/capture-ebay-promotion-products.mjs <events.json> <fresh-products.json>
   ```

   The generated product JSON contains
   `capturedAt`, the same `trackingParameters`, `records`, and
   `capturedEventURLs`, including captured pages that returned zero valid cards.
3. Validate both captures without editing the feed:

   ```sh
   node scripts/import-ebay-events.mjs <fresh-events.json> --dry-run
   node scripts/import-ebay-products.mjs <fresh-products.json> <fresh-events.json> --dry-run
   ```

4. Review the report, then run the same commands without `--dry-run`. Product
   imports are incremental by default: observed exact item/variant URLs are
   refreshed, new ones are added, and unobserved records remain overdue. A full
   replacement requires `--replace`, a fresh event capture, and complete page
   coverage. Use `--allow-large-change` with `--replace` only after confirming
   that a large catalog change is real.

The deployment workflow refreshes eBay only when a manual run explicitly selects
`refresh_ebay`. Scheduled builds do not capture or commit a new snapshot. This
keeps immutable evidence growth reviewed and bounded. Manual refreshes use
`--existing-only`, so rotating eBay cards cannot expand the catalog without a
reviewed release. They refresh exact item and variant URLs already in DealDesk
and leave unobserved records overdue. Every successful run writes a new
timestamped evidence file; it never overwrites a snapshot referenced by an
earlier verification.

## Other networks

Amazon, CJ, and Rakuten offers require a live merchant-page check. CJ and Rakuten
records may also require authenticated network evidence. Preserve each new audit
record instead of overwriting prior evidence, and mark an offer unavailable when
its price, terms, tracking path, image, or availability cannot be confirmed.

## Release

Run the complete build and validation sequence from
`.github/workflows/deploy-pages.yml`. The generated search-index manifest will
automatically promote freshly verified offers and keep overdue records browseable
with `noindex,follow`.

Search discovery uses the `quality-diversity-v2` policy. It keeps all eligible
offers browseable, but submits at most 100 detail pages at once. An eBay item must
be observed in at least two immutable captures, including one at least 24 hours
after publication, and rank among the three strongest offers from its promotion
source. A six-hour
verification-window margin makes pages fail closed before their next scheduled
build. Merchant, category, comparison, and collection hubs need at least two
selected child offers to be indexable.

`scripts/prune-stale-deals.mjs` considers only offers whose hard `expiresAt` has
passed and is dry-run by default. Destructive pruning requires an explicit
`--apply`; a missed `recheckAfter` date is never a deletion signal.

DealDesk is an affiliate publisher, not the seller of record. Do not upload its
affiliate redirects to Google Merchant Center. Use normal Google Search, Product
snippet structured data, comparison pages, and DealDesk's XML sitemaps instead.
