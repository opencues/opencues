# Flow state

As someone who can code yet has vibecoded my way through prototypes of various projects I have shared in what many developers have described as the lack of 'flow' when developing.

The flow state being… (definition of flow from video game)

The balance between a challenge and ther user's ability to meet a challenge being optimal results in a state of flow where performance is peak and a user finds themselves in a somewhat 'high' state of mind where your sense of time is warped.

LLMs have objectively robbed me of this pleasure when I am programming, however when designing, inventing or writing I can still find myself in a flow state.

This begs the question of what aspect of the LLM programming robs us of the flow state. I believe it is the lack of rapid feedback loop in which we are a participant. The rush and thrill of conceptualising and input executing it and then responding to a system's feedback on your input, judging if it is a success or failure and adapting future inputs accordingly. This tight feedback loop is what accentuates us towards a state of 'flow'. Agentic programming is an unengaged process, which is slow and turn based so it is the antithesis of 'flow'.

However just because agentic programming is the antithesis of 'flow' it does not mean all agentic processes need bare the same fate.

Through my exploration of Inline Prompting and Inline Agents, I believe we will be able to find new use cases where we can work hard in hand with an LLM in a rapid fashion with a tight enough feedback loop.

I hope in time we are able to discover new use cases or workflows where individuals can experience flow in their lives. That is one of my aspirations as a HCI designer.

---

## STAGING NOTES (not yet formatted)

### A. Fill `(definition of flow from video game)`

The game-design reference is **Jenova Chen's flow-channel diagram** (from his Master's thesis on flow in interactive entertainment, the same work that became the *flOw* game and informed *Journey*). Two axes:

- Y axis: **challenge** of the activity
- X axis: **ability** of the player

Flow lives on the diagonal between two failure modes — anxiety (challenge too high for current ability) above the diagonal, boredom (challenge too low for current ability) below. The good game design move is to escalate challenge as ability grows so the player stays in the channel.

This is the lens game designers actually use. Rhythm games use it explicitly (escalating BPM, more notes per beat). Souls-likes use it implicitly (each boss calibrated to the player's growing skill). Tetris makes the falling pieces faster as you survive longer, keeping you on the channel.

Originally from Mihaly Csikszentmihalyi's psychology research in the 1970s — the game-design version is downstream of that work — but for a post that opens "definition of flow from video game," Chen is the right citation.

### B. Csikszentmihalyi's eight conditions

The original psychology framing, useful as a checklist for "is this experience actually flow-inducing":

1. Clear goals at every step.
2. Concentration on a limited field of activity.
3. Loss of self-consciousness.
4. Distorted sense of time.
5. Direct, immediate feedback.
6. Balance of skill and challenge.
7. Sense of personal control.
8. Action is intrinsically rewarding (autotelic).

Worth pinning early in the post because the rest of the argument can be traced row-by-row through this list. Agentic programming fails (1), (5), (7) most clearly. The user does not have clear goals at every step (the agent does). Feedback is delayed (the agent runs for seconds to minutes). Personal control is reduced (the user is delegating).

### C. "You can't flow if you're not the agent"

The strongest original insight in the post. Worth elevating into its own callout / blockquote:

> Flow requires the user be the agent of action.

Agentic programming inverts this. The system is the agent. The user is the observer. The user might still be in the chair, still typing prompts, still nominally directing — but the *unit of work* is happening on the other side of the API. The user has stepped out of the action and into the role of supervisor.

Supervision can be skilled work. It can be valuable work. But it is not flow work, because Csikszentmihalyi's condition (7) — sense of personal control over the action — is gone. You can be a great supervisor of a system you have no flow connection to.

This is also why agentic programming feels *tiring* in a way that hands-on programming does not. Supervision uses different cognitive faculties (judgement, evaluation, course-correction) that fatigue differently from action.

### D. The 3-axis framework applied to flow

The framework from post #1 (start-up frames / active window / cool-down) is, read another way, a flow-preservation toolkit. Each axis maps directly to a Csikszentmihalyi condition:

- **Long start-up frames break flow** — the user has to switch surface, leave their region of interest, summon the tool. Breaks (3) loss of self-consciousness and (4) time distortion.
- **Active window that blocks breaks flow** — the user has to wait. Breaks (5) immediate feedback.
- **Cool-down that requires returning to your region breaks flow** — the user has to navigate back to where they were. Breaks (3) and (7).

A HCI / HAII that scores low on all three axes is, almost by construction, a flow-friendly interface. The framework is not just an evaluator; it is a checklist for whether the design will let users flow.

### F. Why writing, designing, and inventing still flow — but agentic programming does not

The post observes this asymmetry. The reason worth naming:

The activities that retained flow are ones where the LLM is *assisting* rather than *replacing*. When I am writing, the LLM offers cues — alternative phrasings, factual checks, format suggestions — and I take or leave them while continuing to write. I am still the agent. My fingers are still on the keys. The work is mine; the LLM is augmenting my speed and reducing the friction at the edges.

When I am agentically programming, I have delegated. The LLM is the agent now. My role has shifted to specification, supervision, and review. None of those roles are the action — they are *about* the action. The action happens on the other side of the API call.

Cue-style HAII keeps flow because it preserves agency. Agent-style HAII (in the standard chat-and-tools sense) breaks flow because it transfers agency. The future of flow-friendly HAII is in HAII modes where the user *remains the agent* and the AI augments rather than executes — Inline Prompting and Inline Agents are bets on exactly that mode.

### G. Define "vibecode" once

Recurring Wilfred term. Worth pinning a working definition:

> **Vibecode** — to write code by directing an LLM without deeply engaging with the produced output. The user names what they want, the model produces it, the user accepts or course-corrects on the basis of the output's *vibe* rather than line-by-line comprehension.

Vibecoding gets work done. It is also explicitly *not* flow programming. The vibecoder is supervising; the flow programmer is in the action. Both are valid; they are not the same.

The post's argument depends on this distinction. Vibecoding is the modal AI-programming experience today. The post is asking what HAII modes preserve flow programming as a possibility.

### H. Tight feedback loops as the mechanism of flow

Drawing the link the post sketches:

What rhythm games, fighting games, action games, and live coding all share: the feedback latency between user input and system response is *milliseconds*. The user sees the consequence of their action before the next decision is made. They steer continuously.

What turn-based RPGs, email exchanges, and standard agentic programming share: the feedback latency is *seconds to minutes*. The user makes a decision, sets it in motion, and waits. They steer in batches.

Flow lives at low latency, not at high latency. The reason is mechanical — Csikszentmihalyi's condition (5), immediate feedback, is what makes the (6) skill/challenge balance possible to calibrate moment-to-moment. Without immediate feedback, the user cannot adjust their effort to the challenge in real time, and they fall out of the flow channel into either anxiety or boredom.

This is also why the existing OpenCues primitives target sub-second latency for the surfaces the user is *waiting on* (blanks) and accept seconds-budget for the surfaces the user is *not waiting on* (cues). The latency budget tracks the flow constraint.

### I. Inline Prompting and Inline Agents as flow-friendly HAII

Concrete grounding for the claim the post makes:

**Inline Prompting** keeps the user in the typing loop. The `_` is user-placed (the user is the agent of placement). The answer arrives in 600ms–1.5s. The user keeps typing while it resolves. When the answer lands, the user has not left their region of interest — they are still in the same paragraph, the same sentence, the same cursor position. Conditions (1), (5), (7) are all preserved.

**Inline Agents** run in the background but the user retains agency over their text. The user types; the agent proposes edits in a dim layer; the user accepts (by leaving the edit alone) or reverts (one keystroke, Down). The user is still the writer. The agent is augmenting their pace, not replacing their authorship.

Both designs preserve the "user is the agent" property the C-section argument depends on. Both target sub-second feedback loops where the user is waiting. Both keep the user in their region of interest throughout.

The bet: HAII designed under these constraints can produce AI programming experiences that *do* flow. Not because the AI got faster, but because the design got out of the user's way at the right moments.

### J. The flow tax of context switching

Every modal, popup, side panel, separate tab, and "switch to chat to ask a question" gesture is a *flow break*. The user's attention has to leave the artifact, navigate to the new surface, perform some action there, navigate back, and reload their working context.

Each of these actions takes seconds. The flow channel does not survive seconds-long interruptions. The user falls out, then has to rebuild back in.

Many of OpenCues' design rules — no chat window, no popup picker, no review pane, no settings dialog, "secondary display" instead of a panel — are flow-tax-reduction rules dressed in design language. Naming this explicitly ties the design choices together as *flow protections*, not just aesthetic minimalism.

The lesson generalises: any HCI / HAII change that lets the user accomplish something *without leaving their region of interest* is a flow protection. Any change that requires switching surfaces is a flow tax. Designers usually accept the tax because the alternative requires more design work. The whole point of HAII as a discipline is to do that more design work.

### L. The "high state" is a feature, not a side effect

Wilfred's mention of "a somewhat high state of mind where your sense of time is warped" deserves to be elevated.

Flow is what makes work *enjoyable*. A tool that breaks flow makes work unpleasant even if it makes the output faster. Users who are never in flow eventually burn out, lose motivation, and switch to other tools — even when the flow-breaking tool is technically more capable.

This is not soft. It is one of the most consistent findings in productivity research: people work for longer, stay engaged for years instead of months, and produce higher-quality output when their work conditions support flow regularly.

Designing *for* flow is therefore a primary HAII goal, not a nice-to-have. The metric is not "how much faster can the user accomplish task X" but "how often can the user enter the high state while accomplishing task X." A tool that achieves the second usually wins on the first, eventually, because users keep using it.

This is also the implicit answer to "why does HAII matter beyond marginal speed gains" — because flow matters, and because most current AI tools fail flow conditions on purpose by defaulting to chat.
