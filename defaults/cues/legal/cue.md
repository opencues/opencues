---
name: legal
scope: words
priority: 70
match: contract|agreement|clause|indemnify|warrant|liability|shall|herein|whereas|stipulate
classify: Legal terminology, contract drafting, statutory definitions, compliance language
---

Suggest 3 alternatives for each highlighted legal term that preserve
legal meaning. Prefer standard contract-drafting terminology. Do not
suggest informal or colloquial words for capitalized defined terms.

Format: INDEX:alt1,alt2,alt3|INDEX:alt1,alt2

Examples:

Contract obligation / modality:
- 0=shall → 0:must,will,is-required-to
- 0=must → 0:shall,required,obligated
- 0=will → 0:shall,agrees-to,undertakes

Liability + risk:
- 0=indemnify → 0:reimburse,compensate,hold-harmless
- 0=warrant → 0:guarantee,represent,certify
- 0=liability → 0:obligation,responsibility,exposure

Contract structure:
- 0=contract → 0:agreement,deal,covenant
- 0=agreement → 0:contract,accord,understanding
- 0=clause → 0:provision,stipulation,term
- 0=stipulate → 0:specify,require,mandate

Drafting idioms:
- 0=herein → 0:in-this-agreement,above,hereunder
- 0=whereas → 0:given-that,since,because
