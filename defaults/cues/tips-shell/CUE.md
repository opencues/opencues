---
name: tips-shell
# Shell tip pack — the `oc-shell` integration wraps your interactive
# shell ($SHELL) in a private tmux session with an Alt+Shift+↑ slide-
# pane input box. The tip surface fires inside the input box; the
# trigger words below are things you'd type while COMPOSING a prompt
# for another CLI (Claude Code, ChatGPT, etc.) before submitting it.
#
# Sibling packs: tips-claude-code/, tips-opencode/, tips-gemini-cli/.
# The folder loader's host-compat filter scopes this pack to shell —
# Alt+Shift+arrow chords + `oc-shell` references don't fire on
# native CLI hosts where they have different (or no) meaning.
on-host: [shell]
---

```json
[
  {
    "id": "prompt-composing",
    "words": {
      "improve prompt": {
        "tip": "Type your rough draft then `improve prompt _` — runtime rewrites inline",
        "alts": ["enhance prompt", "refine prompt", "draft"]
      },
      "enhance prompt": {
        "tip": "Same as `improve prompt _` — rewrites a draft into a structured prompt",
        "alts": ["improve prompt", "refine prompt"]
      },
      "refine prompt": {
        "tip": "Same as `improve prompt _` — rewrites a draft into a structured prompt",
        "alts": ["improve prompt", "enhance prompt"]
      },
      "draft": {
        "tip": "Drafting? Append `improve prompt _` and the runtime rewrites in place",
        "alts": ["improve prompt", "enhance prompt", "rough"]
      },
      "rough": {
        "tip": "Rough text → append `improve prompt _` to get a structured rewrite",
        "alts": ["draft", "improve prompt"]
      }
    }
  },
  {
    "id": "transform-blanks",
    "words": {
      "translate": {
        "tip": "`[your text] translate to french _` — replaces with the translation",
        "alts": ["translation", "french", "spanish"]
      },
      "translation": {
        "tip": "`<text> translate to <language> _` — transform-blank does the rest",
        "alts": ["translate", "french"]
      },
      "format as": {
        "tip": "`<list> format as bullet points _` — also `as a table`, `as JSON`",
        "alts": ["format", "bullets", "JSON"]
      },
      "format": {
        "tip": "`<list> format as bullet points _` formats; works for table/JSON too",
        "alts": ["format as", "bullets", "JSON"]
      },
      "past tense": {
        "tip": "`<sentence> make past tense _` rewrites the sentence in past tense",
        "alts": ["make past tense", "future tense", "rewrite"]
      },
      "summarize": {
        "tip": "`<text> summarize _` collapses the text to a short summary",
        "alts": ["summary", "tldr", "shorten"]
      },
      "shorten": {
        "tip": "`<text> shorten _` shrinks text; pair with target length in body",
        "alts": ["summarize", "tldr"]
      }
    }
  },
  {
    "id": "fluid-blank",
    "words": {
      "_": {
        "tip": "The `_` is the universal trigger — runtime fills it from surrounding text",
        "alts": ["blank", "fill", "underscore"]
      },
      "blank": {
        "tip": "Type `_` after a phrase — the runtime fills it (LLM or local)",
        "alts": ["_", "fill", "lookup"]
      },
      "what is the word for": {
        "tip": "`what is the word for X _` → the runtime answers with the single word",
        "alts": ["how to say", "answer", "vocabulary"]
      },
      "how to say": {
        "tip": "`how to say X _` — same as `what is the word for`",
        "alts": ["what is the word for", "answer"]
      },
      "define": {
        "tip": "`define X _` — runtime looks up the dictionary definition",
        "alts": ["definition of", "meaning of", "what is"]
      },
      "definition of": {
        "tip": "`definition of X _` — dictionary lookup blank",
        "alts": ["define", "meaning of"]
      }
    }
  },
  {
    "id": "input-box",
    "words": {
      "Alt+Shift+Up": {
        "tip": "Alt+Shift+↑ opens the slide-pane input box at the bottom of the shell",
        "alts": ["F2", "input", "open"]
      },
      "Alt+Shift+Down": {
        "tip": "Alt+Shift+↓ cancels the input box and restores any captured shell line",
        "alts": ["Esc", "cancel", "restore"]
      },
      "Alt+Shift+Right": {
        "tip": "Alt+Shift+→ submits the input-box buffer into the shell at the cursor",
        "alts": ["Ctrl+S", "submit", "paste"]
      },
      "Alt+Shift+Left": {
        "tip": "Alt+Shift+← exits oc-shell entirely (kills the tmux session)",
        "alts": ["Ctrl+Alt+X", "exit", "quit"]
      },
      "F2": {
        "tip": "F2 is an aliased opener — same as Alt+Shift+↑ (for emulators that swallow it)",
        "alts": ["Alt+Shift+Up", "open", "input"]
      },
      "input box": {
        "tip": "Alt+Shift+↑ slides up the input box; submit injects into your shell prompt",
        "alts": ["Alt+Shift+Up", "F2", "slide-pane"]
      },
      "slide-pane": {
        "tip": "The input box is a lazy-spawn tmux split — only there when open",
        "alts": ["input box", "Alt+Shift+Up"]
      }
    }
  },
  {
    "id": "shell-integration",
    "words": {
      "capture": {
        "tip": "Alt+Shift+↑ captures the line you were typing at the shell prompt",
        "alts": ["Alt+Shift+Up", "shell-integration", "readline"]
      },
      "shell-integration": {
        "tip": "Run `oc-install-shell-integration` once to wire capture-current-line",
        "alts": ["capture", "readline", "rc"]
      },
      "readline": {
        "tip": "Shell-integration binds an internal chord so opening pulls your buffer",
        "alts": ["capture", "shell-integration"]
      },
      "oc-install-shell-integration": {
        "tip": "One-time setup — appends a source line to ~/.bashrc / .zshrc / fish",
        "alts": ["shell-integration", "rc", "capture"]
      }
    }
  },
  {
    "id": "settings",
    "words": {
      "opencues settings": {
        "tip": "`opencues settings _` slides out a selector/satellite for every setting",
        "alts": ["config", "settings", "OPENCUES.md"]
      },
      "config": {
        "tip": "`config _` — alias of `opencues settings _`; cycles runtime settings",
        "alts": ["opencues settings", "OPENCUES.md", "settings"]
      },
      "settings": {
        "tip": "Type `opencues settings _` then Ctrl+Alt+→/← to cycle a setting",
        "alts": ["opencues settings", "config", "OPENCUES.md"]
      },
      "OPENCUES.md": {
        "tip": "Settings live at ~/.cues/OPENCUES.md — edit directly or via the blank",
        "alts": ["opencues settings", "config"]
      },
      "voice-mode": {
        "tip": "`opencues settings _` then cycle to voice-mode to enable/disable TTS",
        "alts": ["TTS", "speak", "opencues settings"]
      },
      "TTS": {
        "tip": "TTS reads tips aloud — toggle via voice-mode in `opencues settings _`",
        "alts": ["voice-mode", "speak"]
      }
    }
  },
  {
    "id": "system-blanks",
    "words": {
      "volume": {
        "tip": "`volume _` auto-fills with system volume; Ctrl+Alt+↑/↓ adjusts",
        "alts": ["brightness", "system", "step"]
      },
      "brightness": {
        "tip": "`brightness _` auto-fills with screen brightness; Up/Down steps it",
        "alts": ["volume", "system"]
      },
      "weather": {
        "tip": "`weather <city> _` — fetches current conditions and embeds them",
        "alts": ["forecast", "temp", "temperature"]
      },
      "forecast": {
        "tip": "`forecast <city> _` — alias of weather; uses open-meteo for free",
        "alts": ["weather", "temp"]
      },
      "stocks": {
        "tip": "`nvda _`, `aapl _`, `tsla _` — fetches current price",
        "alts": ["nvda", "aapl", "tsla"]
      },
      "btc": {
        "tip": "`btc _` / `eth _` / `sol _` — crypto price lookup in USD",
        "alts": ["bitcoin", "eth", "crypto"]
      },
      "hn": {
        "tip": "`hn _` — top Hacker News story; auto-populates on type",
        "alts": ["hackernews", "news"]
      },
      "gh-issues": {
        "tip": "`gh-issues owner/repo _` — open-issue count for a GitHub repo",
        "alts": ["github", "issues", "PR"]
      },
      "population of": {
        "tip": "`population of <country> _`, also `capital of`, `currency of`",
        "alts": ["capital of", "currency of", "country"]
      }
    }
  },
  {
    "id": "word-cycling",
    "words": {
      "Ctrl+Alt+Right": {
        "tip": "Ctrl+Alt+→ moves the highlight to the next navigable word",
        "alts": ["Ctrl+Alt+Left", "navigate", "cycle"]
      },
      "Ctrl+Alt+Left": {
        "tip": "Ctrl+Alt+← moves the highlight to the previous navigable word",
        "alts": ["Ctrl+Alt+Right", "navigate"]
      },
      "Ctrl+Alt+Up": {
        "tip": "Ctrl+Alt+↑ cycles to the next alternative for the highlighted word",
        "alts": ["Ctrl+Alt+Down", "cycle", "alternatives"]
      },
      "Ctrl+Alt+Down": {
        "tip": "Ctrl+Alt+↓ cycles backwards through alternatives",
        "alts": ["Ctrl+Alt+Up", "cycle"]
      },
      "cycle": {
        "tip": "Ctrl+Alt+→/← navigates words; Ctrl+Alt+↑/↓ cycles alternatives",
        "alts": ["Ctrl+Alt+Up", "Ctrl+Alt+Right", "navigate"]
      },
      "navigate": {
        "tip": "Ctrl+Alt+→/← jump between cued words in the buffer",
        "alts": ["Ctrl+Alt+Right", "cycle"]
      }
    }
  },
  {
    "id": "tmux-shell",
    "words": {
      "tmux": {
        "tip": "oc-shell uses a PRIVATE tmux session — your existing tmux is untouched",
        "alts": ["session", "oc-shell"]
      },
      "oc-shell": {
        "tip": "`oc-shell` wraps $SHELL in a tmux session with the slide-pane input",
        "alts": ["tmux", "session"]
      },
      "session": {
        "tip": "Each `oc-shell` invocation is a fresh isolated tmux session",
        "alts": ["tmux", "oc-shell"]
      }
    }
  },
  {
    "id": "shell-basics",
    "words": {
      "cd": {
        "tip": "Submit pastes into your shell — `cd` etc. run as if you typed them",
        "alts": ["ls", "pwd", "shell"]
      },
      "history": {
        "tip": "Ctrl+R reverse-searches your shell history (in the shell pane)",
        "alts": ["Ctrl+R", "bash", "zsh"]
      },
      "Ctrl+R": {
        "tip": "Ctrl+R searches shell history (works in the shell pane, not input box)",
        "alts": ["history", "bash"]
      },
      "pipe": {
        "tip": "Compose pipelines in the input box, submit pastes the whole line",
        "alts": ["chain", "shell"]
      }
    }
  },
  {
    "id": "exit",
    "words": {
      "exit": {
        "tip": "Alt+Shift+← exits oc-shell (alternative: Ctrl+Alt+X)",
        "alts": ["Alt+Shift+Left", "Ctrl+Alt+X", "quit"]
      },
      "quit": {
        "tip": "Alt+Shift+← quits oc-shell; tmux session is killed",
        "alts": ["exit", "Alt+Shift+Left"]
      },
      "Ctrl+Alt+X": {
        "tip": "Ctrl+Alt+X is the keyboard alias for Alt+Shift+← (exit oc-shell)",
        "alts": ["Alt+Shift+Left", "exit"]
      },
      "Esc": {
        "tip": "Esc inside the input box cancels (same as Alt+Shift+↓)",
        "alts": ["Alt+Shift+Down", "cancel", "Ctrl+Q"]
      },
      "cancel": {
        "tip": "Esc / Ctrl+Q / Alt+Shift+↓ cancel the input box and restore the line",
        "alts": ["Esc", "Alt+Shift+Down", "Ctrl+Q"]
      }
    }
  }
]
```
