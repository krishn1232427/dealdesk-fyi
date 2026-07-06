# DealDesk Affiliate Redirect Worker

`sovrn-out-worker.js` is the production `/out` handler for DealDesk Buy clicks.

Expected request:

```text
https://dealdesk.fyi/out/?url=<merchant-url>&subid=dealdeskios
```

Required environment value:

```text
SOVRN_API_KEY=<dealdesk.fyi Sovrn Commerce campaign API key>
```

Behavior:

1. Validate that `url` is an `http` or `https` merchant URL.
2. Wrap it with Sovrn's manual redirect format: `redirect.viglink.com?key=...&u=...&cuid=...`.
3. Redirect to the Sovrn affiliate redirect.
4. Fall back to the original merchant URL if the API key is unavailable.

The API key is used in Sovrn's public redirect format. Do not add a secret key to the iOS app, static HTML, or public JavaScript.
