---
name: stocks
type: blank
# Every keyword the TypeScript blank accepts. Listed here so the
# runtime BlankFill scanner sees them all as candidate triggers
# before the shape gate runs. The shape pattern below filters
# them to "actually a stock invocation" (prose declines).
blankKeywords: reddit stock, reddit, rddt, nvidia stock, nvidia, nvda, apple stock, apple, aapl, google stock, google, googl, microsoft stock, microsoft, msft, amazon stock, amazon, amzn, tesla stock, tesla, tsla, meta stock, meta
# blankShapes: declarative precision gate (June 2026). Each keyword
# alternation explicitly listed — the alternation IS the precision.
# Bare prose like "she nvda her presentation _" or "they apple-pick
# in autumn _" doesn't match (the keyword must be the leading word
# in the input). The companies + tickers are deliberately the same
# set as blankKeywords above.
blankShapes: [{"pattern":"^(reddit\\s+stock|reddit|rddt|nvidia\\s+stock|nvidia|nvda|apple\\s+stock|apple|aapl|google\\s+stock|google|googl|microsoft\\s+stock|microsoft|msft|amazon\\s+stock|amazon|amzn|tesla\\s+stock|tesla|tsla|meta\\s+stock|meta)\\s*_$","action":"get","valueGroup":1}]
blankAutoPopulate: true
blankFormat: string
blankTip: Stock price
blankReadOnly: true
# No blankSatellite: stocks has no cycle vocab. One uniform gray span
# emission — see shape-driven-blanks.md.
blankClearOnEdit: true
blankConsumeContext: true
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
---

Implementation: built-in `StocksBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/stocks.ts`). The keyword →
ticker map lives in the runtime class; requires `FINNHUB_API_KEY` in
env (native hosts) or in the chrome popup. Without a key, the
factory returns null and the blank is silently unregistered.
