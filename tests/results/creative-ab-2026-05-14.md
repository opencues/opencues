# Creative A/B — Groq gpt-oss-120b vs Gemini 3.1 Flash Lite

Generated: 2026-05-14T01:47:58.939Z
Temperature: 0.7 (both)

## Verdict — 4-1 to Gemini

| Prompt | Winner | Why |
|---|---|---|
| poem-autumn | **Gemini** | Cicadas "snapped like a wire", sun "pale as a fingernail", "spider's geometry" — fresher images, one sustained voice. Groq reads like a checklist of autumn nouns (tomatoes + pumpkin + marigold). |
| email-resignation | **Groq** | Practical win. Gemini left `[Date]`, `[Last Name]`, `[mention a specific project]` placeholders — a template, not a draft. Groq committed to specifics (May 28, Sam Patel, concrete transition plan). |
| love-letter | **Gemini** | "I'm still choosing you" is earned; "seen me at my most capable and my most fractured" sounds like an actual person. Groq slips into Hallmark register ("the person who makes ordinary days feel extraordinary"). |
| short-story-opener | **Gemini** (clear) | Names the town (Oakhaven), names the woman (Elena), commits to season and incident in sentence one ("face-down in the weeds, a splintered casualty of the December gale"). Decisive closing motion. Groq is atmosphere with no character or action. |
| birthday-toast | **Gemini** (narrow) | One sustained anecdote (geodesic tent in a windstorm) that earns its sentiment; Groq throws four disconnected gags. Groq might land louder at an actual party though. |

**Pattern**: Gemini *commits* — to a single image, character, anecdote. Groq tends to collage details, which scans well on a first read but feels assembled on a second. For poetry / fiction / intimate writing, Gemini's interior voice is more consistent.

The one Groq win is the *transactional* creative task — Groq produced a ready-to-send resignation email; Gemini produced a fill-in-the-blanks template. For OpenCues' "creative-leaning utility" surfaces (drafts, professional notes), Groq's bias toward concreteness is an asset.

## Latency

| Prompt | Groq (ms) | Gemini (ms) | Ratio |
|---|---:|---:|---:|
| poem-autumn | 510 | 1279 | 2.5× |
| email-resignation | 540 | 1286 | 2.4× |
| love-letter | 660 | 1847 | 2.8× |
| short-story-opener | 537 | 1714 | 3.2× |
| birthday-toast | 885 | 2730 | 3.1× |

Groq is **2.4-3.2× faster** across all creative tasks. The gap holds on longer outputs (the toast, 4 paragraphs) because output tokens dominate and Gemini's tok/s on the Flash Lite tier appears lower than Groq's hardware-accelerated throughput.

## Why "gpt-oss-120b is doing so well" on the prior bench

The earlier speed-accuracy benchmark is mostly *recognition + format-following*:
- Word cues: 3 synonyms in `index:alt,alt,alt`.
- Fluid blanks: one-word factual answer.
- Short transforms: apply a deterministic edit.

These are tasks where a fast 120b model under strict output-format constraints looks indistinguishable from a more thoughtful one — there's barely any creative latitude to waste. The earlier bench measures whether the model **understands the task and emits the right tokens**. Both models do.

Where 120b shows its limits is **long, open-ended generation**: it doesn't commit, it composes from patterns, and the seams show on close reading. Gemini's reasoning-aware tier (even at think:low) engages more with the *aesthetic* dimension of the task — which doesn't move the needle on the prior bench at all, but is the whole game on this one.

## Caveats

- N=5, single-trial, one judge (me).
- Temperature 0.7 — non-deterministic. Re-running would shuffle details; pattern likely holds.
- "Creative quality" is subjective. My taste leans literary (specificity, voice, restraint); someone optimizing for warmth, punchline density, or floweriness might score these differently.

---



---

## poem-autumn

**Prompt:** Write a short poem (8-12 lines) about the first morning of autumn after a hot summer. Use concrete imagery; avoid clichés like "leaves falling" and "crisp air".

### Groq · gpt-oss-120b · 510 ms

```
Amber light spills over the cracked garden wall,  
a lone sparrow perches on a rust‑tinted fence post,  
its song threading through the lingering heat of yesterday.  

Steam rises from a puddle where the sprinkler once sang,  
mirroring the sky's first shy, violet streaks.  

A farmer lifts a basket, the weight of sun‑baked tomatoes shifting,  
while a wind‑whipped pumpkin rolls, leaving a faint, earthy trail.  

Morning dew clings to the edge of a wilted marigold,  
each droplet a tiny lantern trembling in the new light.
```

### Gemini · 3.1 Flash Lite (think:low) · 1279 ms

```
The porch swing shudders in a sudden draft,
chilled metal biting the backs of my knees.
The heavy hum of cicadas has snapped like a wire,
leaving the thicket to settle in silver silence.
Dew clings to the spider’s geometry,
a cold, unmoving weight on the porch rail.
I pull a wool sweater over my shoulders,
the fabric smelling of cedar and deep, dark earth,
while the sun, thin and pale as a fingernail,
refuses to burn the frost from the clover.
```


---

## email-resignation

**Prompt:** Draft a resignation email from a senior software engineer named Sam to their manager Priya, after 4 years at the company. Leaving for a startup. Warm but professional. 120-180 words.

### Groq · gpt-oss-120b · 540 ms

```
Subject: Resignation – Sam Patel

Hi Priya,

I hope you’re well. After much consideration, I’m writing to formally resign from my position as Senior Software Engineer, effective two weeks from today (May 28, 2026). I’ve been fortunate to spend the past four years at [Company Name], learning from an exceptional team and contributing to projects that I’m truly proud of.

I’ve accepted an opportunity with a startup where I can explore new challenges and broaden my technical leadership experience. This was not an easy decision, as I deeply value the mentorship, collaboration, and supportive culture you’ve fostered.

Over the next two weeks I’ll do everything I can to ensure a smooth transition—handing off my current work, documenting key processes, and assisting in onboarding a successor. Please let me know how I can best support the team during this period.

Thank you for the guidance and opportunities you’ve provided. I look forward to staying in touch and wish the team continued success.

Warm regards,  
Sam Patel
```

### Gemini · 3.1 Flash Lite (think:low) · 1286 ms

```
Subject: Resignation - Sam [Last Name]

Dear Priya,

Please accept this email as formal notification that I am resigning from my position as a Senior Software Engineer. My final day will be [Date].

Deciding to move on after four incredible years has not been easy. I have truly valued the opportunities I’ve had to grow, solve complex technical challenges, and collaborate with such a talented team. I am incredibly proud of what we have accomplished together, particularly [mention a specific project or achievement].

I have decided to take on a new challenge at an early-stage startup, as I am eager to explore a different scale of engineering and product development. 

I am committed to ensuring a smooth transition during my final weeks. I am happy to assist in documenting my current workflows, handing over ongoing projects, and training team members to ensure no momentum is lost.

Thank you for your mentorship and support. I wish you and the team continued success.

Best regards,

Sam [Last Name]
```


---

## love-letter

**Prompt:** Write a love letter from a person who has known their partner for 12 years to mark their wedding anniversary. Specific to the relationship — reference something they've survived together (a hard year, a move). Avoid romance-novel clichés. ~200 words.

### Groq · gpt-oss-120b · 660 ms

```
My love,

Twelve years ago we stood on the brink of something uncertain, each of us carrying the weight of our own histories while daring to imagine a shared future. Since then, we’ve built a life together—not with grand gestures or cinematic moments, but with the quiet perseverance of two people who choose each other day after day.

I still remember the winter we moved across the country, boxes spilling onto the floor of a cramped apartment, the heater sputtering, and the endless list of “to‑dos” that seemed impossible to finish. We learned to find humor in the chaos, to lean on each other when the cold seeped through the walls, and to celebrate the small victories—a working dishwasher, a warm meal after a long day, a sunrise viewed from our tiny balcony. That year tested us, and it taught me that love isn’t a feeling that flares and fades; it’s the steady hand that steadies you when the world tilts.

As we mark another anniversary, I’m grateful not for the perfection of moments but for the imperfect, lived‑in ones that have shaped us. Thank you for being my anchor, my confidant, and the person who makes ordinary days feel extraordinary.

Forever yours,
[Your Name]
```

### Gemini · 3.1 Flash Lite (think:low) · 1847 ms

```
Twelve years. It feels like a lifetime and a single afternoon all at once. When I look at you, I don’t just see the person I married; I see the history we’ve built, brick by brick, through every version of ourselves.

I still think about that year we spent in the cramped apartment across town, the one with the drafty windows and the radiator that never stopped hissing. We were broke, exhausted, and navigating that impossible transition when everything seemed to be pulling us in different directions. Most people might have folded under the weight of that uncertainty, but we just got quieter, steadier, and closer. We learned that "us" wasn't a static thing, but something we had to choose and refine every single morning.

Thank you for being the person who stayed when the path wasn't easy. You have seen me at my most capable and my most fractured, and you have never once made me feel like I needed to be anything other than who I am. 

I don’t need grand gestures to know we’re solid. I just need another year of our quiet, consistent life. Happy anniversary. I’m still choosing you.
```


---

## short-story-opener

**Prompt:** Write the opening 150 words of a literary short story set in a small coastal town in winter. A woman returns home after twenty years. Show, don't tell. Strong first sentence.

### Groq · gpt-oss-120b · 537 ms

```
The wind slammed the shutters against the cracked plaster, a ragged applause that made the house shiver. Sea‑foam scent clung to the air, curling around the rusted lanterns that still flickered on the porch, their light trembling like a memory half‑remembered. She stood on the sand, boots sinking into the cold, damp grit, and watched the gulls wheel in tight circles, their cries slicing through the gray hush. A thin ribbon of fog rolled in from the harbor, swallowing the pier and the weathered boats that bobbed like forgotten toys. Her fingers brushed the weathered railing, the wood rough under her skin, and a single gull landed, cocking its head as if recognizing a face it had never seen. Inside, the hearth lay cold, the iron kettle untouched for years, while a single candle sputtered in the kitchen window, waiting for a hand to light it again.
```

### Gemini · 3.1 Flash Lite (think:low) · 1714 ms

```
The salt-crusted sign for Oakhaven lay face-down in the weeds, a splintered casualty of the December gale. Elena stepped off the bus, her boots sinking into a slush of gray sand and melting frost. The air here didn’t just bite; it tasted of rusted iron and dead kelp, a sharp, familiar bitterness that clung to the back of her throat. Twenty years had done nothing to soften the jagged silhouette of the lighthouse, still blinking its rhythmic, jaundiced warning against a bruised horizon. She tightened her coat, the wool dampening instantly under the weight of the sea mist. Down the street, the shuttered storefronts rattled in their frames, each groan a hollow echo of a childhood she had spent a lifetime trying to outrun. She took a breath, the cold searing her lungs, and turned toward the dark, churning line where the Atlantic met the frozen pier.
```


---

## birthday-toast

**Prompt:** Write a 4-paragraph birthday toast for a friend turning 40. Funny but tender, no clichés about getting old. Reference a specific shared memory (you invent the detail).

### Groq · gpt-oss-120b · 885 ms

```
Ladies and gentlemen, gather ‘round and raise your glasses to the one person who proved that 40 isn’t a number—it’s a badge earned after surviving my infamous “midnight karaoke marathon” in that cramped downtown bar, where we both discovered that my rendition of “Bohemian Rhapsody” could shatter glass and that you, dear friend, have the patience of a saint for putting up with it.

Remember that night when the bartender handed us a “mystery cocktail” that turned out to be nothing more than orange juice with a splash of regret? We toasted to “future adventures,” and the next morning we woke up with a hangover that felt like a drumline marching through our heads, yet we still managed to finish that 12‑hour hike up Eagle Ridge—proving that if we can survive a questionable drink and a chorus of off‑key notes, we can conquer anything.

Now, as you step into this fabulous new chapter, let’s celebrate the things that truly matter: the way you still manage to find the perfect meme for any situation, your uncanny ability to remember everyone’s birthdays (except my own, which I’ll forgive you for), and the fact that you’ve mastered the art of turning ordinary moments into unforgettable stories—like that time we accidentally entered a salsa competition and ended up winning third place for “most enthusiastic footwork.”

So here’s to you, my partner in crime, my confidante, the person who makes every day feel like an improv show where the script is written in laughter and love. May the next 40 years be filled with more spontaneous karaoke, mystery cocktails that actually taste good, and countless new memories that we’ll later recount with the same mischievous grin. Cheers!
```

### Gemini · 3.1 Flash Lite (think:low) · 2730 ms

```
They say that forty is a milestone, but honestly, looking at you, it just feels like the moment the plot finally starts to thicken. We’ve spent the better part of two decades navigating the messy, unpredictable drafts of our lives, turning every misstep into a story we’d eventually laugh about over a drink. You’ve managed to arrive at this decade with more grace than I thought possible, considering the sheer volume of questionable decisions we’ve made together.

I still think about that weekend in the high desert when we tried to assemble that elaborate, "easy-to-build" geodesic dome tent during a windstorm. Within ten minutes, we were trapped under a tangle of nylon and aluminum poles, laughing so hard we couldn't breathe, while the local wildlife watched us like we were a failing comedy troupe. That night, huddled in a heap of fabric under the stars, I realized that I didn’t care if we ever figured out the tent, as long as we were the ones stuck inside it.

That’s the thing about you—you have this rare ability to turn a disaster into an adventure, and a regular Tuesday into a memory worth keeping. You possess a quiet, steady kindness that has anchored me through my own chaotic chapters, even when I was too stubborn to ask for the help. You aren’t just a friend; you are the person who makes the world feel a little less daunting and a lot more vibrant.

So, here’s to the decades behind us and the far more interesting ones ahead. May your forties be defined by the same curiosity and humor that brought us to this table tonight. I am incredibly proud of the person you are today, and I consider it a genuine privilege to be the one holding the glass next to yours. To forty, and to everything we haven't even thought of yet.
```
