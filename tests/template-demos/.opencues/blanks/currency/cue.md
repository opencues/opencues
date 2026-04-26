---
name: currency
parser: answer
scope: blanks
match: \$?\d+(\.\d+)?\s*(USD|EUR|GBP|JPY|CHF|CAD|AUD|CNY|INR|BTC|ETH)?\s*(in|to)\s*(USD|EUR|GBP|JPY|CHF|CAD|AUD|CNY|INR|BTC|ETH)
keywords: in EUR, in USD, in GBP, in JPY, convert to, exchange rate, currency
priority: 90
---
Convert the currency amount to the target currency. Output one line.
Use the standard ISO-4217 currency code. If the rate is unknown,
output your best-known approximation (don't say "I don't know").

Format: ANSWER=<amount> <currency-code>

Examples:
- "$100 in EUR is _" → ANSWER=92 EUR
- "50 GBP to JPY _" → ANSWER=9500 JPY
- "convert 200 USD to CHF _" → ANSWER=178 CHF
- "1 BTC in USD _" → ANSWER=68000 USD
- "exchange rate USD to EUR _" → ANSWER=0.92 EUR per USD
