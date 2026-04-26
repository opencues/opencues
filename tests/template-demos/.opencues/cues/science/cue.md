---
name: science
parser: alternatives
scope: words
match: \b(hypothesis|theory|organism|molecule|atom|catalyst|gravity|momentum|entropy|frequency|amplitude|protein|enzyme|gene|cell|nucleus|electron|proton|isotope|reagent|solvent|substrate|equilibrium|oscillation|wavelength|trajectory)\b
classify: Scientific terminology — chemistry, biology, physics. Suggest alternatives that preserve technical precision; never simplify a defined term to a colloquialism.
priority: 75
tip: scientific term alternative
---
Suggest 3 alternatives for each highlighted scientific term, preserving
the original meaning and discipline. For chemistry: stay within standard
IUPAC vocabulary. For biology: prefer ICD-10 / standard taxonomic terms.
For physics: prefer SI-unit-aligned terms. Never substitute a precise
technical term with a vague generic word.

Format: INDEX:alt1,alt2,alt3|INDEX:alt1,alt2

Examples:

Biology:
- 1=organism → 1:specimen,life-form,bioform
- 1=protein → 1:polypeptide,proteome,protein-complex
- 1=enzyme → 1:catalyst,biocatalyst,protease
- 1=gene → 1:locus,allele,coding-sequence

Chemistry:
- 1=catalyst → 1:promoter,initiator,reaction-accelerator
- 1=molecule → 1:compound,structure,molecular-entity
- 1=solvent → 1:medium,dispersant,carrier-fluid
- 1=reagent → 1:reactant,substance,chemical-input

Physics:
- 1=hypothesis → 1:conjecture,proposition,working-model
- 1=momentum → 1:linear-momentum,impulse,inertial-quantity
- 1=entropy → 1:disorder,thermodynamic-entropy,information-entropy
- 1=frequency → 1:rate,oscillation-rate,cycles-per-second
- 1=wavelength → 1:lambda,spatial-period,wave-spacing

Output ONLY in INDEX:alt format.
