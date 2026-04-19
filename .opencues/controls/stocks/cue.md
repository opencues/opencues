---
name: stocks
type: control
control: stocks
blankKeywords: reddit stock, reddit, rddt, nvidia stock, nvidia, nvda, apple stock, apple, aapl, google stock, google, googl, microsoft stock, microsoft, msft, amazon stock, amazon, amzn, tesla stock, tesla, tsla, meta stock, meta
blankAutoPopulate: true
blankFormat: string
blankTip: Stock price
blankReadOnly: true
blankProximity: 1
blankKeywordExpansions.rddt: Reddit
blankKeywordExpansions.nvda: Nvidia
blankKeywordExpansions.aapl: Apple
blankKeywordExpansions.googl: Alphabet
blankKeywordExpansions.msft: Microsoft
blankKeywordExpansions.amzn: Amazon
blankKeywordExpansions.tsla: Tesla
---

Dispatched by the shared runtime `StocksControl`
(`packages/opencues-runtime/src/controls/stocks.ts`). The keyword → ticker
map lives in the runtime class; the legacy `tickers.json` and
`stock-blank.sh` were deleted on 2026-04-18 once chrome + opencode were
verified green on the runtime path.
