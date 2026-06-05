---
name: crypto
type: blank
blankKeywords: bitcoin, btc, ethereum, eth, solana, sol, cardano, ada, ripple, xrp, dogecoin, doge, polygon, matic, polkadot, dot, avalanche, avax, chainlink, link, uniswap, uni, litecoin, ltc, binance, bnb, tron, trx, shiba, shib
blankAutoPopulate: true
blankFormat: string
blankTip: Crypto price (USD)
blankReadOnly: true
blankProximity: 1
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
# Auto: bare "btc _" → wipe → "BTC: $78,542.00" (ticker embedded).
# Copula phrasing → keep.
blankReplace: auto
# Blank-as-context: when blank-context-mode is on, expose BTC + ETH
# as ambient tokens ([CRYPTO BTC], [CRYPTO ETH]) so casual phrasings
# ("how is bitcoin doing _", "crypto check _", "digital currency _")
# route through fluid-blank without typing the keyword.
as-context: safe
context-slots: BTC, ETH
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
