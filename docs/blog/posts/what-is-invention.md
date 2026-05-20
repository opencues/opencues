# What is Invention

As an individual with a design background I have always been enamoured with the concept of going from 0->1. Seeking out that which doesn't exist and bringing it into a reality and that is the job of an Inventor.

An invention !== innovation: An invention needs to both have inventive step, inventive merit and be novel in light of prior art.

These are the tall order which are pressed on Inventors when attempt to 'Invent'. The process overall is great means of coming up with new ideas (even if you're going to OpenSource them in the end haha).

To look at that which exists within the prior art and aspire to create that which does not exist. I get a particular kick out of it every time. I guess I could say I cheat by having a big context window for mechanics, but one of my favourite quotes from my favourite book comes to mind.

Book of Five Rings - Book of the Void reference…

When inventing I tend to co-invent with my mentor as he is the individual who got me into the craft a decade ago and I have found there are various means, techniques or tactics you can imploy to amplify your creativity. I will likely expand on this in a later article about.

I am looking forward to co-inventing with members of the OpenSource community!

---

## STAGING NOTES (not yet formatted)

### A. The Book of the Void reference filled

Miyamoto Musashi, *Book of Five Rings*, Book of the Void (Kuu no Maki). Two passages worth quoting directly — they belong together because the second defines the discipline by contrast with the first.

The bewilderment passage (what most people mistake for the void):

> "People in this world look at things mistakenly, and think that what they do not understand must be the void. This is not the true void. It is bewilderment."

The actual void:

> "By knowing things that exist, you can know that which does not exist. That is the void."

The pairing matters. Musashi is explicit that the void is not "I don't know what's there." That's confusion. The true void is what *isn't there yet but could be*, surfaced by deeply knowing what *is* there. You only see the gap by mastering the prior art around it.

This grounds the post's preceding line directly. Looking at the prior art and aspiring to create what does not exist *is* the discipline of the void. It is an old name for the inventor's job.

### D. The "big context window for mechanics" expanded

The unfair-advantage angle. The reason an experienced inventor can spot the void faster is that they carry a deeper library of prior art around in their head — and across domains, not just within their own.

For me specifically that library includes:

- Years of CommandStick gesture-system design — every failure mode of touch UIs, every successful primitive, every dead-end pattern in mobile/desktop/watch interfaces.
- Fighting-game frame theory — start-up frames, active windows, recovery, hit-confirm windows, the entire grammar of "this action commits you to that consequence."
- Patent prosecution practice — reading hundreds of HCI patents and writing them, which builds an instinct for what counts as a meaningful inventive step versus a re-skinning.
- Modern AI tooling — daily use of Claude Code, OpenCode, Chrome extension internals, the actual feel of where the bottlenecks are.

Each of these is a different shelf of mechanics. The 3-axis framework that anchors the OpenCues design did not arrive from inside HCI — it arrived because fighting-game frame theory was loaded in my head while HCI design was in front of me. The two collided and the framework dropped out.

This is why I am bullish on cross-domain pollination as a craft skill. I'll expand on this in the post on `_`-shaped people (post #13). The short version: the size of your context window across domains is the size of the void you can see.

### E. The negative-space thesis

Synthesising A and the post's preceding line:

> Invention is the discipline of seeing what is not there yet but should be.

The existing prior art is the "knowing things that exist" — and you can't shortcut it. You have to actually know the field. The void is the un-built thing the inventor's job is to surface. The inventor is not a wizard pulling things from nothing; they are someone who has loaded enough of the existing landscape into their head that the *negative space* becomes visible.

This is also why invention rewards patience. You do not see the void on day one. You see it after enough of the existing terrain has been mapped that the gaps stand out as gaps rather than just unexplored regions.

### F. Bewilderment is the enemy of invention

Standalone pull-quote / blockquote candidate, near the top of the rewritten post:

> Bewilderment is the enemy of invention.

This is not a free-standing aphorism — it is a direct read of Musashi. The bewildered person mistakes "I don't know what's there" for the void. They generate noise (vague ideas, half-formed concepts, unfocused experiments) and call it creativity. The disciplined inventor knows what's there well enough to see what's missing — and that clarity is the precondition for everything that follows.

A practical implication: when you feel bewildered while trying to invent, the move is not to push harder on the empty page. It is to go back to the prior art and study harder. The bewilderment is the signal that the existing landscape is not yet loaded deeply enough to expose the void.

### H. Sharpen invention vs innovation

The post says `invention !== innovation` but does not unpack the distinction. The cleanest version:

| | Invention | Innovation |
|---|---|---|
| What it does | Brings into existence something that was not there before | Applies an existing solution to a new context, or makes an existing solution better |
| Test | Novelty against all prior art | Improvement against the current incumbent |
| Risk profile | High failure rate, occasional 0→1 wins | Lower failure rate, incremental gains |
| Legal counterpart | Patentable inventive step | Trade dress, design patent, or no IP at all |

Both have a place. Most successful products are innovations on existing UI patterns — they are *not* worse for being innovations rather than inventions. But the inventor's specific job requires the second column to be inadequate. If a known pattern would have worked, the inventor was not needed.

A useful heuristic: if you can describe what you are building by analogy to something that already exists ("it's like X but for Y"), you are innovating. If the closest analogy distorts more than it clarifies, you are likely inventing.

### I. Patents / IP — invention as a practising discipline

Ground the abstract "invention" in the concrete practice of formal IP protection. Command Stick has been patenting HCIs for years — gesture systems, summoning behaviours, dual-finger dial controls, threshold-based command activation. Every one of these went through the legal mill of "is this novel against the prior art, does it have inventive step, does it have inventive merit?"

This is not glamorous work. It is reading other people's patents, finding the closest prior-art reference, articulating what is *different* about your own contribution and *why that difference is non-obvious*. It is a skill that compounds — the more patents you read, the faster you can spot whether a given idea has actually been invented before, or only seems familiar.

The connection to the post's main thesis: patenting *forces* you to articulate the void. You cannot draft a patent claim without naming exactly what is in your invention that is not in the prior art. The drafting discipline is the void-spotting discipline made legally explicit.

(Open question for a future article: when to patent vs when to open-source. OpenCues itself is open-source, but the specification — the file formats, the data shapes, the bidirectional cue model — is the kind of thing that would historically be patented. The choice to open-source reflects a bet on community over rent extraction. That bet deserves its own post.)
