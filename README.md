# Stoa Swap Dashboard (community)

Public dashboard of swaps routed through [Stoa](https://stoadex.com) on Robinhood Chain: volume, traders, routes, referrers.
Built only from on-chain data. Unofficial: not made by or affiliated with Stoa.

Live page: _add your GitHub Pages link here_

## How it works

`indexer.js` (Node 18+, no dependencies) does all the querying:

1. `eth_getLogs` on the Stoa router `0x2f2804fad735a38015650f32f95ad5e08d6b3ee5` for its swap event
   (topic0 `0x2bbce256…f6da`), in 5M-block chunks because the public RPC rejects ranges above 10M blocks.
   One event is emitted per swap. Data words: tokenIn, tokenOut, amountIn, amountOut. Zero address = native ETH.
2. `eth_getTransactionReceipt` for each new swap to read the fee and referrer
   (`FeeNotified` from `0x76c30317bb8c0bc47e2ac5d83b329fe9f386f4e7`, topic0 `0xfc354255…860b`)
   and the pools touched (V3-style `Swap` and v4-style `Swap` events).
3. USD pricing: USDG leg = $1. Swaps with only an ETH/WETH leg use the median ETH/USDG price of the three
   nearest ETH↔USDG swaps in the dataset. Swaps with neither leg are counted but left out of volume.
4. Writes `docs/data.json` and `docs/data.js`. If any RPC call fails the script exits without writing,
   so an outage can never publish an undercount.

`docs/index.html` is a static page that reads `data.js` and does the aggregation in the browser
(volume per day, pairs, venues, traders, referrers), so every number can be checked against the code.

## Run it

    node indexer.js            # writes docs/data.json and docs/data.js
    npx serve docs             # or open docs/index.html directly

Environment variables: `RPC_URL`, `START_BLOCK` (default 114000000; the first Stoa swap is at 114,378,637).
Edit `VENUE_LABELS` in `indexer.js` to name pools, and `EXCLUDE_TRADERS` to leave wallets out of every number.

## Publish

1. Push to a public GitHub repo.
2. Settings → Pages → deploy from branch `main`, folder `/docs`.
3. `.github/workflows/update.yml` re-runs the indexer every 30 minutes and commits fresh data.
4. Set `REPO_URL` near the top of the script in `docs/index.html` so the footer links to the code.
