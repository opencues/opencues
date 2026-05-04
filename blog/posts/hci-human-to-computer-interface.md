# HCI (Human to computer interface)

Inventing new "HCIs" is my passion.

Often when meeting people at events or describing what me and the team at Command Stick specialise in I am met with a subtle blank stair. I usually recognise their subtle "cue" and try to elaborate that human to computer interface design is not necessarily hardware. It is any means through which we interface with a computer system.

In the modern times human computer interfaces are the software based interfaces through which we interface with our various technologies on a daily basis. E.g. slides, buttons, touch screens, keyboards, mice, chat windows, tabs, dropdowns, etc… (exhaustive list) All of these HCIs were engineered by individuals and have stood the test of time as means of interfacing with computers.

Over the passage of time new HCIs are invented to fit different form factors and accommodate additional functionality. As user preferences and behaviour patterns change different HCIs fall in and out of favour.

I have been inventing and patenting novel HCIs for over 7 years of designing and the breadth of platforms through which me and my team have designed HCIs on spans from desktop, mobile, tablet and smartwatch.

Over the years we have developed a framework for evaluating HCIs which has allowed us to identify gaps in the market or rooms for improvement.

Though there are over N parameters you could evaluate a HCI from, I like to simplify it to:

- Start-up frames
- Active window
- Cool down (end-lag)

If you're a keen fighting game player these terms may seem familiar to you.

When building my first HCI I sort out to gamify the experience of controlling a system through making a more seamless, fluid control experience. So I looked towards video game design to determine how HCIs could be improved.

Start-up frames: Initially a term from fighting games refers to how much time needs to pass/ how many pre-requisite actions must be performed for a user to be able to engage in a HCI.

On its surface it could be taken as 'my button is immediately responsive', there are no 'start-up frames' but this disregards the user's 'state' prior to needing your button and the variance in the user's need for your button when performing other tasks.

You can read more in detail about start-up frames and the video game parallels: here (Link to other article)

Active window: Also a term from fight games is duration of an action and how it prevents a user from different actions asynchronously. E.g. If you require a user to wait for an action to be performed after they have issued a request this limits the user's ability to multi-task or perform additional requests. An ideal HCI does not prevent a user from performing future actions as a current action is being processed as this limits the user's ability to multi-task or chain together actions seamlessly.

You can read more in detail about Active window and the video game parallels: here (Link to other article)

Cool down (end-lag): Needless to say another video game term is the concept when designing a HCI after the user has completed a task utilising your HCI how much time, effort or actions are required for a user to get back to their original state or future intended state. An ideal HCI does not require a user to 'reset' themselves to perform a desired action.

You can read more in detail about Cool down (end-lag) and the video game parallels: here (Link to other article)

Through balancing these aspects of a HCI you are able to create an experience which feels 'gamified' with the goal of allowing a user to feel in the "zone" as the system is not stifling a user's ability to interface with a computer system.

I consider the above framework is the most basic means of evaluating a HCI, in a future article I will go into more detail about advanced means of breaking down HCIs.

As we enter the modern era of novel LLM based systems it is interesting to explore what is possible, what new problems and HCIs are now made relevant which were previously impossible to implement.

---

## STAGING NOTES (not yet formatted)

### A. Applying the 3-axis framework to OpenCues

A worked example of using start-up / active window / cool-down on the new HCI I'm building. The blog series is going to keep coming back to this, so applying the framework once here grounds it.

**Cues (LLM → user, on plain text)**

- *Start-up frames* — zero. Tips appear automatically as you type. The user does not have to "summon" a cue; static cues are looked up in RAM (~0ms), remote cues fire on the existing 500ms debounce that they were already going to hit by pausing typing. No pre-requisite action.
- *Active window* — zero. Cues are advisory. The user can keep typing while the LLM is in flight; when the dim arrives, they take it or ignore it. The cycling primitive (Up/Down on a dimmed word) is in-place — no popup, no menu — so even acting on a cue does not block future input.
- *Cool-down* — zero. After cycling a word, the cursor stays where it was, the rest of the input is untouched, and the next cue is already armed for the next word. There is no "close the picker", no "dismiss the suggestion", no return-to-typing transition.

**Blanks (user → system, on `_`)**

- *Start-up frames* — one keystroke (`_`). On every standard keyboard layout. No modifier, no menu, no command palette.
- *Active window* — sub-second to ~1.5s depending on which blank fired. The user can keep typing while the blank resolves; when it lands, the value drops in at the position they put the `_`. The contract is sub-second precisely because this axis is felt — too long here breaks the gamified feel.
- *Cool-down* — zero. The filled value lives in the text. Editing around it does not require dismissing it. The user can cycle through alternatives in place if there are any; otherwise the value is just text now.

The framework's prediction matched the implementation's choices and rejection list. The non-extension points (no word-cycling without `_`, no modal pickers, no auto-revert on stop) all read as decisions that *protect* the three axes.

### B. The two-direction model as the answer to the closing line

The closing line teases "what new HCIs are now made relevant" by LLMs. The answer the rest of the series develops:

> Two directions of intent on text. Cues are LLM → user (the system offers alternatives the user did not ask for). Blanks are user → system (the user places `_` to summon a value). Same character, infinite uses, dispatched contextually.

Worth flagging up front because:
- It is the spine of every other post in the series.
- It makes the closing line concrete instead of rhetorical.
- It is itself a fresh HCI primitive in the framework sense — the "direction of intent" is the new axis that LLMs unlocked.

### C. Additional evaluation parameters beyond the three axes

The post says "there are over N parameters" without enumerating them. A short bulleted "honourable mentions" list would carry the claim:

- **Cognitive load** — how much of the user's working memory the HCI consumes. Procedural memory is cheap (the keyboard); declarative memory is expensive (remembering keyboard shortcuts).
- **Hand occlusion** — whether the operating hand blocks the user's view of the input. Touch screens are notoriously bad here.
- **Ambiguous recipient** — whether the user can tell which on-screen element the input applies to. Voice assistants suffer from this.
- **Scale-independence** — whether the HCI ports across screen sizes (desktop / tablet / mobile / watch) without breaking procedural memory.
- **Discoverability** — whether the user can find the available functionality without referring to documentation. Gestures fail this; menus pass it.
- **Cancellability** — whether the user can abort a partially-formed input. Most click-execute systems fail this; CommandStick passes it.
- **Affordance** — whether the HCI signals how to use it without instruction. A door handle has affordance; a swipe gesture does not.

The 3-axis framework is the *first* lens; this is a partial second lens. A future post can give them their own treatment.

### D. HCIs that have fallen in / out of favour

Concrete examples of the "user preferences and behaviour patterns change" claim:

- **Stylus → finger touch.** Stylus was the smartphone HCI of 2003. Finger displaced it within 4 years of the iPhone.
- **Command line → GUI → CLI renaissance.** The terminal was supposed to die in 1995. It did not. Developer tooling is currently *more* CLI-centric than at any point since the early 90s.
- **Dropdown menus → search-everywhere.** Cmd+K / Ctrl+K palettes have started replacing nested menus in tools the user navigates frequently (Linear, Notion, VSCode, GitHub).
- **Right-click → swipe / long-press / kebab menu.** Right-click as a discovery surface is collapsing on mobile-first interfaces.
- **Hover → tap / focus.** Tooltips on hover assume a pointer device. Touch interfaces have had to find different surfaces (long-press preview, swipe to reveal).
- **Floppy save icon → no save icon at all.** Auto-save displaced the explicit save action; the floppy disk icon is now a fossil that points at a behaviour most users do not perform.

The pattern: HCIs do not fall out of favour because they are bad. They fall out of favour because the *substrate* shifted — a new device class, a new latency budget, a new set of user expectations — and the HCI no longer fits the constraints it was designed for.

### F. Cross-domain pollination as the meta-move

The fighting-game → HCI borrowing is itself the strongest argument for cross-domain pollination as a design practice. Worth a one-paragraph note here, then a forward-pointer to post #13 ("Cross domain pollination & `_` shaped people"):

The 3-axis framework would not have appeared from inside HCI design. It came from a domain (competitive fighting games) where the language for "this move is committal in a way that gets you punished" had been refined for 30+ years by players who had to get it right under pressure. Borrowing that vocabulary did not just give me a label — it gave me an *evaluative grammar* that HCI did not have. The blog post on cross-domain pollination explores this further; the short version is that the most useful design tools tend to come from outside design.
