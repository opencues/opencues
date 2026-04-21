---
name: grammar
scope: words
priority: 50
---

Provide 3 alternatives per word: synonym, opposite, creative. Skip function words.

Prefer concise single-word synonyms over multi-word phrases.
For technical terms, suggest alternatives within the same domain
rather than generic synonyms. Avoid archaic or overly formal language.

Format: INDEX:alt1,alt2,alt3|INDEX:alt1,alt2

Examples:

Adjectives:
- 1=beautiful → 1:gorgeous,ugly,stunning
- 1=happy → 1:joyful,sad,cheerful
- 1=big → 1:large,small,enormous
- 1=fast → 1:quick,slow,rapid
- 1=old → 1:elderly,young,ancient
- 1=tall → 1:high,short,towering
- 1=loud → 1:quiet,soft,deafening
- 1=bright → 1:dim,brilliant,dazzling
- 1=hot → 1:cold,warm,scalding
- 1=cold → 1:hot,freezing,chilly
- 1=clean → 1:dirty,messy,spotless
- 1=easy → 1:hard,difficult,simple

Adverbs:
- 1=quickly → 1:slowly,rapidly,swiftly
- 1=softly → 1:loudly,quietly,gently
- 1=slowly → 1:quickly,gradually,leisurely
- 1=happily → 1:sadly,joyfully,cheerfully
- 1=loudly → 1:quietly,softly,noisily
- 1=silently → 1:loudly,quietly,stealthily
- 1=carefully → 1:carelessly,gently,cautiously
- 1=patiently → 1:impatiently,calmly,eagerly

Verbs:
- 1=ran → 1:walked,sprinted,jogged
- 1=said → 1:whispered,shouted,stated
- 1=looked → 1:glanced,stared,gazed
- 1=walked → 1:ran,strolled,marched
- 1=whispered → 1:shouted,murmured,screamed
- 1=demolished → 1:destroyed,built,obliterated

Nouns:
- 1=dog → 1:cat,wolf,puppy
- 1=boy → 1:girl,child,lad
- 1=man → 1:woman,person,gentleman

Proper Nouns (give similar entities, not synonyms):
- Companies: 1=Google → 1:Microsoft,Apple,Amazon
- Companies: 1=Tesla → 1:Ford,BMW,Toyota
- People: 1=Einstein → 1:Newton,Darwin,Hawking
- Countries: 1=France → 1:Germany,Italy,Spain
- Cities: 1=Paris → 1:London,Tokyo,Berlin
- Programming: 1=Python → 1:Java,JavaScript,C++
- Programming: 1=React → 1:Vue,Angular,Svelte

Emotional:
- 1=sad → 1:happy,melancholy,depressed
- 1=angry → 1:calm,furious,enraged
- 1=excited → 1:bored,thrilled,eager
- 1=worried → 1:calm,anxious,concerned

Output ONLY index:alternatives format.
