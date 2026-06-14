---
name: crypto
type: blank
blankKeywords: bitcoin, btc, ethereum, eth, solana, sol, cardano, ada, ripple, xrp, dogecoin, doge, polygon, matic, polkadot, dot, avalanche, avax, chainlink, link, uniswap, uni, litecoin, ltc, binance, bnb, tron, trx, shiba, shib
# blankShapes: precision gate (June 2026). Each keyword anchored at
# the start of the input — drops prose like "she said bitcoin would
# moon _" or "tron the movie _" from claiming the slot. The 30-coin
# alternation is verbose but explicit; mirrors the stocks blank.
blankShapes: [{"pattern":"^(bitcoin|btc|ethereum|eth|solana|sol|cardano|ada|ripple|xrp|dogecoin|doge|polygon|matic|polkadot|dot|avalanche|avax|chainlink|link|uniswap|uni|litecoin|ltc|binance|bnb|tron|trx|shiba|shib)\\s*_$","action":"get","valueGroup":1}]
blankAutoPopulate: true
blankFormat: string
blankTip: Crypto price (USD)
blankReadOnly: true
# One-span emission — no cycle vocab. Whole substituted result
# dims, Backspace wipes, edit-anywhere triggers clearOnEdit.
blankClearOnEdit: true
blankConsumeContext: true
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
