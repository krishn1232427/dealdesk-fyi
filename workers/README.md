# DealDesk Affiliate Redirect Worker

`sovrn-out-worker.js` mirrors the `/out` safety checks for DealDesk Buy clicks
when a worker route is deployed. GitHub Pages deploys the static `out/index.html`;
worker deployment is managed separately.

Approved request shape:

```text
https://dealdesk.fyi/out/?network=<approved-network>&url=<exact-approved-affiliate-url>&subid=dealdeskios
```

Behavior:

1. Validate that `url` is an `http` or `https` merchant URL.
2. Require the exact approved tracking values for Amazon Associates, eBay
   Partner Network, CJ, Expedia Group, or Rakuten Advertising.
3. Preserve approved affiliate URLs; only the supported CJ `sid` placement
   value may be added.
4. Return an error for every network or destination without a confirmed
   DealDesk commission path.
