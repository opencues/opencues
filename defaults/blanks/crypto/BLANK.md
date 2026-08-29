---
name: crypto
type: blank
blankKeywords: bitcoin, btc, ethereum, eth, solana, sol, cardano, ada, ripple, xrp, dogecoin, doge, polygon, matic, polkadot, dot, avalanche, avax, chainlink, link, uniswap, uni, litecoin, ltc, binance, bnb, tron, trx, shiba, shib
blankAutoPopulate: true
blankFormat: string
tip: Crypto price (USD)
blankReadOnly: true
blankKeywordExpansions.btc: Bitcoin
blankKeywordExpansions.eth: Ethereum
blankKeywordExpansions.sol: Solana
blankKeywordExpansions.ada: Cardano
blankKeywordExpansions.xrp: Ripple
blankKeywordExpansions.doge: Dogecoin
blankKeywordExpansions.matic: Polygon
blankKeywordExpansions.dot: Polkadot
blankKeywordExpansions.avax: Avalanche
blankKeywordExpansions.link: Chainlink
blankKeywordExpansions.uni: Uniswap
blankKeywordExpansions.ltc: Litecoin
blankKeywordExpansions.bnb: Binance Coin
blankKeywordExpansions.trx: TRON
blankKeywordExpansions.shib: Shiba Inu
# Clearing is SHAPE-DERIVED (the blankReplace dial was deleted, June 2026):
# a bare ticker is the KEYWORD, not a captured arg, so the label stays —
# "btc _" → "btc BTC: $78,542.00".
# Blank-as-context: when blank-context-mode is on, expose BTC + ETH
# as ambient tokens ([CRYPTO BTC], [CRYPTO ETH]) so casual phrasings
# ("how is bitcoin doing _", "crypto check _", "digital currency _")
# route through fluid-blank without typing the keyword.
as-context: safe
context-slots: BTC, ETH
# TYPED-SENTINEL Phase 4 — ai-callable ON-DEMAND fetch. With `sentinel-language:
# typed`, the catalog advertises `[CRYPTO(symbol: string): number]` and the
# runtime may call CryptoBlank.get(<symbol>) with an LLM-provided symbol — e.g.
# `[CRYPTO(symbol=SOL)]` — even for a coin not pre-fetched. SAFE: bounded
# codomain (a symbol → a USD price), no exec/side-effect, no blankScript.
signature: (symbol: string)
returns: number
ai-callable: true
---

Implementation: built-in `CryptoBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/crypto.ts`). Hits CoinGecko's
free public API (no key, no signup) for live USD prices. 60-second
cache per coin.

Examples:
- `bitcoin _` → `Bitcoin $68,432.50`
- `eth _` → `Ethereum $3,521.40`
- `doge _` → `Dogecoin $0.1245`

Mirrors the StocksBlank pattern — keyword expansions render the
short ticker as the friendly display name. ReadOnly: cycling is no-op
(refresh by typing a new `_`).
