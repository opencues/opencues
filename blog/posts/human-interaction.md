# Human Interaction

As the Head of HCI at Command Stick it has been fascinating seeing the world evolve before my eyes to adapt new HCIs.

Prior to the emergence of LLM based chatbot interfaces there was an air of reluctance to adapt and learn new HCIs often due to the lack of truly revolutionally new functionality that was delivered by the new HCIs.

Regardless of this neigh endless desire to adopt AI I have observed a degree of hesitance to evolve the means through which we interface AI. This has lead to the paradigm currently being stuck in what I like to call a 'turn-based RPG' format.

In this format a user and system are made to take turns and await the other party's turn finishing before being able to communicate information.
Comparing such a format to real life communication earths the key issue with our current status quo. Humans communication is faux turn-based; for example during a speaking party's turn the non-speaking party is still able to provide 'non-verbal' cues which steer the communication of the speaking party. These non-verbal cues are critical in communication and have been developed over (objective historical time frame).

Humans employ many sorts of non-verbal cues which allow for intent, comprehension and other messages to be telegraphed to a speaking party without interrupting a speaking party's turn e.g.;

List lots of non verbal cues.

The concept of non-verbal, non-interuptive cues does not only exist in verbal communications, humans have invented novel means of extending it into a digital world.

For example when messaging someone within a WhatsApp chat we have developed a 'reaction' a means of not shuffling or distorting the chat window view whilst also allowing us to efficient express our emotions or intent. The goal being to provide subtle effective means of communicating intent without 'blocking' the communication window. This solves the issue where if every individual replied with an emoji it would nudge the chat window and make for an uncomfortable user experience.

The goal of non-blocking cues being to allow a communicating party to steer their communication during their turn. Not forcing a communicating party to have to 'end' their turn to be able to get feedback on the information they have communicated thus far.

I believe this is a significant limitation of the current AI paradigm as it requires us to engage in the back and forth which is:

- Time inefficient
- Token inefficient
- Limits the amount of use cases where the technology can be used because of the rudimentary back-forth nature of the "turn-based" chatbox paradigm.

My hope is that overtime humanity as always, invents novel ways to express themselves more fluidly and more flexibly. Thus unlocking a more natural engaging experience and as an avid gamer I hope those experiences can feel more gamified and maybe even allow me to 'get in the zone'.

---

## STAGING NOTES (not yet formatted)

### A. Fill the "List lots of non verbal cues" placeholder

Concrete non-verbal cues that humans use to telegraph information mid-conversation without taking the speaking turn:

- **Affirmative** — nodding, smiling, leaning in, sustained eye contact, raised eyebrows in interest, "mhm" / "uh-huh" backchannel sounds, tilted head of curiosity.
- **Negative / pushback** — head shake, frown, furrowed brow, shoulders tensing, leaning back, breaking eye contact, pursed lips, the "I'm about to interject" intake of breath.
- **Confusion / slow-down request** — squinted eyes, head tilt, hand raised slightly, "wait, hmm" sound, half-step back.
- **Wrap-up signals** — looking at watch / phone, glancing at the door, packing up belongings, hand on the table preparing to stand, the polite-but-firm "right …".
- **Continuation prompts** — keeping eye contact through a pause, slight forward lean, saying nothing for an extra beat — all of which signal "keep going, I am still listening."
- **Emotional colouring** — smile vs grimace, gasp vs sigh, eye-widening on surprise, a single laugh.

Each of these is a sub-second, non-blocking, modality-distinct signal. The speaker continues; the listener has communicated.

### B. Mehrabian's 55/38/7

Albert Mehrabian's research on the components of communication:

- **55%** body language
- **38%** tone of voice
- **7%** the actual words spoken

Caveat to add (Mehrabian's stat is often misapplied — it was originally about *emotional / attitude communication when channels conflict*, not all communication everywhere). Even with that caveat, the asymmetry is enormous: the *words* — the part current LLM chat captures — are the smallest channel. The other 93% is what the turn-based chat paradigm is throwing away.

### F. Why non-blocking cues actually work — the modality insight

The mechanism, from `resources/background.md`:

> The core innovation enabling [non-verbal cues] is that the non-speaking party is communicating through a different modality than the speaking party. This prevents the non-speaking party's communication from drowning out the speaking-party's communication.

Two people *speaking at the same time* produces chaos. Two people texting each other in real-time produces confusion (interleaved messages). But one person speaking + the other person nodding produces *steered* communication, because nodding does not occupy the audio channel.

This is why the WhatsApp reaction works: it occupies a separate visual layer (an icon attached to a message), not the chat-message stream itself. If everyone replied with "👍" as a *message*, the chat would jump and the conversation would become unfollowable.

The principle for AI HCI design: any non-blocking cue between user and AI must use a different modality than the user's primary input channel. If the user is typing, the system's cue can be visual (a dim, an underline, a status line) — but it cannot be a popup that takes focus, because that occupies the user's attention channel.

This is the foundational design rule that everything else in OpenCues follows from.

### H. Sharpen the "faux turn-based" critique

Current LLM chat is not just turn-based — it is *stricter* than turn-based human conversation. In many interfaces:

- The user cannot type while the model is generating (the input box is disabled).
- The user cannot interrupt mid-stream without losing all generated context.
- The model has no way to signal "I am uncertain" or "you are about to lead me wrong" partway through; it commits to a full response.
- The model cannot signal "I have understood enough, you can stop typing" — there is no way for it to communicate this until the user submits.

So we have *regressed* from human conversation rather than matched it. Faux turn-based human dialogue still has steering. LLM chat does not.

### D. The two-direction model as the productised solution

The thesis of this post — "we need non-blocking cues between human and AI" — has a concrete implementation in OpenCues:

> Two directions of intent on text:
> - **Cues** (system → user) — the LLM offers alternatives the user did not ask for. Surfaces as a dim on the word, with a tip in the status line. Sub-second, non-blocking, different modality from the user's typing.
> - **Blanks** (user → system) — the user places `_` to summon a value. The user is communicating "fill this in" without ending their typing turn.

Both surfaces share the property the post argues for: they let *both parties communicate without forcing the other to end their turn*. The user can keep typing while the system is preparing a cue. The system can offer a value while the user is still composing the surrounding sentence.

The thesis becomes: **OpenCues is what `non-blocking cues between human and AI` looks like when productised on top of an LLM.**

### E. More digital examples of non-blocking cues (for the WhatsApp reaction list)

The post uses WhatsApp reactions as one example. More worth naming:

- **Typing indicators** ("Wilfred is typing…") — system → user cue that does not interrupt.
- **Read receipts** ("seen 22:14") — passive acknowledgement.
- **Slack / Discord / iMessage emoji reactions** — same modality move as WhatsApp.
- **Google Docs presence cursors** — you can see another user's coloured caret moving in real time without the document jumping.
- **Google Docs Suggestions mode** — literally a cue system. The other party marks alternatives in a separate visual layer; the writer accepts or rejects.
- **Comments vs edits** in any collaborative editor — comments are non-blocking, edits are.
- **Zoom hand-raise** — non-blocking signal that does not interrupt the speaker.
- **Twitch / YouTube live chat** — viewers communicate to the streamer without using the streamer's audio channel.
- **Slack threads** — keep side conversations from interrupting the main channel.

Each of these is a different-modality, non-blocking signal. The pattern is universal once you start looking for it.

### I. The system → user non-blocking cue lineage that already exists in software

To pre-empt "is this novel?" — name the prior art. OpenCues sits in a lineage:

- **Spell-check red squiggle** (~1990s) — system marks a word as misspelled in a separate visual layer; user can ignore or click.
- **Grammarly underlines** — extends the squiggle to grammar / style / tone.
- **IDE inlay hints / parameter hints / type annotations** — same modality move applied to code.
- **GitHub Copilot ghost text** — system suggests completions in a faded visual layer that does not commit.
- **Browser address-bar autocomplete** — system proposes URLs; user takes one or ignores them.
- **Search engine "did you mean…?"** — gentle suggestion in a corner of the page.

OpenCues is the natural next step: extend the same pattern (system → user cue, separate visual layer, non-blocking, ignore-able) to *LLM-grade alternatives* across *any text input*, not just code or spelling. The novelty is not the pattern; it is the substrate (LLMs) and the breadth (any text input) and the addition of the reverse direction (`_` as a user-placed cue back).
