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
        "when": "says the model forgot things, the session has got long, or asks how to free up context",
        "say": "Losing the thread? /compress summarises the session and frees tokens"
      },
      "/clear": {
        "tip": "Wipe terminal + visible history (Ctrl+L) — keeps GEMINI.md",
        "when": "wants to start over or begin an unrelated task",
        "say": "Starting over? /clear wipes the visible history; GEMINI.md stays"
      },
      "/rewind": {
        "tip": "Navigate backward through conversation history (Esc x2)",
        "when": "wants to go back to an earlier point in the conversation",
        "say": "Want to go back? /rewind (Esc twice) steps back through the conversation"
      }
    }
  },
  {
    "id": "checkpointing",
    "words": {
      "/restore": {
        "tip": "Roll project files back to a checkpoint before a tool ran",
        "when": "wants to undo or take back what the assistant just changed in their files",
        "say": "Undo what it just did? /restore rolls the files back to the checkpoint before the tool ran"
      },
      "checkpoint": {
        "tip": "Enable checkpointing in settings.json to auto-snapshot before edits",
        "when": "worries about losing work before letting it edit, or asks how to make changes reversible",
        "say": "Want a safety net? Enable checkpointing in settings.json so every edit gets a snapshot"
      }
    }
  },
  {
    "id": "plan-mode",
    "words": {
      "/plan": {
        "tip": "Enter Plan Mode — read-only research before any file changes",
        "when": "wants it to plan or research before touching files, or calls a change risky",
        "say": "Risky change? /plan researches first and edits nothing; Shift+Tab cycles the modes"
      }
    }
  },
  {
    "id": "approval-modes",
    "words": {
      "--approval-mode": {
        "tip": "--approval-mode = default | auto_edit | yolo | plan",
        "when": "is tired of approving every tool call, or asks how to auto-approve",
        "say": "Tired of approving? --approval-mode auto_edit approves edits only; yolo approves everything, with care"
      }
    }
  },
  {
    "id": "sandbox",
    "words": {
      "--sandbox": {
        "tip": "--sandbox (-s) isolates tool execution in docker/podman/sandbox-exec",
        "when": "worries about a tool running something harmful on their machine, or wants its commands run in a container",
        "say": "Worried what it might run? --sandbox confines tools to a container (docker, podman or sandbox-exec)"
      }
    }
  },
  {
    "id": "project-config",
    "words": {
      "GEMINI.md": {
        "tip": "Put repeated instructions in GEMINI.md — Gemini follows it strictly",
        "when": "repeats an instruction it keeps ignoring, or says it forgets a rule every session",
        "say": "Keep repeating a rule? Put it in GEMINI.md; /init scaffolds one, /memory shows what is loaded"
      }
    }
  },
  {
    "id": "mcp-extensions",
    "words": {
      "/mcp": {
        "tip": "/mcp list|enable|disable|reload manages MCP servers",
        "when": "wants to connect a tool, service or data source",
        "say": "Connecting a tool? Add an MCP server in ~/.gemini/settings.json; /mcp lists and toggles them"
      },
      "/extensions": {
        "tip": "/extensions install|enable|disable|update manages extensions",
        "when": "asks how to add a feature, plugin or extension to the CLI",
        "say": "Adding a capability? /extensions install picks up Gemini CLI extensions"
      }
    }
  },
  {
    "id": "skills-agents",
    "words": {
      "/agents": {
        "tip": "/agents list|enable|disable|reload manages local/remote subagents",
        "when": "wants part of the work delegated to a separate agent or subagent",
        "say": "Delegating? /agents lists and enables subagents for the work"
      },
      "/commands": {
        "tip": "/commands reload picks up new TOML custom slash commands",
        "when": "does the same prompt every day and wants it as a command",
        "say": "Same prompt daily? A .toml in the commands dir becomes a slash command; /commands reload picks it up"
      }
    }
  },
  {
    "id": "session-management",
    "words": {
      "/chat": {
        "tip": "/chat save|list|resume|delete manages saved chat sessions",
        "when": "wants to save this session, name it, or find it later",
        "say": "Want this later? /chat save NAME, then --resume NAME brings it back"
      },
      "--resume": {
        "tip": "--resume (-r) continues a session — use 'latest' or index",
        "when": "closed the terminal or wants an earlier session back",
        "say": "Closed it? gemini --resume latest reopens the last session; --list-sessions shows the rest"
      }
    }
  },
  {
    "id": "model-selection",
    "words": {
      "/model": {
        "tip": "/model set <name> switches model mid-session",
        "when": "asks which model to use, complains about cost or speed, or wants a stronger or cheaper model",
        "say": "Cost or speed? /model set gemini-flash for quick work, pro for deep reasoning"
      }
    }
  },
  {
    "id": "headless",
    "words": {
      "-p": {
        "tip": "-p '<prompt>' runs once and exits — ideal for pipelines",
        "when": "wants to run it from a script, a CI job or a pipeline",
        "say": "Scripting it? gemini -p '<task>' runs once; -o json gives parseable output"
      }
    }
  },
  {
    "id": "shell-files",
    "words": {
      "!": {
        "tip": "! prefix runs a shell command (!git status); ! alone toggles shell mode",
        "when": "wants to run a quick shell command without leaving the prompt",
        "say": "A quick shell command? Start the line with ! and it runs right here"
      },
      "@": {
        "tip": "@path/to/file injects file or directory contents into the prompt",
        "when": "describes a file's contents instead of showing it, or asks it to look at a file",
        "say": "Talking about a file? @path/to/file puts its contents in the prompt"
      },
      "--include-directories": {
        "tip": "--include-directories adds extra workspace dirs (monorepo)",
        "when": "needs another directory or repo in the session, or works in a monorepo",
        "say": "Another directory? /directory add <path> now, or --include-directories at launch"
      }
    }
  },
  {
    "id": "editing",
    "words": {
      "Ctrl+G": {
        "tip": "Ctrl+G opens the current prompt or plan in your $EDITOR",
        "when": "is writing a long or multi-line prompt, or fighting the input box",
        "say": "Long prompt? Ctrl+G opens it in your editor; /editor picks which one"
      },
      "/terminal-setup": {
        "tip": "Run /terminal-setup to configure Shift+Enter for newlines",
        "when": "complains that Enter sends the message when they wanted a new line",
        "say": "Enter sending too early? /terminal-setup once makes Shift+Enter a newline; Ctrl+Enter works now"
      },
      "/vim": {
        "tip": "/vim toggles vim mode (NORMAL/INSERT) for the input line",
        "when": "wishes the input line had vim keys",
        "say": "Miss vim keys? /vim toggles NORMAL and INSERT on the input line"
      }
    }
  },
  {
    "id": "history",
    "words": {
      "Ctrl+R": {
        "tip": "Ctrl+R reverse-searches command history",
        "when": "wants to re-run or find a prompt they typed earlier in this CLI",
        "say": "Looking for an earlier prompt? Ctrl+R searches history; Ctrl+P and Ctrl+N walk it"
      }
    }
  },
  {
    "id": "todo-status",
    "words": {
      "Ctrl+T": {
        "tip": "Ctrl+T toggles the full TODO list view",
        "when": "asks what is still left to do or wants the task list",
        "say": "Lost track of the tasks? Ctrl+T shows every in-flight TODO"
      },
      "/stats": {
        "tip": "/stats session|model|tools shows token + tool usage",
        "when": "asks what this is costing, how many tokens it has used, or has hit a limit",
        "say": "Tokens or limits? /stats shows usage this session; /compress frees space"
      },
      "/shells": {
        "tip": "/shells toggles the background-shells view for long jobs",
        "when": "started a long-running command and wants to see it",
        "say": "A long job running? /shells shows the background shells"
      }
    }
  },
  {
    "id": "git-worktrees",
    "words": {
      "--worktree": {
        "tip": "--worktree (-w) starts Gemini in a fresh git worktree",
        "when": "wants to run several tasks in parallel, or keep a hotfix off the current branch",
        "say": "Several tasks at once? gemini --worktree NAME gives each its own checkout"
      }
    }
  },
  {
    "id": "tools-permissions",
    "words": {
      "/tools": {
        "tip": "/tools lists available tools; /tools desc shows descriptions",
        "when": "asks what the assistant can do, what it has access to, or which tools it has",
        "say": "Wondering what it can do? /tools lists the active tools; /tools desc explains them"
      },
      "/permissions": {
        "tip": "/permissions trust manages folder trust + tool approvals",
        "when": "gets a folder-trust prompt or asks about trusting the workspace",
        "say": "Trust prompt? /permissions trust marks the folder trusted; --skip-trust for a one-off"
      }
    }
  },
  {
    "id": "hooks",
    "words": {
      "/hooks": {
        "tip": "/hooks list|enable|disable manages lifecycle event hooks",
        "when": "wants something to run automatically before or after every edit or tool call",
        "say": "Want it automatic? /hooks manages the lifecycle hooks around tool calls"
      }
    }
  },
  {
    "id": "ide-integration",
    "words": {
      "/ide": {
        "tip": "/ide install|enable|status manages IDE integration",
        "when": "wants it inside their editor or asks about VS Code",
        "say": "Want it in the editor? /ide install wires up VS Code"
      }
    }
  },
  {
    "id": "multimodal",
    "words": {
      "screenshot": {
        "tip": "Inject screenshots with @path.png — Gemini sees them directly",
        "when": "describes something visual — a layout, a design, a diagram — without attaching an image of it",
        "say": "Something visual? @path.png drops the screenshot in; it reads images and PDFs directly"
      }
    }
  },
  {
    "id": "help",
    "words": {
      "/help": {
        "tip": "/help lists all available slash commands",
        "when": "asks which slash commands exist or how to see them all",
        "say": "Not sure what exists? /help lists every command; /docs opens the docs"
      },
      "/bug": {
        "tip": "/bug files a GitHub issue with /about info pre-filled",
        "when": "hit a bug in the CLI itself and wants to report it",
        "say": "A bug in the CLI? /bug files an issue with the /about info filled in"
      }
    }
  },
  {
    "id": "exit-control",
    "words": {
      "/quit": {
        "tip": "/quit (or /exit) leaves Gemini CLI cleanly",
        "when": "asks how to quit or leave cleanly",
        "say": "Leaving? /quit exits cleanly; Ctrl+D on an empty line does too"
      }
    }
  },
  {
    "id": "debugging",
    "words": {
      "--debug": {
        "tip": "--debug (-d) enables verbose logging for troubleshooting",
        "when": "says the CLI itself is misbehaving and they cannot see why",
        "say": "CLI misbehaving? F12 shows the last error; --debug logs everything; /bug reports it"
      }
    }
  },
  {
    "id": "auth-config",
    "words": {
      "/auth": {
        "tip": "/auth opens the auth dialog (OAuth / API key / Vertex AI)",
        "when": "asks how to sign in to the CLI, which Google API key or account it uses, or about Vertex AI",
        "say": "Signing in? /auth picks Google OAuth, an API key or Vertex AI"
      },
      "/settings": {
        "tip": "/settings opens the settings editor for ~/.gemini/settings.json",
        "when": "wants to change how the CLI behaves",
        "say": "Changing a setting? /settings edits ~/.gemini/settings.json in place"
      },
      "/privacy": {
        "tip": "/privacy shows the privacy notice and data-collection toggles",
        "when": "worries whether their code or data is collected",
        "say": "Data worries? /privacy shows the notice and the collection toggles"
      }
    }
  },
  {
    "id": "fearless",
    "words": {
      "experiment": {
        "tip": "Experiment fearlessly — /restore reverts files, /rewind history",
        "when": "hesitates to try something because it might break things",
        "say": "Worried it breaks? Try it; /restore reverts the files, /rewind the conversation"
      }
    }
  }
]
```
