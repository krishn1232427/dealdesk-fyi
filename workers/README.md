# DealDesk Affiliate Redirect Worker

`sovrn-out-worker.js` is the production `/out` handler for DealDesk Buy clicks.
It currently allows only the approved Amazon Associates tracking ID and blocks
all other networks until their advertiser approval is confirmed.

Approved Amazon request:

```text
https://dealdesk.fyi/out/?network=amazon-associates&url=<amazon-url-with-dealdesk-20-tag>&subid=dealdeskios
```

Behavior:

1. Validate that `url` is an `http` or `https` merchant URL.
2. Require `network=amazon-associates`, an Amazon hostname, and the exact
   `tag=dealdesk-20` query parameter.
3. Redirect approved links unchanged so Amazon attribution is preserved.
4. Return an error for Sovrn, Awin, CJ, Rakuten, Impact, or any merchant that
   does not yet have a confirmed DealDesk commission path.
