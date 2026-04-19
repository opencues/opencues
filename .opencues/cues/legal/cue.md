---
name: legal
scope: words
priority: 70
match: contract|agreement|clause|indemnify|warrant|liability|shall|herein|whereas|stipulate
classify: Legal terminology, contract drafting, statutory definitions, compliance language
---

When the highlighted word is a legal term, suggest alternatives that
preserve legal meaning. Distinguish between:
- "shall" (obligation) vs "will" (future tense) vs "must" (requirement)
- "indemnify" vs "hold harmless" (not interchangeable in all jurisdictions)
- "warranty" vs "representation" (different legal weight)

Prefer terms from the applicable jurisdiction. Do not suggest informal
or colloquial alternatives for defined terms (Capitalized words in
the definitions section of a contract).
