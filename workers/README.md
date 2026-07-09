# DealDesk Affiliate Redirect Worker

`sovrn-out-worker.js` is the production `/out` handler for DealDesk Buy clicks. It
defaults to Sovrn and can generate Awin deep links when a DealDesk feed item
provides an Awin advertiser ID.

Expected Sovrn request:

```text
https://dealdesk.fyi/out/?url=<merchant-url>&subid=dealdeskios
```

Expected Awin request:

```text
https://dealdesk.fyi/out/?network=awin&awinmid=<advertiser-id>&url=<merchant-url>&subid=dealdeskios
```

Required environment value:

```text
SOVRN_API_KEY=<dealdesk.fyi Sovrn Commerce campaign API key>
```

Optional environment value:

```text
AWIN_PUBLISHER_ID=2973087
```

Behavior:

1. Validate that `url` is an `http` or `https` merchant URL.
2. For `network=awin`, require `awinmid` and wrap the merchant URL with Awin's
   deep-link format: `awin1.com/cread.php?awinmid=...&awinaffid=...&ued=...`.
3. Otherwise wrap it with Sovrn's manual redirect format:
   `redirect.viglink.com?key=...&u=...&cuid=...`.
4. Redirect to the affiliate network URL.
5. Fall back to the original merchant URL for Sovrn if the API key is unavailable.

The API key is used in Sovrn's public redirect format. Do not add a secret key to the iOS app, static HTML, or public JavaScript.
Awin publisher IDs are not secrets, but payouts still require program approval,
valid attribution, transaction validation, and completed tax/payment setup.
