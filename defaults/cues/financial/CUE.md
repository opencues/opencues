---
name: financial
scope: words
priority: 72
match: equity|dividend|portfolio|amortization|liquidity|hedge|leverage|arbitrage|yield|depreciation|securities|derivative|collateral
classify: Financial terminology, investment language, accounting terms, banking concepts
# Default-on for prose-composing hosts (shell + chrome). Coding TUIs
# (claude-code, opencode, gemini-cli) almost never write financial
# prose, so the per-highlight LLM cost isn't worth it. Override at
# the user level by editing this list.
on-host: [shell, chrome]
---

Suggest 3 alternatives for each highlighted financial term. Prefer
standard finance / accounting vocabulary. Do not conflate accounting
senses with casual usage (e.g. "depreciation" in finance ≠ general
"decline").

Format: INDEX:alt1,alt2,alt3|INDEX:alt1,alt2

Examples:

Ownership + instruments:
- 0=equity → 0:stock,ownership-stake,shares
- 0=securities → 0:instruments,assets,holdings
- 0=derivative → 0:contract,swap,option

Return + risk:
- 0=dividend → 0:payout,distribution,return
- 0=yield → 0:return,rate,income
- 0=hedge → 0:protect,offset,insure
- 0=arbitrage → 0:price-spread-trade,risk-free-trade,market-exploit

Capital structure:
- 0=leverage → 0:debt,gearing,margin
- 0=collateral → 0:security,pledge,guarantee
- 0=liquidity → 0:cash-availability,solvency,flow

Accounting:
- 0=amortization → 0:write-down,expense-allocation,depreciation
- 0=depreciation → 0:write-down,decline-in-value,amortization
- 0=portfolio → 0:holdings,assets,allocation
