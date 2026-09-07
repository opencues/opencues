---
name: tips-opencode
# OpenCode tip pack — slash commands (/compact, /undo, /sessions,
# /share, /models, /thinking, …), TUI keybinds (leader Ctrl+X, Tab
# agent cycle, Ctrl+T variant, F2 model, Esc interrupt), CLI flags
# (--continue, --fork, --share, --variant), and OpenCode features
# (AGENTS.md, custom commands, MCP, plugins, attach/serve,
# Models.dev providers). Scoped to opencode so trigger words don't
# collide with vocabulary on other hosts.
#
# Sibling packs: tips-claude-code/, tips-gemini-cli/, tips-shell/.
# Verified against opencode.ai/docs/{tui,commands,keybinds,cli} for
# OpenCode v1.14.x (May 2026).
on-host: [opencode]
---

```json
[
  {
    "id": "context-management",
    "words": {
      "/compact": {
        "tip": "Use /compact to summarize history when context fills up",
        "when": "says the agent forgot what they were doing, or the session got long",
        "say": "Losing the thread? /compact condenses the session; auto fires at 75%"
      }
    }
  },
  {
    "id": "undo-redo",
    "words": {
      "/undo": {
        "tip": "Use /undo to revert last message AND file changes (needs git)",
        "when": "wants to undo or take back what the ASSISTANT just changed or did in this session (not an undo inside their own code, database or app)",
        "say": "Undo what it just did? /undo reverts the last message and its edits; needs a git repo"
      },
      "/redo": {
        "tip": "Use /redo to reapply a previously undone message",
        "when": "wants back what an undo removed",
        "say": "Want it back? /redo restores what /undo removed"
      }
    }
  },
  {
    "id": "interrupt",
    "words": {
      "Esc": {
        "tip": "Press Esc to interrupt the current generation",
        "when": "wants to stop the current response mid-way",
        "say": "Want it to stop? Esc interrupts the response; Ctrl+C twice exits opencode"
      }
    }
  },
  {
    "id": "sessions",
    "words": {
      "/sessions": {
        "tip": "Use /sessions (Ctrl+X l) to list and switch sessions",
        "when": "wants an earlier session back",
        "say": "An earlier session? /sessions lists them; opencode -c resumes the last"
      },
      "/new": {
        "tip": "Use /new (Ctrl+X n) to start a fresh session",
        "when": "wants to start over or clear the chat without quitting",
        "say": "Starting over? /new (or /clear) begins a fresh session without quitting"
      },
      "--continue": {
        "tip": "opencode --continue (-c) resumes your last session",
        "when": "closed the terminal or wants yesterday's session back",
        "say": "Closed it? opencode --continue reopens your last session; /sessions lists the rest"
      }
    }
  },
  {
    "id": "agents",
    "words": {
      "Tab": {
        "tip": "Press Tab to cycle to the next agent (Ctrl+X a opens list)",
        "when": "wants plan mode, or typed Shift+Tab from Claude Code",
        "say": "Plan mode? Tab switches Plan and Build; Shift+Tab goes backwards"
      },
      "subagent": {
        "tip": "Subagents run in their own context — set mode in the agent .md",
        "when": "wants part of the work delegated or run in its own context",
        "say": "Delegating? A subagent runs in its own context; set its mode in the agent .md"
      }
    }
  },
  {
    "id": "models",
    "words": {
      "/models": {
        "tip": "Use /models (Ctrl+X m) to switch model mid-session",
        "when": "asks which model this is, or typed /model from another tool",
        "say": "Which model? /models picks one, and each agent keeps its own"
      },
      "Ctrl+T": {
        "tip": "Ctrl+T cycles model variants (provider reasoning effort)",
        "when": "wants a bigger thinking budget",
        "say": "Bigger thinking budget? Ctrl+T cycles the variants"
      }
    }
  },
  {
    "id": "thinking",
    "words": {
      "/thinking": {
        "tip": "Toggle visibility of reasoning blocks (does NOT enable thinking)",
        "when": "asks how to turn thinking on; this only shows it",
        "say": "Want more thinking? /thinking only shows it; Ctrl+T cycles the budget"
      }
    }
  },
  {
    "id": "sharing",
    "words": {
      "/share": {
        "tip": "Use /share to publish a shareable session link",
        "when": "wants to show the session to someone, or worries a link is public",
        "say": "Sharing this? /share makes a public link; /unshare removes it"
      }
    }
  },
  {
    "id": "leader-key",
    "words": {
      "Ctrl+X": {
        "tip": "Ctrl+X is the leader key — pairs with letters for most actions",
        "when": "asks what the keybindings are or how to reach a command faster",
        "say": "Looking for a shortcut? Ctrl+X is the leader: n new, c compact, m models, l sessions"
      },
      "tui.json": {
        "tip": "Customize keybinds in tui.json (separate from opencode.json)",
        "when": "says a theme or keybind setting is ignored",
        "say": "Theme or keybind ignored? Those live in tui.json, not opencode.json"
      }
    }
  },
  {
    "id": "init",
    "words": {
      "/init": {
        "tip": "Use /init to generate or update AGENTS.md for your project",
        "when": "is in a new repo with no AGENTS.md yet",
        "say": "New repo? /init writes AGENTS.md from what it finds; commit it"
      },
      "AGENTS.md": {
        "tip": "AGENTS.md holds project rules — run /init to scaffold it",
        "when": "asks where the project rules go, or typed CLAUDE.md",
        "say": "Rules it should keep? Put them in AGENTS.md; /init scaffolds it"
      }
    }
  },
  {
    "id": "auth-providers",
    "words": {
      "/connect": {
        "tip": "Use /connect to add a provider and store its API key",
        "when": "asks how to log in or add a provider key",
        "say": "Adding a provider? /connect stores the key; opencode models lists what you can use"
      }
    }
  },
  {
    "id": "file-refs",
    "words": {
      "@": {
        "tip": "Prefix a filename with @ to include its contents (e.g. @src/main.ts)",
        "when": "wants to point the agent at a file",
        "say": "Point it at a file: @ opens fuzzy search and attaches it"
      }
    }
  },
  {
    "id": "shell-commands",
    "words": {
      "!": {
        "tip": "Start a message with ! to run a shell command (output added to chat)",
        "when": "wants to run a quick shell command without leaving the prompt",
        "say": "A quick shell command? Start the message with ! and its output lands in the chat"
      }
    }
  },
  {
    "id": "editor",
    "words": {
      "/editor": {
        "tip": "Use /editor (Ctrl+X e) to compose in $EDITOR (set --wait for GUI)",
        "when": "is writing a long prompt in the input box",
        "say": "Long prompt? /editor opens it in $EDITOR (GUI editors need --wait)"
      },
      "Shift+Enter": {
        "tip": "Shift+Enter inserts a newline (terminal may need extra setup)",
        "when": "complains that Enter sends the message when they wanted a new line",
        "say": "Enter sending too early? Shift+Enter inserts a newline; /editor for a full editor"
      }
    }
  },
  {
    "id": "non-interactive",
    "words": {
      "ci": {
        "tip": "Use `opencode run` for CI; --format json for structured output",
        "when": "wants to run it from a script, a CI job or a pipeline",
        "say": "Scripting it? opencode run does one prompt; --format json for parseable output"
      }
    }
  },
  {
    "id": "remote-attach",
    "words": {
      "remote": {
        "tip": "`opencode serve` on a host, then `opencode attach <url>` from anywhere",
        "when": "wants to drive opencode on another machine or from a browser",
        "say": "Another machine? opencode serve there, then opencode attach <url> here; opencode web for a browser"
      }
    }
  },
  {
    "id": "permissions",
    "words": {
      "permission": {
        "tip": "Configure per-agent permissions in agent frontmatter, not --dangerously-skip",
        "when": "is tired of approving every tool call, or reaches for --dangerously-skip-permissions",
        "say": "Tired of approving? Set per-agent permissions in the agent frontmatter instead of --dangerously-skip-permissions"
      }
    }
  },
  {
    "id": "custom-commands",
    "words": {
      "custom command": {
        "tip": "Drop a .md in .opencode/commands/ — filename becomes the /command",
        "when": "does the same prompt every day and wants it as a command",
        "say": "Same prompt daily? A .md in .opencode/commands/ becomes a /command; $ARGUMENTS passes the args"
      }
    }
  },
  {
    "id": "mcp",
    "words": {
      "mcp": {
        "tip": "`opencode mcp add` to register an MCP server; `mcp list` to inspect",
        "when": "wants to connect a tool, service or data source",
        "say": "Connecting a tool? opencode mcp add registers an MCP server; opencode plugin for plugins"
      }
    }
  },
  {
    "id": "stats-cost",
    "words": {
      "cost": {
        "tip": "`opencode stats` shows cost; --models for per-model breakdown",
        "when": "asks what this is costing or how many tokens it has used",
        "say": "Wondering about cost? opencode stats shows tokens and cost; --days 7 or --models breaks it down"
      }
    }
  },
  {
    "id": "session-control",
    "words": {
      "Ctrl+Z": {
        "tip": "Ctrl+Z suspends opencode (POSIX); use fg to resume",
        "when": "wants to drop to the shell for a moment without losing the session",
        "say": "Need the shell? Ctrl+Z suspends opencode, fg brings it back"
      },
      "rename": {
        "tip": "No /rename command — press Ctrl+R inside /sessions to rename",
        "when": "wants to name the session so they can find it later",
        "say": "Want to find this later? Ctrl+R renames the session; /sessions lists them"
      }
    }
  },
  {
    "id": "exit",
    "words": {
      "/exit": {
        "tip": "Use /exit (Ctrl+X q) to quit cleanly",
        "when": "asks how to quit or leave cleanly",
        "say": "Leaving? /exit (Ctrl+X q) quits cleanly"
      }
    }
  },
  {
    "id": "export-import",
    "words": {
      "/export": {
        "tip": "Use /export (Ctrl+X x) to export conversation to Markdown",
        "when": "wants the conversation as markdown for a PR or a handoff",
        "say": "Need the conversation as text? /export writes markdown"
      },
      "import": {
        "tip": "`opencode import <file-or-share-url>` to load a saved session",
        "when": "wants to load a saved or shared session",
        "say": "Bringing a session back? opencode import <file or share url> loads it"
      }
    }
  },
  {
    "id": "upgrade",
    "words": {
      "upgrade": {
        "tip": "`opencode upgrade` — or `opencode upgrade v0.1.48` for a pinned version",
        "when": "asks about updating or a newer version",
        "say": "Updating? opencode upgrade; pin a version with opencode upgrade v0.x.y"
      }
    }
  },
  {
    "id": "command-list",
    "words": {
      "/help": {
        "tip": "Type /help for the help dialog; Ctrl+P for searchable palette",
        "when": "is not sure what commands exist",
        "say": "Not sure what exists? /help lists the commands; Ctrl+P is the searchable palette"
      }
    }
  },
  {
    "id": "themes",
    "words": {
      "/themes": {
        "tip": "Use /themes (Ctrl+X t) to switch UI theme",
        "when": "wants to change how the UI looks",
        "say": "Changing the look? /themes picks one; theme in tui.json keeps it"
      }
    }
  },
  {
    "id": "pr-workflow",
    "words": {
      "pr": {
        "tip": "`opencode pr <num>` checks out a GitHub PR branch and starts opencode",
        "when": "wants to review or work on a GitHub pull request",
        "say": "Working a PR? opencode pr <number> checks out its branch and starts there"
      }
    }
  }
]
```
