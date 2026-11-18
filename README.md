# Token Radar

[![makefun](https://make.fun/badge/token-radar-01)](https://make.fun/bounty/token-radar-01)

A token launch radar: the pre-token protocols of a sealed DefiLlama snapshot, ranked by an implied
launch value.

The implied value is a comps model: a ridge regression of log market cap on the snapshot's own
TVL, seven-day growth, age and category, fitted once on the protocols whose token already trades
and validated leave-one-out. Watchlist protocols (no token on record, at least $50M TVL) are the
floor; the board also ranks pre-token protocols below it, where an early radar hunts. Each row
carries a concrete farm plan — steps with costs and times, netted against the implied value.

## How it runs

`main.ts` (Node 22, standard library only) reads the sealed snapshot at `/input/snapshot.json`,
scores every rankable pre-token protocol with `lib/model.ts`, and writes `/output/board.json`
(ranked rows), `/output/data.js` (the dashboard dataset), a copy of `dashboard/` and `screenshots/`,
and `/output/dossier.json`.

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json
```

`dashboard/index.html`, `app.css` and `app.js` render the board with no network — it runs from
`file://` too. `window.RADAR` in `data.js` is the whole dataset.

## License

MIT — see [LICENSE](LICENSE) (SPDX-License-Identifier: MIT).