---
name: stocks
type: blank
blankKeywords: reddit stock, reddit, rddt, nvidia stock, nvidia, nvda, apple stock, apple, aapl, google stock, google, googl, microsoft stock, microsoft, msft, amazon stock, amazon, amzn, tesla stock, tesla, tsla, meta stock, meta
blankAutoPopulate: true
blankFormat: string
tip: Stock price
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
# Blank-as-context: when blank-context-mode is on, expose 5 popular
# tickers as ambient tokens ([STOCKS NVDA], [STOCKS AAPL], …) so
# fluid-blank + transform-blank can route casual prose ("how are
# my stocks doing _", "draft a market update _") through the
# catalog without typing each ticker. To track YOUR portfolio
# instead, replace `context-slots` with `context-bind: portfolio`
# + `context-bind-split: ,` + `split-values-in-token-names: ok`
# here and add `portfolio: NVDA,AAPL,…` to ~/.cues/IDENTITY.md.
as-context: safe
context-slots: NVDA, AAPL, TSLA, MSFT, GOOGL
# TYPED-SENTINEL Phase 4 — ai-callable ON-DEMAND fetch. When
# `sentinel-language: typed`, the catalog advertises `[STOCK(ticker: string):
# number]` and the runtime may call StocksBlank.get(<ticker>) with an
# LLM-provided ticker (e.g. `[STOCK(ticker=TSLA)]`) even when TSLA wasn't
# pre-fetched as an as-context slot. SAFE because: bounded codomain (a ticker
# → a price string), no exec/side-effect, no blankScript. The parser refuses
# ai-callable on any script blank.
signature: (ticker: string)
returns: number
ai-callable: true
---

Implementation: built-in `StocksBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/stocks.ts`). The keyword →
ticker map lives in the runtime class; requires `FINNHUB_API_KEY` in
env (native hosts) or in the chrome popup. Without a key, the
factory returns null and the blank is silently unregistered.
