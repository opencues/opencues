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
        "when": "has a rough or messy draft and wants it cleaned up before sending",
        "say": "Rough draft? Add improve prompt _ at the end and it rewrites in place"
      }
    }
  },
  {
    "id": "transform-blanks",
    "words": {
      "translate": {
        "tip": "`[your text] translate to french _` — replaces with the translation",
        "when": "asks for their text put into another language",
        "say": "Another language? <text> translate to french _ replaces it with the translation"
      },
      "format": {
        "tip": "`<list> format as bullet points _` formats; works for table/JSON too",
        "when": "asks for their text turned into bullet points, a numbered list, a table or JSON",
        "say": "Want it as a list or table? <text> format as bullet points _ (or as a table, as JSON)"
      },
      "summarize": {
        "tip": "`<text> summarize _` collapses the text to a short summary",
        "when": "asks for their text made shorter, condensed, trimmed or summed up",
        "say": "Too long? <text> summarize _ or shorten _ does it in place"
      }
    }
  },
  {
    "id": "fluid-blank",
    "words": {
      "_": {
        "tip": "The `_` is the universal trigger — runtime fills it from surrounding text",
        "when": "asks a factual question, or wants a word, a definition or an answer filled in",
        "say": "Need an answer? Type the question and end it with _; the blank fills itself"
      }
    }
  },
  {
    "id": "input-box",
    "words": {
      "input box": {
        "tip": "Alt+Shift+↑ slides up the input box; submit injects into your shell prompt",
        "when": "asks how to open, close or submit the input box",
        "say": "The input box: Alt+Shift+↑ opens it, Alt+Shift+→ submits to the shell, Alt+Shift+↓ cancels"
      }
    }
  },
  {
    "id": "shell-integration",
    "words": {
      "shell-integration": {
        "tip": "Run `oc-install-shell-integration` once to wire capture-current-line",
        "when": "says the input box does not pick up the line they were typing at the prompt",
        "say": "Line not captured? Run oc-install-shell-integration once and the box pulls your buffer"
      }
    }
  },
  {
    "id": "settings",
    "words": {
      "opencues settings": {
        "tip": "`opencues settings _` slides out a selector/satellite for every setting",
        "when": "wants to change an OpenCues setting such as voice, tips or debug",
        "say": "Changing a setting? opencues settings _ slides out every setting; Ctrl+Alt+→/← cycles it"
      }
    }
  },
  {
    "id": "system-blanks",
    "words": {
      "volume": {
        "tip": "`volume _` auto-fills with system volume; Ctrl+Alt+↑/↓ adjusts",
        "when": "wants to change the system volume or the screen brightness",
        "say": "Volume or brightness? volume _ fills the level; Ctrl+Alt+↑/↓ adjusts it"
      },
      "weather": {
        "tip": "`weather <city> _` — fetches current conditions and embeds them",
        "when": "asks about the weather or a forecast for a place",
        "say": "Weather? weather <city> _ fills the current conditions"
      },
      "stocks": {
        "tip": "`nvda _`, `aapl _`, `tsla _` — fetches current price",
        "when": "asks for a stock or crypto price",
        "say": "A price? nvda _ or btc _ fills the current one"
      }
    }
  },
  {
    "id": "word-cycling",
    "words": {
      "cycle": {
        "tip": "Ctrl+Alt+→/← navigates words; Ctrl+Alt+↑/↓ cycles alternatives",
        "when": "asks how to move between cued words or pick an alternative",
        "say": "Cued words: Ctrl+Alt+→/← moves between them, Ctrl+Alt+↑/↓ cycles the alternatives"
      }
    }
  },
  {
    "id": "tmux-shell",
    "words": {
      "oc-shell": {
        "tip": "`oc-shell` wraps $SHELL in a tmux session with the slide-pane input",
        "when": "asks whether it touches their tmux or how the shell is wrapped",
        "say": "Your tmux is safe: oc-shell runs in its own private session"
      }
    }
  },
  {
    "id": "shell-basics",
    "words": {
      "history": {
        "tip": "Ctrl+R reverse-searches your shell history (in the shell pane)",
        "when": "wants to re-run or find an earlier command",
        "say": "An earlier command? Ctrl+R searches shell history in the shell pane"
      }
    }
  },
  {
    "id": "exit",
    "words": {
      "exit": {
        "tip": "Alt+Shift+← exits oc-shell (alternative: Ctrl+Alt+X)",
        "when": "asks how to quit oc-shell or cancel the input box",
        "say": "Leaving? Alt+Shift+← exits oc-shell; Esc cancels the input box"
      }
    }
  }
]
```
