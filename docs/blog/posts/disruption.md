# Disruption

Disruption has always been a divisive topic.

In the recent months we've all been made brutally aware of the potential and rate at which AI can disrupt or pose a threat to different jobs, businesses and traditional means of doing work.

The disruption often leads to a state of fear which makes you wonder what is the nature of disruption and what are aspects of existing jobs, businesses and traditional works flows that make them prone to disruption?

A keys aspect I honed onto is the type of 'artefact' produced by a process e.g. a job, business or service and the second bit dependencies a job, business or traditional workflow has. If a system or process has dependencies which prone to be undercut in price, efficiency, speed or deprecation there is a high chance AI wille eventually disrupt that business. Especially if a dependency within the system is rapid adopter of new technology or is not stifled by slow moving regulation.

As many modern processes output digital AI is steadily crushing all the software which exists beyond a prompt input box. Month over month new templates, skills and workflows extend AI solutions abilities to approach or even go beyond the capabilities of junior workers in various domains.

After musing what makes something 'susceptible' to being disrupted by AI I then pondered:

> How can you disrupt AI (Well, AI companies)

Well from a strategical point of view it lies in question what are the dependencies of AI companies:
LLM models - Open source models
Means of distribution - Having better distribution channels than the LLM models
Regulation - Not very reliable and it seems to be slow moving, I don't think you can put the genie back into the bottle (Nor do I want us to)
(Claude add more suggestions)

From a HCI perspective I stumbled across an interesting dependency, the prompt box input.

Every LLM chatbox provider utilise a prompt input box as a means of delivering a query. The input box is gateway into where a service begins delivering value to a user. Prior to the 'enter' button being pressed no jobs have been replaced, no tokens are burnt. (Claude add better phrasing if necessary).

Products and services are engineered from the ground up to steer you towards a specific services text input box. This goes beyond the concept of LLM chatboxs; it apples to:

Google Searchbar
Chrome Omnibar
Windows Task Bar search
(Claude like 9 examples)

Apparentness, ease of use and blah… are all optimised to ensure a user has easy access to these gateways to services. For Google for example the search bar generates (Claude finish) revenue for them. They pay apple N billion a year to be the default search bar. (ClaudeProvide other relevant anecdotes or parallel examples regarding search bars).

(Probably want to explain what Inline Prompting is)
During the development of Inline Prompting I realised there is room for what I'd call 'prompt hijacking'. So within the input box of one service utilising the services of another service. This could be done for various reasons such as to:
Refine the prompt prior to submitting it to the main text input target
Save tokens
Get the answer more faster
Source additional information via other means prior to executing a costly prompt. (e.g. stock prices via API instead of asking an LLM to do the expensive lookup)
Protect the context window of an LLM by performing rudimentary queries inline.
(Claude separate hijacking examples from general uses for Inline Prompting examples)
(Claude add more benefits of both services)

(Claude explain how Inline Prompting disrupts the existing services, due to essentially using any input box as a surface. It removes the need for gating or explicit steering a user towards a page, region of the screen ect).

It will be interesting to see how things turn out, it would be nice to see AI being disrupted, not just the little man.

---

## STAGING NOTES (not yet formatted)

### A. Sharpen the susceptibility heuristic — artefact + dependencies + dependency traits

The post sketches a framework but does not name it cleanly. The full thing is a 3-part test, and worth elevating to a callout near the top:

> A process is susceptible to AI disruption when (1) its **artefact** is digital and substitutable, (2) its **dependencies** are themselves at risk of being undercut in price/speed/efficiency, and (3) those dependencies are *fast adopters* of new technology and not shielded by slow-moving regulation.

The three filters compose. Lose any one and the process is much harder to disrupt:

- Physical-artefact processes (plumbing, dentistry, in-person carpentry) fail filter 1.
- Digital-artefact processes whose key dependencies are stable, slow, or regulation-moated (clinical trials data pipelines, FDA submissions, audit attestations) fail filters 2 or 3.
- Digital-artefact processes whose dependencies are themselves software products that ship monthly (most SaaS workflows, a lot of junior-knowledge work) score yes on all three. These are the ones being eaten right now.

The framework doubles as a design tool: if you are *building* something and want it to be defensible against AI disruption, deliberately engineer at least one filter to fail.

### B. AI-company dependencies, expanded — fills `(Claude add more suggestions)`

The post lists three (open-source models, distribution, regulation). The fuller list, ordered roughly by how much leverage a competitor could extract from each:

| Dependency | Why it's a lever | What "disrupting" it would look like |
|---|---|---|
| LLM model quality | Today's moat. Shrinking — open-weights catching frontier ~6–9 months behind. | A frontier-grade open model + cheap inference makes "ChatGPT-quality" a commodity. |
| Distribution channels | Owning the surface the user types into. The post's central insight. | Inline Prompting, browser-native AI, OS-level AI — bypassing the gated chatbox entirely. |
| Compute & supply chain | GPUs, fabs, and the energy to run them. Concentrated bottleneck. | Cheaper inference hardware (custom silicon, neuromorphic, optical) or abundant power (geothermal, nuclear). |
| Training data | High-quality data is being paywalled, gated, poisoned. | Synthetic-data breakthroughs, or a defensible private corpus the incumbents can't access. |
| Talent | Small, mobile pool of researchers. Concentrated, poachable. | A competitor that hires the right 50 people effectively forks the frontier. |
| Trust & brand | One bad incident and users move overnight. Switching cost ≈ zero. | A privacy or safety scandal that reroutes traffic — and there is no lock-in to slow it down. |
| Regulation | Slow-moving, currently weak as a lever (post's own read). | Genuinely the weakest moat for incumbents and the weakest lever for challengers. Don't bet on it. |
| The prompt input box | Owning the toll booth. Today this is what funds the whole industry. | This post. Inline Prompting. |

Ordering matters: the post should lead with the input box and treat the rest as supporting context, because the input box is the dependency that *Inline Prompting actually attacks* — the others are general industry observations.

### C. Phrasing fix — `(Claude add better phrasing if necessary)`

Original: *"Prior to the 'enter' button being pressed no jobs have been replaced, no tokens are burnt."*

Tighter version:

> Until the user presses **enter**, nothing has happened. No tokens are burned, no jobs are touched, no revenue is earned. The input box is the toll booth — and whoever owns the toll booth owns everything downstream of it.

The original is fine; the rewrite earns its keep by introducing the "toll booth" metaphor, which is then central to section I (the disruption mechanism).

### D. The full list of input-box gateways — fills `(Claude like 9 examples)`

Beyond the three the post names (Google search, Chrome Omnibar, Windows Taskbar). Aim is to show that the pattern is universal — *every modern app has one*:

- **Google search bar** — the primordial example. Ad revenue ≈ Alphabet's main business.
- **Chrome Omnibar** — Google again, fused with the browser address bar.
- **Windows Taskbar search / Spotlight (macOS)** — OS-level input boxes that route to web search.
- **Safari address bar** — Apple's gateway, which is why Google pays so much to be its default (see E).
- **Voice assistants (Siri / Alexa / Google Assistant)** — the *spoken* prompt box. Same primitive in a different modality.
- **Slack `/` commands, Discord `/` slash menu** — workplace input boxes optimised for in-app dispatch.
- **VS Code command palette, JetBrains "Search Everywhere"** — IDE input boxes that have completely replaced menu-driven UI.
- **Notion `/` menu** — productivity-tool input box that makes every action a typed phrase.
- **Figma quick actions, Linear `Cmd+K`** — modern SaaS apps shipping a global command bar as a flagship feature.
- **Amazon search bar** — proof that a non-LLM input box can be a $1T+ business if you own the right one.
- **App Store / Play Store search** — the gateway to *every other app* you'll install. Apple/Google's most undervalued moats.

Eleven on purpose — gives the editor room to drop the two weakest. The pattern: whoever owns the input box owns the value chain downstream.

### E. Search-bar economics — fills `(Claude finish)` and `(ClaudeProvide other relevant anecdotes...)`

The Google revenue figure: Alphabet's search-ads business generated roughly **$200B+ per year** as of recent reporting — the bulk of the company's revenue and the single most valuable advertising surface in human history.

The Apple deal: Google reportedly pays Apple **~$20 billion per year** to remain the default search engine in Safari (DOJ antitrust trial testimony, 2023). That is *one fifth of one trillion-dollar company's annual profit, paid to another, just to keep the default slot in one browser's address bar*. The number is the strongest possible evidence for the post's thesis — owning the input box is worth 11-figure annual rents.

Parallel anecdotes worth weaving in:

- **Mozilla / Firefox** — funded almost entirely by default-search payments (historically Google, briefly Yahoo). Without that revenue stream the browser likely dies. The default-search slot is *the entire business model* of an independent browser.
- **Amazon vs. Google product search** — over the 2010s Amazon quietly captured >50% of US product searches (eMarketer estimates) by making *its own search bar* the default for shopping intent. Google responded with Shopping ads — defending the input box was an existential fight.
- **Bing's $10B+ subsidy** — Microsoft has reportedly burned over $10B in cumulative losses keeping Bing alive across two decades, just to retain *some* search-bar presence. Owning even 3% of an input box is worth billions.
- **TikTok as a search engine** — Gen Z increasingly queries TikTok's input box first for restaurants, recipes, products. Google publicly acknowledged this as an existential threat in 2022. The threat wasn't a better algorithm; it was *another input box capturing the same intent earlier in the funnel*.
- **Perplexity / Arc Browser** — recent-era examples of products explicitly built to compete on the *input box itself*, not on the answers behind it.

The cumulative point: the most valuable real estate in software is not models, not data, not users. It's the box the user types into.

### F. What is Inline Prompting — fills `(Probably want to explain what Inline Prompting is)`

Pull from post #4 (Inline Prompting / Blank). One-paragraph definition for readers who haven't read that post:

> Inline Prompting is the idea that the text input you're already typing in — *any* text input, in any app — can itself be a prompting surface. Instead of context-switching to a chatbot, copying a half-finished sentence, getting an answer, and pasting it back, the LLM call happens **inline**: in the same field, on the same caret, mid-sentence. The text box you are already in becomes the prompt box. The summoning primitive is one character (`_`) on every keyboard, dispatched contextually by the words around it.

Cross-link explicitly to post #4 for the full mechanics (FluidBlank, TransformBlank, the priority chain, ownership lock).

### G. Hijacking vs general Inline Prompting use — fills `(Claude separate hijacking examples...)`

The post conflates two related but distinct things. Worth splitting.

**Prompt-hijacking** — interposing on a *host service's* input box to do something the host didn't intend. The host (ChatGPT, Claude, Gemini, etc.) sees a normal keystroke stream; the user sees an LLM-augmented field. Examples:

- **Refine before submit** — the user types a vague prompt; OpenCues' `prompt _` rewrites it into a sharper one *before* the user hits enter, saving the host service from a bad query and the user from a bad answer.
- **Resolve cheaply, never send** — `4 * 12 = _` resolves locally to `48`. The host LLM never sees the math problem. Tokens saved, latency gone, context window protected.
- **API instead of LLM** — `nvda _` returns `$136.45` from the Finnhub API in ~150ms. Asking the host LLM the same question takes ~1500ms, costs tokens, and may hallucinate (LLMs don't have live stock prices). The hijack is a strict win on every axis.
- **Pre-fill factual context** — `population of france _` → `~68 million` lands inline before the user composes the rest of their question, so the host LLM never has to look it up.
- **Protect context window** — chained `_` lookups resolve out-of-band so the host's conversation history isn't polluted with low-value retrieval round-trips.

**General Inline Prompting (no hijacking involved)** — using the same primitive in fields that aren't an LLM input box at all:

- Filling a math result into a Notion doc.
- Auto-correcting spelling in a Slack message before send.
- Translating a phrase mid-sentence in a Gmail draft.
- Running `make this formal _` over a draft email body.
- Continuous editing via `agentically <task> _` in any text field (post #5).

The key difference: hijacking specifically *re-routes intent away from a host LLM service*. General Inline Prompting just adds AI capability to a field that didn't have it. Both ride the same `_` primitive; only the first one disrupts.

### H. Benefits — fills `(Claude add more benefits of both services)`

Split by which service we're talking about.

**Why a user prompt-hijacks:**

- **Money** — local resolution costs ~$0; LLM-host resolution costs tokens.
- **Speed** — APIs and local computation in 100–300ms; host LLMs in 1–5s.
- **Accuracy** — APIs are exact; LLMs guess. For factual data this is a one-way ratchet.
- **Privacy** — sensitive substitutions can resolve on-device without ever entering a host's logs.
- **Token-budget hygiene** — long conversations stay focused; the host's context window doesn't fill with retrieval noise.
- **Determinism** — `volume _ → 50%` is the same answer every time; LLMs are not.
- **Control** — the user picks what gets hijacked vs. forwarded. The host is unaware.

**Why Inline Prompting (the broader pattern, beyond hijacking):**

- **No context switch** — hands stay on the keyboard, eyes stay on the sentence (post #16 / seamless integration).
- **Composability** — small, cheap LLM calls stack inside a single field, each doing one thing well, instead of one giant monolithic prompt.
- **Surface-portable** — the same primitive runs in any text input, on any host. The user learns it once, uses it everywhere.
- **Discoverability without UI bloat** — no new buttons, no menus, no modals. The capability surfaces in the text the user is already writing.
- **Visible failure** — if the system can't fill a `_`, the `_` stays. No silent failures (post #4 / section N).
- **No vendor lock-in** — the LLM provider is a config switch, not an architectural one.

The two lists overlap deliberately. Hijacking is a *tactical use* of Inline Prompting against a specific competitor; the broader benefits apply regardless of whether a host service is being routed around.

### I. How Inline Prompting disrupts existing services — fills `(Claude explain how Inline Prompting disrupts...)`

Here is the disruption mechanism, made explicit. This is the *thesis* of the post and should land hard at the end of the body, before the closing line.

Every existing AI product is engineered around the assumption that *its* input box is the one the user types into. Their entire stack rests on that single primitive: **make the user come to our box.**

- Their **product strategy** (a polished chat UI) is the box.
- Their **distribution deals** (default-search payments, OS partnerships, browser deals) protect the box.
- Their **revenue model** (per-query monetisation, ads, subscriptions) is metered through the box.

Inline Prompting collapses the assumption. If *any* text field — your editor, your email client, your Slack message, your terminal, your Notion doc — can become a prompting surface, then the gatekeeping disappears:

- There is no page to drive traffic to.
- There is no default-search slot to pay $20B for.
- There is no funnel to optimise.
- There is no "open the chatbot" friction to engineer around.

The "prompt box" becomes ambient — wherever the cursor is, the prompt is. The toll booth dissolves.

This is **structural disruption, not feature disruption**. It does not compete with ChatGPT on model quality, on UX polish, or on price-per-token. It competes by making the gateway itself irrelevant — by turning every text input on the user's machine into a viable surface for AI value delivery. The moat (owning *the* input box) gets routed around because there is no longer *the* input box.

The historical parallel is RSS vs. portals in the late 90s/early 00s. Portals (Yahoo, AOL) tried to be the page you visited to read everything. RSS made every page deliverable to a reader of your choice. The portal moat eroded not because someone built a better portal, but because the *idea of a portal* stopped being structural. Inline Prompting is RSS for prompts.

### J. Why regulation isn't the lever — sharpen the post's offhand line

The post says regulation is "slow moving" and "I don't think you can put the genie back in the bottle." Worth making the structural case rather than just the personal one.

- Regulation moves on the timescale of years; AI capability moves on the timescale of months. Any rule written today is regulating a model two generations behind by the time it's enforced.
- Regulation is local; models are global. EU rules don't bind US labs; US rules don't bind Chinese labs; open-weights models bind no one.
- Open-source model weights cannot be unshipped. Once `Llama-N` is on HuggingFace, every regulator on earth could vote to ban it tomorrow and it would still be on a million laptops the day after.
- The dependencies that *are* susceptible to regulation (training data sourcing, deployment in regulated industries) only constrain *deployment*, not capability. The genie is out; we are now arguing about which rooms it can enter.

Implication for the disruption thesis: betting on regulation to disrupt AI companies is betting on the slowest, weakest, most easily-routed-around dependency in the stack. The bet that *does* pay off is competing on the dependencies the incumbents can't move fast enough to defend — which brings us back to the input box.

### K. Sympathetic disruption — disrupting AI ≠ disrupting workers

The closing line ("disrupt AI, not just the little man") deserves a paragraph of unpacking, because there is a real ethical claim hiding in it.

Disruption is not morally neutral. Disruption that destroys value held by individuals (jobs, expertise, livelihoods) is *extractive*. Disruption that destroys value held by concentrated incumbents (platform rents, gatekeeping moats, distribution monopolies) is *redistributive*. Both are technically "disruption." They are not the same thing.

Inline Prompting is in the second category by construction. It does not put anyone out of work — the LLM was already doing that. It does, however, route around the rent-extracting layer that sits between the LLM and the user. The capability remains; the toll booth dissolves. The user wins; the worker is no more disrupted than they already were; the toll-booth-owner loses.

That is the kind of disruption worth wanting. Not all disruption is.

### L. Cross-links

- **Post #4 (Inline Prompting / Blank)** — the canonical reference for *what* Inline Prompting is and how `_` dispatches contextually. Section F should cross-link explicitly.
- **Post #5 (Inline Agents)** — the natural extension of this thesis. If Inline Prompting dissolves the input box, Inline Agents dissolve the *invocation* itself — the LLM runs continuously in the background of the user's draft. Same disruption mechanism, one step further.
- **Post #16 (Seamless integration)** — the design discipline that makes Inline Prompting feel inevitable. "No side-effects on existing workflows" is *why* a hijacked input box doesn't feel intrusive — there are no side-effects on the host's UX, by construction.
- **Post #1 (HCI / start-up frames)** — the framework that explains *why* the input box's start-up cost is the disruption surface. Every existing AI service has high start-up frames (open the app, click into the box, wait for focus); Inline Prompting has zero (the box is already where the cursor is).

The four posts together form a coherent argument: **start-up frames are the moat (post #1) → Inline Prompting eliminates them (post #4) → Inline Agents extend the elimination to invocation itself (post #5) → seamless integration is the discipline that keeps the elimination clean (post #16) → and that's how you disrupt AI (this post).**
