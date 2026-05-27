---
name: tips-gemini-cli
# Gemini CLI tip pack — slash commands (/compress, /restore, /plan,
# /memory, /chat, /resume, /mcp, /extensions, /skills, /agents, /tools,
# /hooks, /stats, /vim, /ide, /commands, /policies, /permissions, …),
# TUI keybinds (Ctrl+L clear, Ctrl+G editor, Ctrl+T todos, Ctrl+Y yolo,
# Shift+Tab approval cycle, Esc x2 rewind, F12 error), flags (--prompt,
# --approval-mode, --sandbox, --worktree, --resume, --output-format,
# --extensions), and Gemini CLI features (GEMINI.md, checkpointing,
# Plan Mode, multimodal @-injection, sandbox docker/podman, worktrees).
# Scoped to gemini-cli so trigger words don't collide with vocabulary
# on other hosts.
#
# Sibling packs: tips-claude-code/, tips-opencode/, tips-shell/.
# Verified against docs/reference/{commands,keyboard-shortcuts}.md +
# docs/cli/cli-reference.md at the v0.41.2 tag (May 2026).
on-host: [gemini-cli]
---

```json
[
  {
    "id": "context-management",
    "words": {
      "/compress": {
        "tip": "Summarize chat history to free tokens when context fills up",
        "alts": ["/clear", "/rewind", "context"]
      },
      "/clear": {
        "tip": "Wipe terminal + visible history (Ctrl+L) — keeps GEMINI.md",
        "alts": ["/compress", "Ctrl+L", "/rewind"]
      },
      "/rewind": {
        "tip": "Navigate backward through conversation history (Esc x2)",
        "alts": ["/restore", "/compress", "undo"]
      },
      "Ctrl+L": {
        "tip": "Ctrl+L clears the terminal screen and redraws the UI",
        "alts": ["/clear", "/compress"]
      },
      "Esc x2": {
        "tip": "Double-tap Esc to rewind through conversation history",
        "alts": ["/rewind", "/restore", "undo"]
      },
      "context": {
        "tip": "Manage context: /compress (summarize), /clear (fresh), /rewind (back)",
        "alts": ["/compress", "/clear", "/rewind"]
      }
    }
  },
  {
    "id": "checkpointing",
    "words": {
      "/restore": {
        "tip": "Roll project files back to a checkpoint before a tool ran",
        "alts": ["checkpoint", "undo", "revert"]
      },
      "checkpoint": {
        "tip": "Enable checkpointing in settings.json to auto-snapshot before edits",
        "alts": ["/restore", "revert", "rollback"]
      },
      "undo": {
        "tip": "Use /restore to undo — rolls files back to checkpoint state",
        "alts": ["/restore", "revert", "rollback"]
      },
      "revert": {
        "tip": "Use /restore to revert files to a pre-tool checkpoint",
        "alts": ["/restore", "undo", "rollback"]
      },
      "rollback": {
        "tip": "Use /restore to rollback files to a saved checkpoint",
        "alts": ["/restore", "undo", "revert"]
      }
    }
  },
  {
    "id": "plan-mode",
    "words": {
      "/plan": {
        "tip": "Enter Plan Mode — read-only research before any file changes",
        "alts": ["Shift+Tab", "--approval-mode", "plan"]
      },
      "plan": {
        "tip": "Use /plan or Shift+Tab to enter Plan Mode for risky changes",
        "alts": ["/plan", "Shift+Tab", "risky"]
      },
      "Shift+Tab": {
        "tip": "Shift+Tab cycles approval modes (default → auto_edit → yolo → plan)",
        "alts": ["/plan", "--approval-mode", "yolo"]
      },
      "risky": {
        "tip": "Risky change? Enter Plan Mode (/plan) to research first",
        "alts": ["/plan", "Shift+Tab", "careful"]
      },
      "careful": {
        "tip": "Be careful — use Plan Mode (/plan) to explore before changing",
        "alts": ["/plan", "Shift+Tab", "risky"]
      }
    }
  },
  {
    "id": "approval-modes",
    "words": {
      "Ctrl+Y": {
        "tip": "Ctrl+Y toggles YOLO mode — auto-approves every tool call",
        "alts": ["--yolo", "yolo", "--approval-mode"]
      },
      "--yolo": {
        "tip": "--yolo auto-approves all tool calls (prefer --approval-mode=yolo)",
        "alts": ["-y", "Ctrl+Y", "--approval-mode"]
      },
      "yolo": {
        "tip": "YOLO mode skips every approval prompt — use with care",
        "alts": ["--yolo", "Ctrl+Y", "--approval-mode"]
      },
      "--approval-mode": {
        "tip": "--approval-mode = default | auto_edit | yolo | plan",
        "alts": ["--yolo", "/plan", "Shift+Tab"]
      },
      "auto_edit": {
        "tip": "auto_edit auto-approves edits but not shell tools",
        "alts": ["--approval-mode", "yolo", "Shift+Tab"]
      }
    }
  },
  {
    "id": "sandbox",
    "words": {
      "--sandbox": {
        "tip": "--sandbox (-s) isolates tool execution in docker/podman/sandbox-exec",
        "alts": ["-s", "GEMINI_SANDBOX", "yolo"]
      },
      "sandbox": {
        "tip": "Use --sandbox (-s) to confine tool execution to a container",
        "alts": ["--sandbox", "GEMINI_SANDBOX", "yolo"]
      },
      "GEMINI_SANDBOX": {
        "tip": "Set GEMINI_SANDBOX=docker|podman|sandbox-exec to pick the backend",
        "alts": ["--sandbox", "sandbox", "-s"]
      },
      "docker": {
        "tip": "Run inside docker via --sandbox or GEMINI_SANDBOX=docker",
        "alts": ["--sandbox", "podman", "sandbox"]
      },
      "podman": {
        "tip": "Run inside podman via GEMINI_SANDBOX=podman",
        "alts": ["--sandbox", "docker", "sandbox"]
      }
    }
  },
  {
    "id": "project-config",
    "words": {
      "GEMINI.md": {
        "tip": "Put repeated instructions in GEMINI.md — Gemini follows it strictly",
        "alts": ["/memory", "/init", "remember"]
      },
      "/init": {
        "tip": "Run /init to generate a tailored GEMINI.md for your project",
        "alts": ["GEMINI.md", "/memory", "remember"]
      },
      "/memory": {
        "tip": "/memory add|show|refresh|list manages GEMINI.md context files",
        "alts": ["GEMINI.md", "/init", "remember"]
      },
      "remember": {
        "tip": "Put repeated instructions in GEMINI.md — Gemini follows it strictly",
        "alts": ["GEMINI.md", "/memory", "/init"]
      }
    }
  },
  {
    "id": "mcp-extensions",
    "words": {
      "/mcp": {
        "tip": "/mcp list|enable|disable|reload manages MCP servers",
        "alts": ["mcp", "/extensions", "server"]
      },
      "mcp": {
        "tip": "Configure MCP servers in ~/.gemini/settings.json for extra tools",
        "alts": ["/mcp", "/extensions", "server"]
      },
      "/extensions": {
        "tip": "/extensions install|enable|disable|update manages extensions",
        "alts": ["-e", "--extensions", "/mcp"]
      },
      "extension": {
        "tip": "Use /extensions to install or toggle Gemini CLI extensions",
        "alts": ["/extensions", "--extensions", "/mcp"]
      },
      "--extensions": {
        "tip": "--extensions (-e) restricts which extensions load this session",
        "alts": ["-e", "/extensions"]
      },
      "server": {
        "tip": "MCP servers provide external tool integrations — see /mcp",
        "alts": ["/mcp", "mcp", "/extensions"]
      }
    }
  },
  {
    "id": "skills-agents",
    "words": {
      "/skills": {
        "tip": "/skills list|enable|disable manages Agent Skills for workflows",
        "alts": ["skill", "/agents", "/commands"]
      },
      "skill": {
        "tip": "Use /skills to manage reusable specialized workflows",
        "alts": ["/skills", "/agents", "custom command"]
      },
      "/agents": {
        "tip": "/agents list|enable|disable|reload manages local/remote subagents",
        "alts": ["/skills", "subagent", "/commands"]
      },
      "subagent": {
        "tip": "Use /agents to spawn or manage subagents for delegated work",
        "alts": ["/agents", "/skills"]
      },
      "/commands": {
        "tip": "/commands reload picks up new TOML custom slash commands",
        "alts": ["custom command", "/skills"]
      },
      "custom command": {
        "tip": "Drop a .toml file in commands dir, run /commands reload",
        "alts": ["/commands", "/skills"]
      }
    }
  },
  {
    "id": "session-management",
    "words": {
      "/chat": {
        "tip": "/chat save|list|resume|delete manages saved chat sessions",
        "alts": ["/resume", "--resume", "session"]
      },
      "/resume": {
        "tip": "/resume save|list|resume|delete browses and continues sessions",
        "alts": ["--resume", "/chat", "session"]
      },
      "--resume": {
        "tip": "--resume (-r) continues a session — use 'latest' or index",
        "alts": ["-r", "/resume", "/chat"]
      },
      "session": {
        "tip": "Save with /chat save NAME, continue with --resume NAME",
        "alts": ["/chat", "/resume", "--resume"]
      },
      "--list-sessions": {
        "tip": "--list-sessions prints all saved sessions for this project",
        "alts": ["/resume", "--resume", "session"]
      }
    }
  },
  {
    "id": "model-selection",
    "words": {
      "/model": {
        "tip": "/model set <name> switches model mid-session",
        "alts": ["--model", "-m", "gemini"]
      },
      "--model": {
        "tip": "--model (-m) picks the model at launch (e.g. gemini-3-pro)",
        "alts": ["-m", "/model", "gemini"]
      },
      "gemini": {
        "tip": "Switch models with /model set or --model gemini-3-pro",
        "alts": ["/model", "--model", "-m"]
      },
      "pro": {
        "tip": "Gemini Pro for complex reasoning — more cost, deeper thought",
        "alts": ["/model", "--model", "flash"]
      },
      "flash": {
        "tip": "Gemini Flash for fast, cheaper tasks — lower latency",
        "alts": ["/model", "--model", "pro"]
      }
    }
  },
  {
    "id": "headless",
    "words": {
      "--prompt": {
        "tip": "--prompt (-p) forces non-interactive mode for CI/scripting",
        "alts": ["-p", "ci", "headless"]
      },
      "-p": {
        "tip": "-p '<prompt>' runs once and exits — ideal for pipelines",
        "alts": ["--prompt", "ci", "headless"]
      },
      "headless": {
        "tip": "Use -p for headless runs, --output-format json for parsing",
        "alts": ["--prompt", "-p", "--output-format"]
      },
      "ci": {
        "tip": "CI/CD: gemini -p '...' --output-format json (-o json)",
        "alts": ["--prompt", "-p", "--output-format"]
      },
      "pipeline": {
        "tip": "Pipelines: gemini -p '<task>' -o json for parseable output",
        "alts": ["--prompt", "ci", "--output-format"]
      },
      "--output-format": {
        "tip": "--output-format text|json|stream-json (-o) for headless parsing",
        "alts": ["-o", "--prompt", "ci"]
      },
      "--prompt-interactive": {
        "tip": "--prompt-interactive (-i) seeds a prompt then stays interactive",
        "alts": ["-i", "--prompt", "-p"]
      }
    }
  },
  {
    "id": "shell-files",
    "words": {
      "!": {
        "tip": "! prefix runs a shell command (!git status); ! alone toggles shell mode",
        "alts": ["shell", "bash", "terminal"]
      },
      "shell": {
        "tip": "Type ! then a command, or ! alone to toggle shell mode",
        "alts": ["!", "bash", "terminal"]
      },
      "bash": {
        "tip": "Use ! prefix for bash commands (PowerShell on Windows)",
        "alts": ["!", "shell", "terminal"]
      },
      "@": {
        "tip": "@path/to/file injects file or directory contents into the prompt",
        "alts": ["file", "include", "context"]
      },
      "file": {
        "tip": "Use @<path> to inject a file — git-aware ignores excluded paths",
        "alts": ["@", "include"]
      },
      "--include-directories": {
        "tip": "--include-directories adds extra workspace dirs (monorepo)",
        "alts": ["/directory", "monorepo"]
      },
      "/directory": {
        "tip": "/directory add <path> adds a workspace dir mid-session",
        "alts": ["--include-directories", "monorepo", "@"]
      },
      "monorepo": {
        "tip": "Monorepo? Use --include-directories or /directory add",
        "alts": ["--include-directories", "/directory", "@"]
      }
    }
  },
  {
    "id": "editing",
    "words": {
      "Ctrl+G": {
        "tip": "Ctrl+G opens the current prompt or plan in your $EDITOR",
        "alts": ["editor", "/editor", "multiline"]
      },
      "/editor": {
        "tip": "Use /editor to pick which external editor Ctrl+G opens",
        "alts": ["Ctrl+G", "editor", "multiline"]
      },
      "editor": {
        "tip": "Press Ctrl+G to edit the prompt in your external editor",
        "alts": ["Ctrl+G", "/editor", "multiline"]
      },
      "multiline": {
        "tip": "Ctrl+Enter or Alt+Enter inserts a newline; Ctrl+G opens $EDITOR",
        "alts": ["Ctrl+G", "Ctrl+Enter", "/terminal-setup"]
      },
      "/terminal-setup": {
        "tip": "Run /terminal-setup to configure Shift+Enter for newlines",
        "alts": ["multiline", "Shift+Enter", "linebreak"]
      },
      "Shift+Enter": {
        "tip": "Run /terminal-setup once so Shift+Enter inserts a newline",
        "alts": ["/terminal-setup", "Ctrl+Enter", "multiline"]
      },
      "linebreak": {
        "tip": "Ctrl+Enter / Alt+Enter for newline, or /terminal-setup once",
        "alts": ["Shift+Enter", "Ctrl+Enter", "multiline"]
      },
      "/vim": {
        "tip": "/vim toggles vim mode (NORMAL/INSERT) for the input line",
        "alts": ["vim", "modal", "Esc"]
      },
      "vim": {
        "tip": "Toggle vim mode with /vim — hjkl, dd, cw all work",
        "alts": ["/vim", "modal", "Esc"]
      }
    }
  },
  {
    "id": "history",
    "words": {
      "Ctrl+R": {
        "tip": "Ctrl+R reverse-searches command history",
        "alts": ["Ctrl+P", "Ctrl+N", "history"]
      },
      "Ctrl+P": {
        "tip": "Ctrl+P shows the previous history entry",
        "alts": ["Ctrl+N", "Ctrl+R", "history"]
      },
      "Ctrl+N": {
        "tip": "Ctrl+N shows the next history entry",
        "alts": ["Ctrl+P", "Ctrl+R", "history"]
      },
      "history": {
        "tip": "Ctrl+P/Ctrl+N walk history; Ctrl+R searches it",
        "alts": ["Ctrl+R", "Ctrl+P", "Ctrl+N"]
      }
    }
  },
  {
    "id": "todo-status",
    "words": {
      "Ctrl+T": {
        "tip": "Ctrl+T toggles the full TODO list view",
        "alts": ["todo", "/stats", "/shells"]
      },
      "todo": {
        "tip": "Press Ctrl+T to see all in-flight TODOs at once",
        "alts": ["Ctrl+T", "/stats"]
      },
      "/stats": {
        "tip": "/stats session|model|tools shows token + tool usage",
        "alts": ["tokens", "usage", "/model"]
      },
      "tokens": {
        "tip": "Use /stats to check token consumption this session",
        "alts": ["/stats", "/compress", "limit"]
      },
      "usage": {
        "tip": "Check usage with /stats, free space with /compress",
        "alts": ["/stats", "/compress", "tokens"]
      },
      "limit": {
        "tip": "Approaching limit? Run /compress to summarize and free space",
        "alts": ["/compress", "/stats", "tokens"]
      },
      "/shells": {
        "tip": "/shells toggles the background-shells view for long jobs",
        "alts": ["background", "shell", "Ctrl+T"]
      }
    }
  },
  {
    "id": "git-worktrees",
    "words": {
      "--worktree": {
        "tip": "--worktree (-w) starts Gemini in a fresh git worktree",
        "alts": ["-w", "worktree", "branches"]
      },
      "worktree": {
        "tip": "Use --worktree (-w) for parallel Gemini sessions per branch",
        "alts": ["--worktree", "-w", "branches"]
      },
      "branches": {
        "tip": "Spin up a worktree per branch with --worktree NAME",
        "alts": ["--worktree", "worktree", "parallel sessions"]
      },
      "parallel sessions": {
        "tip": "Use git worktrees (--worktree) for parallel Gemini sessions",
        "alts": ["--worktree", "worktree", "branches"]
      }
    }
  },
  {
    "id": "tools-permissions",
    "words": {
      "/tools": {
        "tip": "/tools lists available tools; /tools desc shows descriptions",
        "alts": ["tools", "/permissions", "/mcp"]
      },
      "tools": {
        "tip": "See /tools for the active toolset; /tools desc for details",
        "alts": ["/tools", "/permissions", "/mcp"]
      },
      "/permissions": {
        "tip": "/permissions trust manages folder trust + tool approvals",
        "alts": ["trust", "--skip-trust", "/policies"]
      },
      "trust": {
        "tip": "Use /permissions trust to mark a folder as trusted",
        "alts": ["/permissions", "--skip-trust"]
      },
      "--skip-trust": {
        "tip": "--skip-trust trusts the workspace once without folder-trust dialog",
        "alts": ["/permissions", "trust"]
      },
      "/policies": {
        "tip": "/policies list shows active policy-engine rules by mode",
        "alts": ["/permissions", "trust", "/hooks"]
      }
    }
  },
  {
    "id": "hooks",
    "words": {
      "/hooks": {
        "tip": "/hooks list|enable|disable manages lifecycle event hooks",
        "alts": ["hook", "automation", "lifecycle"]
      },
      "hook": {
        "tip": "Configure lifecycle hooks (pre/post tool) via /hooks",
        "alts": ["/hooks", "automation", "lifecycle"]
      },
      "automation": {
        "tip": "Hooks automate actions before/after tool use — see /hooks",
        "alts": ["/hooks", "hook", "lifecycle"]
      },
      "lifecycle": {
        "tip": "Hook into Gemini's lifecycle via /hooks list/enable/disable",
        "alts": ["/hooks", "hook", "automation"]
      }
    }
  },
  {
    "id": "ide-integration",
    "words": {
      "/ide": {
        "tip": "/ide install|enable|status manages IDE integration",
        "alts": ["ide", "vscode", "zed"]
      },
      "ide": {
        "tip": "Use /ide install to wire Gemini into your IDE",
        "alts": ["/ide", "vscode", "zed"]
      },
      "vscode": {
        "tip": "Run /ide install to set up VS Code integration",
        "alts": ["/ide", "ide", "zed"]
      },
      "zed": {
        "tip": "--experimental-zed-integration runs Gemini in Zed editor mode",
        "alts": ["/ide", "ide", "vscode"]
      }
    }
  },
  {
    "id": "multimodal",
    "words": {
      "image": {
        "tip": "Inject an image with @image.png — Gemini reads it natively",
        "alts": ["@", "pdf", "multimodal"]
      },
      "pdf": {
        "tip": "Inject a PDF with @file.pdf — Gemini parses it multimodally",
        "alts": ["@", "image", "multimodal"]
      },
      "multimodal": {
        "tip": "Use @path to drop images / PDFs / sketches into the prompt",
        "alts": ["@", "image", "pdf"]
      },
      "screenshot": {
        "tip": "Inject screenshots with @path.png — Gemini sees them directly",
        "alts": ["@", "image", "multimodal"]
      }
    }
  },
  {
    "id": "help",
    "words": {
      "/help": {
        "tip": "/help lists all available slash commands",
        "alts": ["/about", "/docs", "/bug"]
      },
      "/about": {
        "tip": "/about prints version info — share when filing /bug reports",
        "alts": ["/help", "/bug", "version"]
      },
      "/docs": {
        "tip": "/docs opens the Gemini CLI documentation in your browser",
        "alts": ["/help", "/about"]
      },
      "/bug": {
        "tip": "/bug files a GitHub issue with /about info pre-filled",
        "alts": ["/about", "/help", "issue"]
      },
      "help": {
        "tip": "/help lists commands; /docs opens docs; /bug files an issue",
        "alts": ["/help", "/docs", "/bug"]
      }
    }
  },
  {
    "id": "exit-control",
    "words": {
      "/quit": {
        "tip": "/quit (or /exit) leaves Gemini CLI cleanly",
        "alts": ["/exit", "Ctrl+D", "Ctrl+C"]
      },
      "/exit": {
        "tip": "/exit is an alias for /quit",
        "alts": ["/quit", "Ctrl+D", "Ctrl+C"]
      },
      "Ctrl+C": {
        "tip": "Ctrl+C cancels the current request; on empty input it exits",
        "alts": ["/quit", "Ctrl+D", "Esc"]
      },
      "Ctrl+D": {
        "tip": "Ctrl+D exits when the input buffer is empty",
        "alts": ["/quit", "/exit", "Ctrl+C"]
      },
      "Esc": {
        "tip": "Esc dismisses dialogs and cancels focus (not a quit)",
        "alts": ["Ctrl+C", "/quit", "Esc x2"]
      }
    }
  },
  {
    "id": "debugging",
    "words": {
      "--debug": {
        "tip": "--debug (-d) enables verbose logging for troubleshooting",
        "alts": ["-d", "debug", "F12"]
      },
      "debug": {
        "tip": "Run with --debug, check F12 for error details",
        "alts": ["--debug", "-d", "F12"]
      },
      "F12": {
        "tip": "Press F12 in the TUI to see the latest error details",
        "alts": ["--debug", "debug", "/bug"]
      },
      "bug": {
        "tip": "Hit a bug? F12 for details, /bug to file, /restore to recover",
        "alts": ["/bug", "F12", "/restore"]
      },
      "broken": {
        "tip": "Broken state? /restore reverts files, /rewind walks history",
        "alts": ["/restore", "/rewind", "/bug"]
      }
    }
  },
  {
    "id": "auth-config",
    "words": {
      "/auth": {
        "tip": "/auth opens the auth dialog (OAuth / API key / Vertex AI)",
        "alts": ["GEMINI_API_KEY", "vertex", "oauth"]
      },
      "GEMINI_API_KEY": {
        "tip": "Set GEMINI_API_KEY env var for Gemini API access",
        "alts": ["/auth", "oauth", "vertex"]
      },
      "vertex": {
        "tip": "GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_API_KEY for Vertex AI",
        "alts": ["/auth", "GEMINI_API_KEY", "oauth"]
      },
      "oauth": {
        "tip": "Sign in with Google via /auth — free tier 60/min, 1000/day",
        "alts": ["/auth", "GEMINI_API_KEY", "vertex"]
      },
      "/settings": {
        "tip": "/settings opens the settings editor for ~/.gemini/settings.json",
        "alts": ["settings.json", "/theme", "/editor"]
      },
      "/theme": {
        "tip": "/theme changes Gemini CLI's visual theme",
        "alts": ["/settings", "theme"]
      },
      "/privacy": {
        "tip": "/privacy shows the privacy notice and data-collection toggles",
        "alts": ["/settings", "/auth"]
      }
    }
  },
  {
    "id": "fearless",
    "words": {
      "experiment": {
        "tip": "Experiment fearlessly — /restore reverts files, /rewind history",
        "alts": ["try", "test", "fearless"]
      },
      "fearless": {
        "tip": "Be fearless — checkpointing + /restore undo failed experiments",
        "alts": ["experiment", "/restore", "checkpoint"]
      },
      "try": {
        "tip": "Try anything in Plan Mode first (/plan) before committing",
        "alts": ["/plan", "experiment", "fearless"]
      }
    }
  }
]
```
