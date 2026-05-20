# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

Personal blog for the OpenCues project. Each section of the original draft is its own markdown file under `posts/`. Source materials and reference docs live under `resources/`. Backlog of future post topics is in `todos.md`.

- `posts/` — one markdown file per post, plus `README.md` as an index
- `resources/` — background notes, the OpenCues rules, the CommandStick problem-solution doc
- `todos.md` — "save for later" topic list

No build tooling yet. Posts are plain markdown.

## Writing style

Wilfred's voice on long-form pieces (mechanics essays, blog posts). This is *different* from the terse FAQ/documentation tone he uses on ClaudeLog reference pages — match this one for opencues-blog content.

### Voice

- First person, opinionated. "I find myself…", "I am of the belief…", "I have personally observed…".
- Personal anecdote is the backbone — moderating r/ClaudeAI, "after iterating 6 months", years of designing HCIs.
- Self-effacing asides are welcome — "I am a noob at Bash", "my team were whelmed at best", the occasional "haha".
- British spelling — utilise, optimisation, behaviour, organise.

### Structure of a piece

- Open with a flat, one-line thesis sentence.
- Blockquote near the top as a reframe or punchline (`> How tight is tight?`, `> To design is to decide`, `> Bewilderment is the enemy of invention`).
- Short paragraphs, 1–3 sentences. Longer only for worked examples.
- Bulleted lists for parallel ideas, usually `**Bold label** — explanation.`
- Close with a forward-looking line ("I am excited to…", "I am looking forward to…").

### Diction

- **Backtick coined or named concepts** — `permutation framework`, `vibe code`, `In Ram`, `start-up frames`, `slop`, `well-known`. The backticks signal "treat this as a term."
- **Backtick keychords every time.** `Ctrl+Alt+Up`, `Ctrl+Alt+Right`, `Cmd+K`. Bare keychord notation reads as English text and gets lost in the prose; the backticks mark them as commands the reader can act on.
- Mix technical and casual registers — "extract value", "grok", "rapidly iterate" alongside "bums", "neigh endless", "chin up".
- Recurring metaphor families: fighting-game frames (`start-up frames` / `active window duration` / `end-lag` — see canonical names below), `flow`, `in the zone`, gaming/RPG framings.

### Rhetorical moves

- Question → answer. "Ok, but how does it work?", "How tight is tight?".
- Personal observation → general principle. Anecdote first, claim second.
- Tangents in parentheses to acknowledge nuance without breaking flow.
- Single-line pull quotes in `>` blockquote form for memorable phrasings.

### Avoid

- Marketing fluff, "Benefits:" bullet stacks, "amazing", "you'll love this", "easier than ever".
- Excessive exclamation marks (one for genuine excitement is fine).
- Over-explaining obvious steps. Trust the reader.
- Saying the same thing twice in different words.
- Re-asserting what the body already demonstrated. If three sections have shown the framework doing predictive work, do not then add a paragraph claiming the framework is predictive. Trust the demonstration. Three concrete examples (math, lookup, rewrite) demonstrate *the system identifies and fulfils requests* — adding *"the system dynamically identifies and fulfils the user's request"* afterward is the author insisting on what the examples just showed. Same trap shows up in three forms: (a) a *cost is concrete* paragraph after a regression list, (b) a *the framework is also predictive* paragraph after axis sections, (c) a *the system handles X* sentence after concrete examples. **In each case the body has done the work; the abstract restatement is the cut.**
- Defending the work against objections nobody raised. "That is the test of whether X is doing real work" is the author hedging, not the prose earning its place.
- Counterfactual / impossibility claims that the post can't actually defend. *"X couldn't have appeared from within Y"* is dangerous because it claims Y was structurally incapable. Prefer the fact: *"X didn't come from within Y. It came from Z."* Same argument, no overreach.
- Superlatives that bait challenge. *"This is the strongest case I know for X"* dares the reader to find a stronger one and stops them trusting the prose if they can. Prefer *"This is a strong case for X"* — same point, no exposure. Hedging like *"that I know"* doesn't rescue a superlative.
- Tacked-on *"the rest of this blog series develops..."* sentences. The See Also footer is the forward-pointer; restating it as a sentence above is redundant. Let the post's actual closing thesis land, then See Also.
- **Never use *load-bearing* or *load bearing*.** It's a critic's tell, overused in design and engineering writing to mean *important*. Always reach for the more precise alternative: *essential*, *structural*, *foundational*, *central*, *substantive*, *critical*, or — best — name what specifically makes the thing important without the metaphor. Applies everywhere in the blog tree (posts, kit, CLAUDE.md itself).
- Aspirational capabilities described as if they ship today. The *Inline Cues* re-render described *pattern-classified LLM cues* as a current cue source when the codebase only implements keyword/regex routing. **Verify every described capability against actual implementation** before publishing. If a feature needs mentioning before it's built, mark it explicitly as *planned* / *proposed* / *future* — never let it sit in a list of current behaviour.
- Verb-object pairings that don't parse semantically. *"They teach the tool in context"* parses as if the tool is the student; the user is. Check each transitive verb to confirm its object is a plausible recipient of the verb's action. *"Teach the tool"* → *"surface information about the tool"* or *"teach the user about the tool"*.
- Triumphalist framing of design discoveries. Avoid *"what survived the filter"*, *"the only viable answer"*, *"the inevitable solution"* — these frame design choices as the outcome of divine selection rather than iteration. Prefer *"we settled on"*, *"the approach that worked for our constraints"*, *"the answer that fit"*. Constraints are ours, not universal disqualifiers — phrasing should reflect that.
- Imperatives with **both** subject and object implicit. *"Activate by typing in any prompt with cue sources installed"* leaves both *who* (the user) and *what* (the cues) unstated. The reader has to infer them. In activation lines, definitions, or other foundational positions, name at least one — and if it's a foundational sentence, name both: *"Cues activate automatically as the user types in any prompt with cue sources installed."*
- Circular qualifications. *"Any **non-blocking** cue must use a different modality"* loads the conclusion into the premise — *non-blocking* is what the rule is establishing, so qualifying the subject with it makes the rule tautological. Drop the qualifier and let the rule stand: *"Any cue must use a different modality."* Same applies any time a rule's subject already names its outcome.
- Declarative absolutes where the post is making a normative argument. *"This **is** the foundational rule for AI HCI"* asserts the rule already governs the field; the post's actual claim is *"this **should be** a foundational rule when designing AI HCIs."* The same pattern applies to *"where AI HCI **goes** next"* vs *"where AI HCI **should go** next"*. When the prose argues for a direction, use *should* / *ought*. Reserve *is* / *will* for fact-claims the post can defend.

---

## Punctuation

- **No em dashes (—).** Use commas, colons, parentheses, semicolons, or sentence breaks. Em dashes are a tell that prose is AI-generated and they fight against Wilfred's voice. A sentence with two em dashes usually wants to be two sentences.
- Hyphens in compound modifiers are fine (`fighting-game design`, `start-up frames`, `time-to-completion`). The rule is specifically about the long em dash used as a parenthetical.

## Articles

- Always **"a HCI" / "A HCI"**, never "an HCI" / "An HCI". HCI is parsed as *Human-Computer Interface* (consonant H), and the article should follow that reading.

## Abbreviation expansion

- **Expand HCI on first use in every post.** *"HCI (Human to Computer Interface)"* on the first occurrence, bare *HCI* thereafter. Each post stands on its own; a reader arriving via search shouldn't need to have read post #1 to know the term. Use the same expansion text every time (*Human to Computer Interface*, with hyphenation per the post #1 title).
- Same rule for other domain abbreviations the series introduces (e.g. *HAII (Human-to-AI Interface)*).

## External resource links

- **Link external named resources on first use.** Reddit communities, websites, products, papers — anything the reader could click to verify or explore. *r/ClaudeAI* → `[r/ClaudeAI](https://www.reddit.com/r/ClaudeAI)`. *ClaudeLog.com* → `[ClaudeLog.com](https://claudelog.com)`. Subsequent mentions can be plain text.
- If the same resource is mentioned multiple times in the same post, link every instance to the same URL so a reader hovering at any point gets the same destination.

## Cross-references to other posts in the series

- **Reference other posts by name, not by number.** *"Posts #1 to #3 developed..."* is opaque; *"[HCI], [Human Interaction], and [Inline Cues] developed..."* tells the reader what each post covered and gives them clickable destinations. Link the post titles to their files (`hci-human-to-computer-interface.md`, etc.) so a curious reader can jump.
- This is true even for ranges. Don't write *"posts #1–#3"*; write *"[HCI], [Human Interaction], and [Inline Cues]"*. The named list is more informative, and each title links to its own post.

## Professional register

The voice is opinionated and personal (see "Voice" above), but the diction is professional. Casual punch undercuts authority. Prefer:

- *initiates* over *fires*
- *prevented from doing X* over *held there*
- *the result returns / completes* over *the result lands*
- *to proceed* / *for the next task* over *to do their next thing*
- *perceived cost* over *felt cost*
- *actual duration* over *real duration*
- *governs* over *gates*
- *time-to-completion* (hyphenated compound)
- *move onto the next task* / *proceed to the next task* over *chain into the next thing*
- *HCI design decision* over *design move* (use the full term)

Quotes from Wilfred should sound like things he'd actually say. **Never invent quotes** — pull from his messages, prior writing, or omit.

## OpenCues primitives — capitalisation

OpenCues primitives are treated as proper nouns, capitalised on every reference (not just at sentence start). This applies to:

- **Inline Cues** — the LLM→user cue (post #3).
- **Inline Prompting** — the user→LLM cue (post #4).
- **Inline Agents** — continuous LLM editing (post #5).

Generic uses of *cue* / *prompt* / *agent* in lowercase are fine when not naming the OpenCues primitive. The capitalisation marks the term of art so the reader can distinguish *the named primitive* from a generic descriptor.

## *Fill the blank* vs *resolve the blank*

*Fill in the blank* is the marketing/colloquial term, familiar from school. The technical reality is that the blank is **resolved** — the system reads the surrounding context, infers what fits, and provides it.

- Use **resolve / resolved** in technical descriptions (mechanism sections, *Ownership lock*, *Visible failure*, *How blanks resolve*).
- Use **fill in the blank** only when explicitly invoking the schoolchild idiom or the marketing framing (e.g. the *Lineage: fill in the blank* section title).
- The two terms describe the same physical action; the choice signals register. Default to *resolve* unless the marketing/cultural reference is doing real work.

## Two-direction model — naming the directions

Both directions of the OpenCues model are *cues*; only the direction differs. Use **LLM→user cue** and **user→LLM cue** as the canonical phrases, never *LLM→user direction* / *user→system direction* / *blank direction*.

- **LLM→user cue** — what the LLM surfaces to the user. *Inline Cues* lives here.
- **user→LLM cue** — what the user requests of the LLM. *Inline Prompting* lives here. (A blank is itself a cue, just from the user's side.)

The endpoints are *LLM* and *user* — not *system* and *user* (vaguer) or *machine* and *human* (jargon). *LLM* names the actual resolver; *user* names the human at the keyboard. Don't drift to *blank direction* (reads as *empty*) or *cue direction* alone (asymmetric — both halves are cue directions).

## HCI 3-Axis Analysis — canonical framework name

The framework introduced in `posts/hci-human-to-computer-interface.md` is called the **HCI 3-Axis Analysis** (capitalised, hyphenated). When a section runs the framework on a mechanic (e.g. evaluating a primitive against it), the section heading is *HCI 3-Axis Analysis* and the lead-in is *Scoring [X] against the HCI 3-Axis Analysis:* or similar.

Avoid the older variants — they read as imprecise descriptions rather than a named term:

- ❌ *3-axis framework*
- ❌ *3-axis read*
- ❌ *three axes* (lowercase, as a name)
- ❌ *the framework* (when meant as the canonical reference)

The three axes themselves keep their canonical names:

1. **Start-up frames** (always plural, hyphenated, "frames" never dropped)
2. **Active window duration** (full compound noun, never "active window" alone)
3. **End-lag** (hyphenated; replaces the earlier term *cool-down*, which is retired)

The closing-line pattern for each axis when introduced (in the HCI post) is: *"Reducing X is the HCI design decision that …"*. Never substitute *start-up*, *active window*, or *cool-down* alone.

## Reveal discipline

The series builds on itself. Earlier posts must not pre-empt later posts' reveals:

- **HCI (post #1)** — introduces the 3-axis framework. Does *not* reference blanks (`_`), the cues/blanks two-direction model, or any OpenCues-specific primitive. Closes with a tease about what LLMs unlock.
- **Inline Cues (post #3)** — first place the cues direction is named.
- **Inline Prompting (post #4)** — first place blanks (`_`) are named. Don't reference `_` or "blanks" in any post earlier than this one.
- **Inline Agents (post #5)** — first place agentic continuous editing is named.
- **Cross-domain Pollination (post #13)** — full development of the cross-domain argument. Earlier posts can forward-link.

When in doubt, defer to a later post. The series rewards readers who go in order.

## Drafting vs re-rendering

Drafts of posts carry a `## STAGING NOTES (not yet formatted)` appendix with lettered sub-sections (A, B, C…). The appendix is **scaffolding, not deliverable**. When a post is re-rendered, every lettered note is either absorbed into the body, pruned, or deferred to another post. **A finished re-render has no `STAGING NOTES` section.**

The full structural template (the seven movements, the three OpenCues-only depth moves, the polishing passes) lives in `STRUCTURE-KIT.md` at the blog root. Read it before re-rendering any post.

## Re-rendering: the playbook

The patterns below came out of the HCI re-render. They recur in every polishing pass; reach for them by default.

### The axis-section template

Framework posts often introduce three or more named axes or components in parallel sections (the HCI post does this with *Start-up frames* / *Active window duration* / *End-lag*). Use this template per axis:

1. **Definition line.** One sentence, parallel structure with the other axes. The three definitions should visibly measure related things (*how long the user must wait* / *how long the HCI's process takes* / *how much effort the user must spend to return*).
2. **Body paragraph.** Naïve view + correction + principle, or canonical bad case + the fix.
3. **Closing line.** *"Reducing X is the [framework] design decision that ..."*. Names the design move the axis enables. Use the same phrasing across every axis section in the post.

### Term introduction discipline

If a term will appear in a later H3 (e.g. *axes*, *substrate*, *fluent*), introduce it explicitly in the body *before* that heading. Don't drop terms into headings and trust the reader to infer. In the HCI re-render, *axes* was used in the H3 *"Beyond the three axes"* but never named earlier; the fix was to introduce *axes* in *With the framework*: *"the three terms map cleanly onto HCI evaluation as axes."*

### Pull-quote placement

Pull-quotes are payoffs, not openers. Place them after the body has earned the claim. The HCI post's *"A great HCI takes nothing from the user that the work itself didn't already demand"* lands at the end of *Why these three?*, after the paragraph that defines what the three axes measure. If a pull-quote leads a section, the body that follows feels like throat-clearing.

When a section's closing sentence is more aphoristic than the surrounding prose, consider promoting it from inline prose to a `>` blockquote. The aphorism lands harder when set apart, and it gives the section a clear thesis-anchor rather than fading out. *Inline Cues*'s *Continuous onboarding* section was promoted this way: *"Anywhere the work is the surface, the teaching can live with the work"* moved from a trailing prose sentence to a standalone pull-quote, with no rewording needed.

### H3 punctuation

Question-shaped H3s get a question mark (*"Why these three?"*, *"What LLMs unlock?"*). Descriptive H3s (*"Start-up frames"*, *"Lineage: fighting games"*) and prepositional H3s (*"Prior to the framework"*, *"Beyond the three axes"*) don't. The TOC then signals which sections *answer a question* vs *name a thing* vs *zoom out* — a useful semantic tier for the reader.

### H3 antecedent clarity

H3 headings are scanned out of context. Any pronoun or vague noun in a heading must have its antecedent *inside the heading itself*. *"Why it works: the modality rule"* leaves *it* dangling — the reader scanning the TOC doesn't know what *it* refers to. Fix by promoting the antecedent: *"Why non-blocking cues work: the modality rule"*. Same rule applies to *the system*, *this approach*, *that pattern* — if a TOC scan can't resolve the reference, rewrite.

### Bullet ordering by strength

When a section lists examples of *what's missing*, *what's wrong*, or *what an HCI design decision affects*, commit to an ordering principle. Strongest-first grabs attention; weakest-first builds to a climax. Either is fine; arbitrary ordering reads as a brain-dump. In the *Human Interaction* re-render, the *What current LLM chat lost* bullets were reordered strongest-first so the most thesis-relevant case (the LLM cannot steer the user during prompt construction) lands first; the UI-mechanics cases trail it.

### Count honesty

If the lead-in promises *"three primitives"*, the bullet list must have three items, not five. Mismatch reads as imprecise even if the reader doesn't consciously count. The *Inline Cues* re-render originally promised three primitives in the lead-in but listed five bullets (dim, navigate, cycle, status line, editing). Fix was to keep the lead-in honest: three bullets for the three primitives; the supporting items (status line as display surface, editing as state transition) folded into the relevant bullet's prose or moved to a follow-up sentence. If the count is genuinely *n*, write *n* in the lead-in; if you want to keep a particular lead-in number, restructure the bullets to honour it.

### Verb consistency across the post

When the same effect or thing is described twice, use the same verb both times. The *Human Interaction* re-render had *"shifts the chat window"* in one section and *"would push the chat window"* in another, both describing the same chat-window-displacement effect. The reader has to mentally translate between the two. Pick one verb (*shift* in this case) and use it everywhere. Polishing variation reads as elegance to the writer and as a stumble to the reader.

### Lifecycle completeness

When a post argues that a mechanism handles *change*, check that it covers all three lifecycle states: birth (new things added), mutation (existing things change), and death (old things removed or replaced). The *Inline Cues* re-render originally covered birth and mutation in the *With Inline Cues* paragraph but missed deprecation. Onboarding and continuous-update mechanisms handle deprecation just as much as they handle additions; missing that case leaves a gap in the argument that a careful reader will spot. Three parallel *When X, Y* sentences are a tight way to enumerate the lifecycle (e.g. *"When the feature changes... When a new feature ships... When old behaviour is deprecated..."*).

### Framing breadth — match the abstract framing to the full capability

When a primitive does several things, the abstract framing sentences (cold-open, description, looking-forward, activation lead) must be broad enough to cover all of them. The *Inline Prompting* re-render originally framed the primitive as *summons a value into a slot* / *answers it in place* / *where the value should appear* — all lookup-flavoured language. But Inline Prompting also handles rewrites (transform mode) and keyword-bound external state (live data). A reader who only reads the cold-open and activation would think the primitive only does Q&A. Fix: broaden the abstract framings to verbs that span all resolution paths (*responds*, *assistance*, *user-summoned response*, *resolves*). Concrete examples can stay specific — but the abstract framings must match the full primitive.

### Examples show contextual rules; they do not just illustrate one case

When a system has contextual behaviour (the output depends on the surrounding input), the examples in the post should *demonstrate* the rule across shapes, not pick one shape and stop. The *Inline Prompting* re-render originally had `4 * 12 = _` → `48` and `capital of france _` → `Paris`. Both were correct individually, but neither showed the system's actual rule (the system preserves whatever template the user wrote). Fix was to add the matched pair: `4 * 12 = _` → `4 * 12 = 48` (template preserved) alongside `capital of france _` → `Paris` (no template, just answer). The reader infers the rule from the contrast. When the system's behaviour is *contextual*, the examples must include at least one pair that varies the context with everything else equal.

### Pronoun reach

Each pronoun should have an unambiguous antecedent within one or two clauses. If *they* / *it* / *them* has to reach across a sentence break or a different subject, replace it with the actual noun. In the HCI re-render, *"what they had spent decades analysing"* had *they* reaching across the paragraph to *players who had to get it right under pressure*. Fix: *"what the fighting-game community had spent decades analysing"* — self-contained, no reach.

In **foundational sentences** (cold-opens, pull-quotes, definitions), be even stricter: replace pronouns with their explicit nouns even when the antecedent is only one clause back. *"They teach the tool in context, as the user uses it, without requiring them to leave the prompt"* → *"...without requiring the user to leave the prompt."* The repetition reads slightly redundant but the reader doesn't have to track antecedents. In the cold-open of post #3 the redundancy was the right trade.

### Invented-quote tell

If an attributed quote sounds plausible but you can't source it from the user's actual messages or prior writing, it's invented and reads false. Two HCI examples that got rejected: *"This gesture commits you for too long"* and *"This menu makes you stop too hard at the end."* The replacements that worked were pulled from Wilfred's own feedback in the conversation: *"It's usable, but within a workflow it's the slowest part"* and *"Each step works on its own; using them in sequence works, but it's missing something."* **When you can't source a quote, omit rather than invent.**

### STAGING NOTES — three fates, no fourth

Each lettered note in the appendix has three possible outcomes during re-render:

- **Absorb** — fold into the body (paragraph, new named H3, callout, or pull-quote).
- **Prune** — turned out not to matter. Delete.
- **Defer** — real material, but belongs to a different post. Move it.

A re-rendered post has no `## STAGING NOTES` section. If notes are still in the appendix when the re-render is otherwise done, the polish stopped early.

### Polishing audit (read the diff backwards)

Before declaring a re-render done, run a backwards audit on the diff. None of the following should survive into the re-render:

- Em dashes (`—`)
- *an HCI* (should be *a HCI*)
- *cool-down* (retired term; use *end-lag*)
- Casual verbs (*fires*, *lands*, *kept typing in the meantime*, *get their next thing*)
- Superlatives that bait challenge (*the strongest case I know*, *the most useful X*)
- Counterfactuals the post can't defend (*couldn't have appeared*, *would never have*)
- Re-asserts of what the body already demonstrated
- Defenses against objections nobody raised
- Invented quotes
- The `## STAGING NOTES` section itself
- References to mechanics that belong to later posts (e.g. blanks / `_` in any post earlier than #4)
- Factual claims about current LLM chat that aren't actually true of mainstream interfaces (ChatGPT, Claude, Gemini). *"The user cannot type while the model is generating"* was wrong: most modern interfaces allow this. When listing what current LLM chat *lacks*, check each example against the current state of the field, not against historical defaults.
- Inconsistent verbs for the same effect. The *Human Interaction* re-render used both *shifts the chat window* and *would push the chat window* for the same chat-window displacement. Same effect → same verb. Search for verb variants describing the same phenomenon before declaring done.
- Inconsistent shorthand for the same keychord. The *Inline Cues* re-render used *Ctrl+Alt+Up / Ctrl+Alt+Down* in one place and bare *Up / Down* in another for the same cycling action. The bare-arrow shorthand reads as if it might be an unmodified key. Use the full keychord every time the action is named, even when it lengthens the sentence.
- Subject/verb/complement agreement, especially on plural subjects with singular noun complements. *"Inline cues are a system-to-user signal"* mismatched plural *cues* with singular *signal*. Fix is plural throughout (*"are system-to-user signals"*) or singular subject (*"An inline cue is a system-to-user signal"*). Check every *X are Y* / *X is Y* sentence for agreement, not just verb agreement but noun-complement agreement too.

If any of those survive into the re-render, the polish stopped early. Run another pass.

---

## When new conventions emerge

If a re-render surfaces a new convention that should apply to future posts, **update this file**. The blog's voice and rules drift only if we let them drift undocumented.
