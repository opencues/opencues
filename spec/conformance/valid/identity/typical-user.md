---
firstName: Wilfred
last_name: Kasekende
work-city: London
email: wilfred@example.com
phoneE164: "+441234567890"
signOff: Best from London  # description: my email sign-off
---

# IDENTITY.md — typical multi-field catalog exercising all three key
# styles the token-derivation algorithm accepts (camelCase, snake_case,
# kebab-case) plus an inline `# description:` override.
#
# Expected derived tokens (see identity-context-spec.md § Token derivation):
#   firstName  -> [FIRST NAME]
#   last_name  -> [LAST NAME]
#   work-city  -> [WORK CITY]
#   email      -> [EMAIL]
#   phoneE164  -> [PHONE E164]
#   signOff    -> [SIGN OFF]   (description: "my email sign-off")
