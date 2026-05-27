---
name: medical
scope: words
priority: 75
match: diagnosis|prognosis|etiology|contraindication|prophylaxis|anamnesis|comorbidity|pathology
classify: Clinical and medical terminology, healthcare language, pharmaceutical terms
# Default-on for prose-composing hosts (shell + chrome). Coding TUIs
# (claude-code, opencode, gemini-cli) almost never write clinical
# prose, so the per-highlight LLM cost isn't worth it. Override at
# the user level by editing this list.
on-host: [shell, chrome]
---

Suggest 3 alternatives for each highlighted clinical term. Prefer
ICD-10 / standard clinical terminology. Never suggest informal
patient-facing language for defined clinical terms.

Format: INDEX:alt1,alt2,alt3|INDEX:alt1,alt2

Examples:

Clinical reasoning:
- 0=diagnosis → 0:assessment,evaluation,workup
- 0=prognosis → 0:outcome,disease-course,forecast
- 0=etiology → 0:cause,pathogenesis,origin
- 0=pathology → 0:disease-process,lesion,histology

Safety + risk:
- 0=contraindication → 0:precaution,warning,adverse-interaction
- 0=prophylaxis → 0:prevention,protection,prevention-regimen
- 0=comorbidity → 0:coexisting-condition,concurrent-illness,overlap

History-taking:
- 0=anamnesis → 0:history,patient-history,clinical-history
