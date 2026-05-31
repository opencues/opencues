---
name: stocks
type: blank
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
# Auto: bare "nvda _" → wipe → "NVDA: $198.47" (ticker embedded).
# "nvda is _" or copula phrasings → keep → "nvda is NVDA: $198.47".
blankReplace: auto
---

Implementation: built-in `StocksBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/stocks.ts`). The keyword →
ticker map lives in the runtime class; requires `FINNHUB_API_KEY` in
env (native hosts) or in the chrome popup. Without a key, the
factory returns null and the blank is silently unregistered.
