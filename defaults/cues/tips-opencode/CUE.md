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
        "alts": ["/summarize", "/new", "context"]
      },
      "/summarize": {
        "tip": "Alias for /compact - summarizes session history",
        "alts": ["/compact", "/new"]
      },
      "compact": {
        "tip": "Type /compact (Ctrl+X c) to compress session history",
        "alts": ["/compact", "Ctrl+X c", "context"]
      }
    }
  },
  {
    "id": "undo-redo",
    "words": {
      "/undo": {
        "tip": "Use /undo to revert last message AND file changes (needs git)",
        "alts": ["/redo", "Ctrl+X u", "rollback"]
      },
      "/redo": {
        "tip": "Use /redo to reapply a previously undone message",
        "alts": ["/undo", "Ctrl+X r"]
      },
      "undo": {
        "tip": "Type /undo (Ctrl+X u) - reverts last turn AND file edits",
        "alts": ["/undo", "/redo", "rollback"]
      },
      "rollback": {
        "tip": "Use /undo to rollback - reverts files via git too",
        "alts": ["/undo", "/redo", "revert"]
      },
      "revert": {
        "tip": "Use /undo to revert last turn (uses git for file changes)",
        "alts": ["/undo", "/redo", "rollback"]
      }
    }
  },
  {
    "id": "interrupt",
    "words": {
      "Esc": {
        "tip": "Press Esc to interrupt the current generation",
        "alts": ["stop", "cancel", "interrupt"]
      },
      "stop": {
        "tip": "Press Esc to stop a running response",
        "alts": ["Esc", "cancel", "interrupt"]
      },
      "cancel": {
        "tip": "Press Esc to cancel an in-flight LLM call",
        "alts": ["Esc", "stop", "interrupt"]
      },
      "interrupt": {
        "tip": "Esc interrupts; Ctrl+C twice exits opencode",
        "alts": ["Esc", "stop", "cancel"]
      }
    }
  },
  {
    "id": "sessions",
    "words": {
      "/sessions": {
        "tip": "Use /sessions (Ctrl+X l) to list and switch sessions",
        "alts": ["/resume", "/continue", "/new"]
      },
      "/resume": {
        "tip": "Alias for /sessions - resume any past session",
        "alts": ["/sessions", "/continue", "--continue"]
      },
      "/continue": {
        "tip": "Alias for /sessions - pick a session to continue",
        "alts": ["/sessions", "/resume", "--continue"]
      },
      "/new": {
        "tip": "Use /new (Ctrl+X n) to start a fresh session",
        "alts": ["/clear", "/sessions"]
      },
      "--continue": {
        "tip": "opencode --continue (-c) resumes your last session",
        "alts": ["--session", "--fork", "/sessions"]
      },
      "--fork": {
        "tip": "Use --fork with --continue to branch off a session",
        "alts": ["--continue", "--session"]
      }
    }
  },
  {
    "id": "agents",
    "words": {
      "Tab": {
        "tip": "Press Tab to cycle to the next agent (Ctrl+X a opens list)",
        "alts": ["Shift+Tab", "Ctrl+X a", "agent"]
      },
      "Shift+Tab": {
        "tip": "Shift+Tab cycles agents in reverse",
        "alts": ["Tab", "Ctrl+X a"]
      },
      "agent": {
        "tip": "Tab cycles agents; Ctrl+X a opens the agent picker",
        "alts": ["Tab", "Shift+Tab", "subagent"]
      },
      "subagent": {
        "tip": "Subagents run in their own context — set mode in the agent .md",
        "alts": ["agent", "Tab", "AGENTS.md"]
      }
    }
  },
  {
    "id": "models",
    "words": {
      "/models": {
        "tip": "Use /models (Ctrl+X m) to switch model mid-session",
        "alts": ["F2", "Ctrl+T", "Ctrl+A"]
      },
      "F2": {
        "tip": "Press F2 to cycle recently used models",
        "alts": ["/models", "Ctrl+T", "Ctrl+A"]
      },
      "Ctrl+T": {
        "tip": "Ctrl+T cycles model variants (provider reasoning effort)",
        "alts": ["/models", "F2", "--variant"]
      },
      "Ctrl+A": {
        "tip": "Ctrl+A opens the provider + model picker",
        "alts": ["/models", "F2", "Ctrl+F"]
      },
      "Ctrl+F": {
        "tip": "Ctrl+F toggles a model as a favorite",
        "alts": ["/models", "Ctrl+A"]
      },
      "--variant": {
        "tip": "Use --variant to set provider-specific reasoning effort",
        "alts": ["--thinking", "Ctrl+T", "/models"]
      }
    }
  },
  {
    "id": "thinking",
    "words": {
      "/thinking": {
        "tip": "Toggle visibility of reasoning blocks (does NOT enable thinking)",
        "alts": ["Ctrl+T", "--thinking", "reasoning"]
      },
      "--thinking": {
        "tip": "Pass --thinking to show thinking blocks in `opencode run`",
        "alts": ["/thinking", "Ctrl+T", "reasoning"]
      },
      "reasoning": {
        "tip": "Ctrl+T cycles reasoning effort; /thinking shows the blocks",
        "alts": ["/thinking", "Ctrl+T", "--variant"]
      }
    }
  },
  {
    "id": "sharing",
    "words": {
      "/share": {
        "tip": "Use /share to publish a shareable session link",
        "alts": ["/unshare", "OPENCODE_AUTO_SHARE", "--share"]
      },
      "/unshare": {
        "tip": "Use /unshare to revoke the shared session link",
        "alts": ["/share"]
      },
      "share": {
        "tip": "/share creates a public link; OPENCODE_AUTO_SHARE=true auto-shares",
        "alts": ["/share", "/unshare", "--share"]
      },
      "--share": {
        "tip": "`opencode run --share` publishes the session as a URL",
        "alts": ["/share", "OPENCODE_AUTO_SHARE"]
      }
    }
  },
  {
    "id": "leader-key",
    "words": {
      "leader": {
        "tip": "Default leader is Ctrl+X — chord with n=new, c=compact, m=models",
        "alts": ["Ctrl+X", "tui.json", "keybinds"]
      },
      "Ctrl+X": {
        "tip": "Ctrl+X is the leader key — pairs with letters for most actions",
        "alts": ["leader", "tui.json"]
      },
      "tui.json": {
        "tip": "Customize keybinds in tui.json (separate from opencode.json)",
        "alts": ["leader", "Ctrl+X", "keybinds"]
      },
      "keybinds": {
        "tip": "Edit tui.json to rebind; built-in defaults are merged in",
        "alts": ["leader", "Ctrl+X", "tui.json"]
      }
    }
  },
  {
    "id": "init",
    "words": {
      "/init": {
        "tip": "Use /init to generate or update AGENTS.md for your project",
        "alts": ["AGENTS.md", "rules"]
      },
      "AGENTS.md": {
        "tip": "AGENTS.md holds project rules — run /init to scaffold it",
        "alts": ["/init", "rules", "CLAUDE.md"]
      },
      "rules": {
        "tip": "Put project rules in AGENTS.md (or .opencode/) — /init scaffolds it",
        "alts": ["AGENTS.md", "/init", "remember"]
      },
      "remember": {
        "tip": "Persistent instructions go in AGENTS.md — generated by /init",
        "alts": ["AGENTS.md", "/init", "rules"]
      }
    }
  },
  {
    "id": "auth-providers",
    "words": {
      "/connect": {
        "tip": "Use /connect to add a provider and store its API key",
        "alts": ["auth", "login", "provider"]
      },
      "auth": {
        "tip": "Run `opencode auth login` to add API keys for any Models.dev provider",
        "alts": ["/connect", "provider", "login"]
      },
      "provider": {
        "tip": "Providers come from Models.dev — /connect or `opencode auth login`",
        "alts": ["/connect", "auth", "/models"]
      },
      "login": {
        "tip": "`opencode auth login` — stored in ~/.local/share/opencode/auth.json",
        "alts": ["/connect", "auth"]
      }
    }
  },
  {
    "id": "file-refs",
    "words": {
      "@": {
        "tip": "Prefix a filename with @ to include its contents (e.g. @src/main.ts)",
        "alts": ["file", "reference", "context"]
      },
      "file": {
        "tip": "Use @path/to/file to attach file contents to the message",
        "alts": ["@", "reference", "--file"]
      },
      "--file": {
        "tip": "`opencode run --file` attaches files in non-interactive mode",
        "alts": ["@", "file"]
      }
    }
  },
  {
    "id": "shell-commands",
    "words": {
      "!": {
        "tip": "Start a message with ! to run a shell command (output added to chat)",
        "alts": ["shell", "bash", "terminal"]
      },
      "shell": {
        "tip": "Prefix message with ! to execute bash and include the output",
        "alts": ["!", "bash", "terminal"]
      },
      "bash": {
        "tip": "Prefix message with ! to run bash inside opencode",
        "alts": ["!", "shell"]
      }
    }
  },
  {
    "id": "editor",
    "words": {
      "/editor": {
        "tip": "Use /editor (Ctrl+X e) to compose in $EDITOR (set --wait for GUI)",
        "alts": ["EDITOR", "multiline", "external"]
      },
      "editor": {
        "tip": "/editor opens $EDITOR — `export EDITOR='code --wait'` for VS Code",
        "alts": ["/editor", "EDITOR", "multiline"]
      },
      "multiline": {
        "tip": "Shift+Enter for newline; /editor for full external editing",
        "alts": ["/editor", "Shift+Enter", "newline"]
      },
      "Shift+Enter": {
        "tip": "Shift+Enter inserts a newline (terminal may need extra setup)",
        "alts": ["/editor", "multiline"]
      }
    }
  },
  {
    "id": "non-interactive",
    "words": {
      "headless": {
        "tip": "`opencode serve` runs without a TUI; `opencode run` for one-shot",
        "alts": ["opencode run", "serve", "web"]
      },
      "ci": {
        "tip": "Use `opencode run` for CI; --format json for structured output",
        "alts": ["opencode run", "--format", "headless"]
      },
      "--format": {
        "tip": "`opencode run --format json` emits raw JSON events for scripting",
        "alts": ["opencode run", "ci"]
      }
    }
  },
  {
    "id": "remote-attach",
    "words": {
      "attach": {
        "tip": "`opencode attach <url>` connects TUI to a remote serve/web backend",
        "alts": ["serve", "web", "remote"]
      },
      "serve": {
        "tip": "`opencode serve` starts a headless API server (no TUI)",
        "alts": ["web", "attach", "--port"]
      },
      "web": {
        "tip": "`opencode web` starts the server AND opens a browser UI",
        "alts": ["serve", "attach"]
      },
      "remote": {
        "tip": "`opencode serve` on a host, then `opencode attach <url>` from anywhere",
        "alts": ["attach", "serve", "web"]
      }
    }
  },
  {
    "id": "permissions",
    "words": {
      "--dangerously-skip-permissions": {
        "tip": "Auto-approves all permissions — prefer per-agent permissions instead",
        "alts": ["permission", "dangerous"]
      },
      "permission": {
        "tip": "Configure per-agent permissions in agent frontmatter, not --dangerously-skip",
        "alts": ["--dangerously-skip-permissions", "dangerous", "agent"]
      },
      "dangerous": {
        "tip": "Use agent-scoped permissions over --dangerously-skip-permissions",
        "alts": ["--dangerously-skip-permissions", "permission"]
      }
    }
  },
  {
    "id": "custom-commands",
    "words": {
      "custom command": {
        "tip": "Drop a .md in .opencode/commands/ — filename becomes the /command",
        "alts": [".opencode/commands", "template"]
      },
      "$ARGUMENTS": {
        "tip": "$ARGUMENTS (or $1, $2...) in a command template substitutes user args",
        "alts": ["custom command", "template"]
      }
    }
  },
  {
    "id": "mcp",
    "words": {
      "mcp": {
        "tip": "`opencode mcp add` to register an MCP server; `mcp list` to inspect",
        "alts": ["plugin", "server", "extension"]
      },
      "plugin": {
        "tip": "`opencode plugin <module>` installs a plugin and updates config",
        "alts": ["mcp", "extension"]
      },
      "extension": {
        "tip": "Extend via MCP servers (opencode mcp add) or plugins (opencode plugin)",
        "alts": ["mcp", "plugin"]
      }
    }
  },
  {
    "id": "stats-cost",
    "words": {
      "stats": {
        "tip": "`opencode stats` shows token usage and cost across sessions",
        "alts": ["cost", "tokens", "usage"]
      },
      "tokens": {
        "tip": "`opencode stats --days 7` — token + cost breakdown",
        "alts": ["stats", "cost", "usage"]
      },
      "cost": {
        "tip": "`opencode stats` shows cost; --models for per-model breakdown",
        "alts": ["stats", "tokens"]
      },
      "usage": {
        "tip": "`opencode stats` prints usage; --project filters to current project",
        "alts": ["stats", "tokens", "cost"]
      }
    }
  },
  {
    "id": "session-control",
    "words": {
      "Ctrl+Z": {
        "tip": "Ctrl+Z suspends opencode (POSIX); use fg to resume",
        "alts": ["suspend", "resume"]
      },
      "suspend": {
        "tip": "Ctrl+Z suspends; not supported on native Windows terminals",
        "alts": ["Ctrl+Z", "resume"]
      },
      "Ctrl+R": {
        "tip": "Ctrl+R renames the current session",
        "alts": ["/sessions", "rename"]
      },
      "rename": {
        "tip": "No /rename command — press Ctrl+R inside /sessions to rename",
        "alts": ["Ctrl+R", "/sessions"]
      },
      "Ctrl+C": {
        "tip": "Ctrl+C clears the input; press again (or Ctrl+D) to exit",
        "alts": ["/exit", "/quit", "Ctrl+D"]
      }
    }
  },
  {
    "id": "exit",
    "words": {
      "/exit": {
        "tip": "Use /exit (Ctrl+X q) to quit cleanly",
        "alts": ["/quit", "/q", "Ctrl+D"]
      },
      "/quit": {
        "tip": "Alias for /exit — quit OpenCode",
        "alts": ["/exit", "/q"]
      },
      "/q": {
        "tip": "Shortest alias for /exit",
        "alts": ["/exit", "/quit"]
      }
    }
  },
  {
    "id": "export-import",
    "words": {
      "/export": {
        "tip": "Use /export (Ctrl+X x) to export conversation to Markdown",
        "alts": ["export", "import", "/share"]
      },
      "export": {
        "tip": "`opencode export <sessionID>` — JSON; /export gives Markdown",
        "alts": ["/export", "import"]
      },
      "import": {
        "tip": "`opencode import <file-or-share-url>` to load a saved session",
        "alts": ["export", "/export"]
      }
    }
  },
  {
    "id": "upgrade",
    "words": {
      "upgrade": {
        "tip": "`opencode upgrade` — or `opencode upgrade v0.1.48` for a pinned version",
        "alts": ["update", "version"]
      },
      "update": {
        "tip": "Run `opencode upgrade`; set OPENCODE_DISABLE_AUTOUPDATE=true to opt out",
        "alts": ["upgrade", "version"]
      }
    }
  },
  {
    "id": "command-list",
    "words": {
      "Ctrl+P": {
        "tip": "Press Ctrl+P to open the searchable command palette",
        "alts": ["/help", "palette"]
      },
      "/help": {
        "tip": "Type /help for the help dialog; Ctrl+P for searchable palette",
        "alts": ["Ctrl+P", "help"]
      },
      "help": {
        "tip": "/help shows commands; `opencode --help` for CLI flags",
        "alts": ["/help", "Ctrl+P", "--help"]
      }
    }
  },
  {
    "id": "themes",
    "words": {
      "/themes": {
        "tip": "Use /themes (Ctrl+X t) to switch UI theme",
        "alts": ["theme", "tui.json"]
      },
      "theme": {
        "tip": "/themes to pick; set `theme` in tui.json to persist",
        "alts": ["/themes", "tui.json"]
      }
    }
  },
  {
    "id": "pr-workflow",
    "words": {
      "pr": {
        "tip": "`opencode pr <num>` checks out a GitHub PR branch and starts opencode",
        "alts": ["github", "review"]
      },
      "github": {
        "tip": "`opencode github install` sets up GitHub Action automation",
        "alts": ["pr", "review"]
      }
    }
  }
]
```
