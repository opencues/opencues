# OpenCues Blog Post Structure Kit

A working guide for writing OpenCues blog posts. Informed by the ClaudeLog `/mechanics/` page format — but treated as a description of *how the posts want to flow*, not a skeleton to fill.

> **Premise.** ClaudeLog's mechanics pages document somebody else's product, written for read-once audiences, 80–200 lines apiece. OpenCues posts document our own invention. We can — and should — go deeper. The flow stays the same; we just have more to say in the middle.

> **About `STAGING NOTES`.** The lettered appendix that currently lives at the bottom of each post is a *drafting surface*, not a final shape. When a post is re-rendered using this kit, every lettered note either gets absorbed into the body (as a paragraph, a section, a callout, a table) or pruned. **A finished re-render has no `STAGING NOTES` section.** The depth that used to live in the appendix now lives in named H3s and the OpenCues-only depth moves below.

---

## What the mechanics posts actually do

Read `plan-mode.md`, `ultrathink.md`, and `rev-the-engine.md` back-to-back. They're not the same shape — one has a process breakdown, one has a pricing table, one is mostly a stack diagram — but they all *flow* the same way. Seven movements, only three of which are mandatory:

1. **Land the concept.** First two sentences, the reader knows what it is.
2. **Tell them how to summon it.** If there's a gesture, show it. *(Optional — skip when the post is a principle rather than a mechanic.)*
3. **Place it in time.** One sentence locating it in your project or your own discovery.
4. **Walk through the before and the after.** *Prior to X → With X.* The emotional middle. *(Optional but powerful — use it whenever the mechanic was *born from* a frustration.)*
5. **Open up depth.** Whichever H3 sections the post wants. Process? Trade-offs? Tools? Cost? Composition? The post picks; you don't pre-commit.
6. **Pin the thesis.** Somewhere mid-to-late, name the deeper move — usually as a `### The mechanism` section or a pull-quote. *(Optional but strongly encouraged — it's what makes the post worth re-reading.)*
7. **Close, then point onward.** A final framing or note, then a `See Also:` line.

The first two movements set the rhythm. Movement 4 is where the post earns the reader's trust. Movement 6 is where the post earns its place in the canon. The rest is variation.

(Drafts of OpenCues posts have a `## STAGING NOTES` appendix as scaffolding — every lettered note is raw material destined to be absorbed into one of the seven movements above, or pruned. The re-rendered post has no appendix.)

---

## What we keep from ClaudeLog, and what we don't

| Pattern | Decision | Note |
|---|---|---|
| Cold-open definition (no preamble) | **Keep.** | This is the most important thing to import. Cut every "in this post we will" instinct. |
| Activation / how-to-summon line | **Keep when it fits.** | Mechanic posts: yes. Manifesto posts: no. |
| Context-bridge sentence | **Keep.** | One sentence is plenty. |
| `### Prior to X` / `### With X` spine | **Keep when it fits.** | Default for mechanic posts. Manifesto posts (`Disruption`, `What is Invention`) usually open with a thesis instead. |
| Named, earned H3s ("The Performance Multiplier", not "Overview") | **Keep — hard rule.** | A reader scrolling the TOC should know the section's *thesis* from the heading alone. |
| Numbered process H3s ("Round 1: …", "Round 2: …") | **Keep when sequential.** | Don't number when the steps don't strictly compose. |
| `:::tip` callouts | **Adapt.** | We use plain markdown, so: `> **Note:** …` blockquotes do the same job. |
| Pull-quotes | **Keep — and lean on more.** | ClaudeLog uses these sparingly. We have actual theses worth pulling. |
| Comparison tables (X vs Y vs Z) | **Keep.** | Especially valuable for "OpenCues vs incumbent pattern" comparisons. |
| `See Also:` footer | **Keep.** | Three to five links. Plain `·` middots instead of styled `<span>` dividers. |
| Liberal `---` dividers | **Keep — but breathe with them, don't fence.** | One per section transition is plenty. Two `---`s around a callout is the ClaudeLog tic; not essential. |
| Backticks for mechanic names | **Keep — hard rule.** | `` `_` ``, `` `cue.md` ``, `` `BlankSource` ``, `` `agentically <X> _` ``, `` `@opencues/runtime` `` — always. |
| Frontmatter (Docusaurus YAML) | **Adapt.** | Slim it: `title`, `date`, `description`, `tags`, `cross_links`. Drop `sidebar_position`, `pagination_*`, `image`, the imports — we don't have a Docusaurus site (yet). |
| AdSense / Verdent / SponsorLogoWall blocks | **Drop.** | No ads. |
| Hidden agent-detection HTML | **Drop.** | Not relevant. |
| Two-`---`-fenced ad slots scattered through the body | **Drop.** | They break the flow once you remove the ads. |

The pruning is significant: a clean OpenCues post inherits the *spine* of a mechanics page but reads ~25% tighter because we're not threading ad slots through every section.

---

## The three OpenCues-only depth moves

ClaudeLog rarely names the deeper design move; it documents the surface. We can — and should — go further. Pick at least one of these for any non-stub post; pick all three for flagship posts.

**The mechanism.** The interesting move the design makes. Often inverts an industry default. *Inline Prompting* inverts who decides where the LLM call lands (user, not system). *Inline Agents* inverts where the agent's edits live (in the user's draft, not in a side panel). One paragraph plus a pull-quote is usually enough.

**Lineage.** What we built on. Naming prior art is a credibility move, not a humility one. Google Docs Suggestions for inline edits. Vim modal editing for the dispatch primitive. RSS for the "any field becomes a surface" thesis. Three bullets minimum, or a small parallel-table.

**3-axis read.** Run the start-up / active-window / cool-down framework on the mechanic and *score it*. One bullet per axis, one sentence each. "Passes all three because the prompt and the artifact share the same surface." Hedging is for politicians.

These three are also where most absorbed staging notes end up. A note that grounds the design rationale becomes part of *the mechanism*. A note that points at prior art becomes part of *lineage*. A note that pins UX behaviour becomes part of *the 3-axis read*. Notes that don't slot into any of these usually want to be a new named H3 in the body, or to be cut.

---

## How a post should *read*

Read it aloud. The mechanics posts pass this test. The flow has a rhythm:

> Definition. (Beat.) How you summon it. (Beat.) Where it sits in time. (Beat.)
> Here's what was broken. (Pause.) Here's what changed.
> Now the depth — pick your sections, vary the texture: a paragraph, then a list, then a table, then a paragraph again.
> Here is the deeper move. (Pull-quote.)
> Closing framing. See Also.

Three things make a post *read* like a mechanics post rather than a draft:

1. **The opening is dense and unhedged.** No "I've been thinking about…", no "It's interesting to note…", no rhetorical questions. Land the concept; trust the reader to keep reading.
2. **The middle varies texture every two paragraphs.** Prose → bullet list → table → prose → callout → prose. ClaudeLog does this implicitly; the reader's eye gets a new shape every screenful.
3. **The thesis is named, once, sharply.** A pull-quote. A `### The mechanism` heading. A blockquote. The reader can leave the post with one sentence in their head — and you chose which one.

If a section doesn't earn one of those three, it probably wants to be merged with its neighbour or dropped.

---

## Style — the few things that are actually rules

Most "rules" are guidelines. These are the few that aren't:

- **Backticks for every mechanic name.** Inline code, every time: `` `_` ``, `` `BlankSource` ``, `` `cue.md` ``, `` `agentically <X> _` ``, `` `@opencues/runtime` ``. The reader's eye learns to track them.
- **H1 for the title only. H2 for `STAGING NOTES` and `See Also` only. H3 for everything in the body.** No H4 in the body — if you reach for H4, the H3 above it is too broad and wants to split. (H4 is fine *inside* a STAGING NOTES sub-section; the appendix is allowed to be denser.)
- **First-person.** "I", "we", "our". The author has stake. Say so.
- **Code blocks are language-tagged.** `` ```ts ``, `` ```bash ``, `` ```yaml ``. Untagged blocks render badly and lose syntax highlighting.

Everything else — when to use bold, how many bullets in a list, whether to use an em-dash or a colon — let the post decide.

---

## Manifesto posts vs mechanic posts

The flow is the same; the *front* differs.

A **mechanic post** (`Inline Prompting`, `Inline Agents`, `Cycling`, `FluidBlank`) is about a thing the user can do. The Prior to / With spine fits naturally — you remember when it didn't exist, when it was painful, and you can show the contrast. Pick this shape unless something blocks it.

A **manifesto post** (`Disruption`, `What is Invention`, `What is Design`, `Simplicity`) is about a thesis you want to argue. The Prior to / With spine doesn't fit — there's no "before" to contrast against. Open with the thesis instead, in the same one-to-three-sentence rhythm:

> Disruption is not morally neutral. Some disruption is extractive — it destroys value held by individuals. Some is redistributive — it destroys value held by gatekeepers. Both are technically "disruption." This post is about the second.

Then the rest of the flow continues normally — context bridge, depth sections, mechanism, close.

A **stub post** is something you wanted to capture before it was fully formed. Cold-open + one or two STAGING NOTES sub-sections is enough. Don't force the full flow on an idea that hasn't earned it. ClaudeLog has eight or so stub pages; we're allowed some too.

A **dual-thesis post** runs the spine twice. *Prior to A → With A* / *Prior to B → With B*, then a comparative depth section. Rare but useful when the post's actual purpose is the comparison.

---

## Polishing an existing post

Less a checklist than a sequence of passes:

**First pass — the front.** Trim the opening to ≤3 sentences that define the thing. Move any "in recent months…" preamble down into the context bridge. If there's a gesture, surface it.

**Second pass — find the spine.** Read the existing prose. The lived-experience material is usually buried mid-paragraph. Hoist it. If the post is a mechanic, the spine wants to be `### Prior to X` / `### With X`. If the post is a manifesto, the spine wants to be a thesis-statement opener.

**Third pass — name the H3s.** Anything generic ("Overview", "Background", "Details") gets replaced with something specific and earned ("The Performance Multiplier", "The Ownership Lock", "What we deleted to get here"). If you can't name a section specifically, it doesn't have a thesis and probably wants to merge with a neighbour.

**Fourth pass — open up depth.** Add at least one of the OpenCues-only moves: § Mechanism, § Lineage, § 3-axis read. Three for flagship posts.

**Fifth pass — find the pull-quote.** The sharpest one or two sentences come out as `> …` blockquotes. If you can't find any, the post probably doesn't have a thesis yet and the depth pass needs another swing.

**Sixth pass — absorb the staging notes.** Walk every lettered note. Each one has three possible fates: **absorb** (fold it into the body — usually as a paragraph in an existing H3, sometimes as a new named H3, occasionally as a callout or pull-quote), **prune** (turned out not to matter), or **defer** (real material that doesn't fit *this* post — move it to the post that does). When this pass is done, the `## STAGING NOTES` section is gone. A re-rendered post has no appendix.

**Seventh pass — read it aloud.** Where you stumble, the prose stumbles. Cut. Rebreathe. Repeat until the rhythm carries you through.

A first migration takes ~30 minutes. A flagship post with all three depth moves and a thoroughly polished body takes one to two hours. Both are worth it.

---

## A skeleton, only because skeletons are useful

This is a *reference shape*, not a template to fill in order. Real posts add, drop, and reorder freely.

```markdown
---
title: <Title>
date: <YYYY-MM-DD>
description: <One-sentence pitch, ≤160 chars>
tags: [<tags>]
cross_links: [<related posts>]
---

# <Title>

<Cold-open. 1–3 sentences. Define the thing.>

<Activation line — only if there's a gesture.>

<Context bridge — one sentence placing this in time.>

---

### Prior to <X>

<The lived frustration. Two paragraphs max.>

### With <X>

<What changed. Two paragraphs max.>

---

### <Named H3>

<Body. Vary texture every 2 paragraphs — prose, list, table, prose.>

### <Named H3>

<Body.>

### <Named H3>            (as many as the post wants — usually 2–5)

<Body.>

---

### The mechanism

<The interesting move. One paragraph + pull-quote.>

> <Pull-quote that *is* the thesis.>

### Lineage              (when there's prior art worth naming)

<Three bullets or a small comparison table.>

### 3-axis read          (on flagship posts)

- **Start-up frames** — <one sentence>
- **Active window** — <one sentence>
- **Cool-down** — <one sentence>

---

> **Note:** <Substantive callout — version note, edge case, forward-looking caveat.
> Two per post is plenty. Don't decorate; only callout when the body would
> derail without the side-comment.>

---

See Also: [Post X](path) · [Post Y](path) · [Post Z](path)
```

A *draft* will additionally carry a `## STAGING NOTES (not yet formatted)` section above `See Also`, with lettered sub-sections capturing depth that hasn't been placed yet. The re-render absorbs all of them and the section disappears.

---

## When to deviate

The kit is a description of how posts have flowed *so far*. New post shapes will emerge. Deviate when:

- The post genuinely has a different structure (a *dialogue post*, a *transcript post*, an *index post*) — write the structure the post wants.
- The mechanic is unusual enough that the standard depth sections (Mechanism / Lineage / 3-axis) don't fit — invent the section it wants and name it specifically.
- A stub post wants to stay a stub. Don't pad it.
- The flow needs a beat the kit didn't anticipate. Add it. Then update this kit if the new beat keeps wanting to appear.

The kit's job is to give you a vocabulary — *cold-open*, *spine*, *named H3*, *mechanism*, *pull-quote*, *callout*, *staging notes* — so you can think about flow at the level of moves rather than the level of words. It's not a cage. The mechanics posts read well because the author thinks in this shape, not because the author followed a checklist; the kit is here to make that shape easier to think in, not to enforce it.

---

See Also: [Posts index](posts/README.md) · [ClaudeLog mechanics](https://claudelog.com/mechanics/) (the source of the body discipline)
