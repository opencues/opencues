---
name: tips-claude-code
# Claude Code tip pack — slash commands (/compact, /clear, /rewind,
# /model, /usage, …), CC keybindings (Esc x2, Shift+Tab, Ctrl+G/R),
# CC flags (--print, --add-dir, --dangerously-skip-permissions), and
# CC features (CLAUDE.md, hooks, MCP, plan mode, skills, ultrathink).
# Scoped to claude-code so trigger words don't collide with vocabulary
# on other hosts.
#
# Sibling packs: tips-opencode/, tips-gemini-cli/, tips-shell/. The
# folder loader's host-compat filter (discover.ts:isAllowedOnHost)
# skips each pack on every host outside its on-host list. The
# `tips-mode` scalar in OPENCUES.md gates tip RENDERING for all packs
# uniformly.
on-host: [claude-code]
---

```json
[
  {
    "id": "ci-cd",
    "words": {
      "--print": {
        "tip": "Use --print flag for CI/CD non-interactive execution",
        "when": "wants to run it from a script, a CI job or a pipeline with no one at the keyboard",
        "say": "Scripting it? claude --print runs one prompt non-interactively and exits"
      }
    }
  },
  {
    "id": "context-management",
    "words": {
      "/compact": {
        "tip": "Summarize history when 'context limit' warning appears",
        "when": "says the model forgot the plan or earlier instructions, the session has got long, or asks how to keep context from filling up",
        "say": "Losing the thread? /compact summarises the session; add a focus to say what to keep"
      },
      "/clear": {
        "tip": "Fresh start - clears context but keeps CLAUDE.md",
        "when": "wants to start over, begin an unrelated task, or says the conversation is polluted or the model keeps circling",
        "say": "Starting over? /clear wipes the conversation, CLAUDE.md stays"
      },
      "/rewind": {
        "tip": "Undo everything - rolls back context AND file changes",
        "when": "wants to undo what the assistant just changed, or go back to before a failed attempt (not an undo inside their own code or data)",
        "say": "Undo what it just did: /rewind (or Esc twice) restores code and conversation to a checkpoint"
      },
      "undo": {
        "tip": "Use /rewind (Esc x2) to undo - rolls back context AND file changes",
        "when": "wants to undo or take back what the ASSISTANT just changed or did (not an undo inside their own code, database or app)",
        "say": "Undo what it just did: /rewind restores code and conversation; git covers what bash changed"
      },
      "context": {
        "tip": "Manage context: /compact (summarize), /clear (fresh), /rewind (undo all)",
        "when": "asks what is taking up the context window, how much of it is left, or how to see it",
        "say": "Context filling up? /context shows what takes it; /compact at 60%, /clear between tasks"
      }
    }
  },
  {
    "id": "debugging",
    "words": {
      "fix": {
        "tip": "Stuck on a fix? /rewind rolls back code AND context",
        "when": "asks it to fix, debug or look at something broken without pasting the error text",
        "say": "Asking for a fix? Paste the error and the stack trace, and say what fixed looks like"
      },
      "screenshot": {
        "tip": "Paste an image from the clipboard with Ctrl+V (Alt+V on Windows/WSL); drag-and-drop works too",
        "when": "describes something visual — a layout, a design, how a page or component looks — without attaching an image of it",
        "say": "Something visual? Paste a screenshot with Ctrl+V (Alt+V on Windows/WSL) so it can see what you see"
      }
    }
  },
  {
    "id": "editing",
    "words": {
      "Ctrl+G": {
        "tip": "Press Ctrl+G to edit prompts in external editor",
        "when": "is writing a long or multi-line prompt, or fighting the input box for a paragraph",
        "say": "Long prompt? Ctrl+G opens it in your editor"
      }
    }
  },
  {
    "id": "extended-thinking",
    "words": {
      "ultrathink": {
        "tip": "Add ultrathink to prompt for max reasoning",
        "when": "asks for deeper reasoning, says think harder or take your time on a hard problem",
        "say": "A hard one? Put ultrathink in the prompt for the deepest reasoning this turn"
      }
    }
  },
  {
    "id": "git",
    "words": {
      "git": {
        "tip": "Check if recent git changes correlate with new errors",
        "when": "a new error appeared after recent changes and they are not sure what caused it",
        "say": "New error after changes? Ask it to check the recent git changes for the cause"
      },
      "commit": {
        "tip": "Use /config to manage commit attribution settings",
        "when": "is about to commit or asks the model to commit",
        "say": "Committing? Say \"commit with a descriptive message on a new branch\" and it drives git"
      }
    }
  },
  {
    "id": "git-worktrees",
    "words": {
      "worktree": {
        "tip": "Use git worktrees (--worktree) for parallel Claude sessions",
        "when": "wants SEPARATE tasks running in separate sessions at the same time, or a hotfix kept off the current branch",
        "say": "Several tasks at once? claude --worktree gives each its own checkout, 3 to 5 in parallel"
      }
    }
  },
  {
    "id": "help",
    "words": {
      "/help": {
        "tip": "Use /help to see all available commands",
        "when": "asks what commands exist or how to do something in the tool",
        "say": "Not sure what exists? /help lists every command; type / to filter"
      },
      "/doctor": {
        "tip": "Use /doctor to diagnose Claude Code setup issues",
        "when": "says the install or setup is broken, or CLAUDE.md is bloated",
        "say": "Setup feels broken? /doctor checks the install and trims a bloated CLAUDE.md"
      }
    }
  },
  {
    "id": "hooks",
    "words": {
      "hooks": {
        "tip": "Use hooks (PreToolUse, PostToolUse) for automation",
        "when": "wants something to happen automatically after every edit, like formatting or a test run",
        "say": "Want it automatic on every edit? A PostToolUse hook runs the formatter; see /hooks"
      }
    }
  },
  {
    "id": "large-files",
    "words": {
      "large": {
        "tip": "Break large files into smaller ones - reduces context waste",
        "when": "says a file is too large, or that context is being wasted on a big file",
        "say": "A huge file? Split it into smaller modules; less of it lands in context each turn"
      }
    }
  },
  {
    "id": "lsp",
    "words": {
      "lsp": {
        "tip": "Set ENABLE_LSP_TOOL=1 for IDE-level code intelligence",
        "when": "wants go-to-definition or type-aware navigation",
        "say": "Go-to-definition? A code-intelligence plugin from /plugin adds it"
      }
    }
  },
  {
    "id": "mcp-extensions",
    "words": {
      "mcp": {
        "tip": "Configure MCP servers in ~/.claude.json for extra tools",
        "when": "wants to connect an external tool or data source",
        "say": "Connecting a tool or data source? claude mcp add, then /mcp shows what is live"
      }
    }
  },
  {
    "id": "model-selection",
    "words": {
      "/model": {
        "tip": "Use /model command to switch models mid-session",
        "when": "asks which model to use, complains about cost or speed, or wants a stronger or cheaper model",
        "say": "Cost or speed? /model sonnet for routine work, opus for architecture, haiku for quick reads"
      }
    }
  },
  {
    "id": "multi-project",
    "words": {
      "--add-dir": {
        "tip": "Use --add-dir to access multiple projects",
        "when": "needs it to see a second repo or a directory outside the current one, or works in a monorepo",
        "say": "Another directory? claude --add-dir <path> brings it into the session"
      }
    }
  },
  {
    "id": "parallel-execution",
    "groups": [
      {
        "synonyms": [
          "agents",
          "sub-agents",
          "subagents",
          "parallel agents",
          "spawn"
        ],
        "tip": "Spawn parallel workers via Task tool - faster for multi-file ops",
        "when": "wants ONE big job inside this session split across parallel workers — a multi-file search, refactor or review — or asks for several parts of it at once",
        "say": "Big multi-file job? Ask for parallel subagents; the Task tool splits it up"
      }
    ]
  },
  {
    "id": "permissions",
    "words": {
      "permission": {
        "tip": "Use allowedTools config instead of --dangerously-skip-permissions",
        "when": "complains the tool keeps asking for permission, or wants fewer prompts",
        "say": "Tired of approving? /permissions allow rules like Bash(git *), or Shift+Tab to auto mode"
      }
    }
  },
  {
    "id": "plan-mode",
    "words": {
      "plan": {
        "tip": "Use plan mode (Shift+Tab x2) - research before making changes",
        "when": "asks the model to plan first, wants to see the steps before any file is touched, or is starting a change across several files",
        "say": "A change across several files? Ask for a plan first: Shift+Tab twice, approve, then let it edit"
      }
    }
  },
  {
    "id": "project-config",
    "words": {
      "CLAUDE.md": {
        "tip": "Put repeated instructions in CLAUDE.md - Claude follows it strictly",
        "when": "repeats an instruction it keeps ignoring, or says it forgets a rule every session",
        "say": "Keep repeating a rule? Put it in CLAUDE.md; it is read every session"
      },
      "/config": {
        "tip": "Use /config with search to find settings quickly",
        "when": "wants to change a setting of the tool itself",
        "say": "Changing how the tool behaves? /config holds its own settings"
      }
    }
  },
  {
    "id": "search",
    "words": {
      "grep": {
        "tip": "Install ripgrep - auto-respects .gitignore, faster than grep",
        "when": "mentions grep being slow or hitting node_modules, or asks about searching files faster",
        "say": "Slow grep? Install ripgrep (rg); it skips .gitignore paths and is much faster"
      }
    }
  },
  {
    "id": "security",
    "words": {
      "security": {
        "tip": "Request security review - Claude checks for vulnerabilities",
        "when": "asks whether the code is safe, or wants vulnerabilities found",
        "say": "Worried about vulnerabilities? Ask for a security review; it checks injection, auth and secrets"
      }
    }
  },
  {
    "id": "session-control",
    "words": {
      "Ctrl+Z": {
        "tip": "Press Ctrl+Z to suspend, fg to resume - don't restart",
        "when": "wants to drop to the shell for a moment without losing the session",
        "say": "Need the shell? Ctrl+Z suspends it, fg brings it back with the context intact"
      },
      "resume": {
        "tip": "Use --resume to continue a named session",
        "when": "closed the terminal and wants the session back, or asks how to continue yesterday’s work",
        "say": "Closed the terminal? claude --continue or --resume from the same directory brings it back"
      },
      "/rename": {
        "tip": "Use /rename for memorable sessions, --resume to continue",
        "when": "wants to name a session so they can find it again",
        "say": "Want to find this session later? /rename it, then /resume by name"
      }
    }
  },
  {
    "id": "shell-commands",
    "words": {
      "!": {
        "tip": "Use ! prefix for quick shell commands (!git status)",
        "when": "wants to run a quick shell command such as git status without leaving the prompt",
        "say": "A quick shell command? Start the line with ! and it runs right here"
      }
    }
  },
  {
    "id": "simplify",
    "words": {
      "/simplify": {
        "tip": "Use /simplify to invoke code-simplifier agent",
        "when": "says the code has become messy, over-engineered or hard to read",
        "say": "Code turned messy? /simplify runs the simplifier agent on it"
      }
    }
  },
  {
    "id": "skills",
    "words": {
      "skills": {
        "tip": "Create skills in ~/.claude/skills for reusable prompts",
        "when": "does something repeatedly and wants it as a reusable command",
        "say": "Doing this every day? A markdown file in .claude/commands/ becomes a slash command"
      }
    }
  },
  {
    "id": "statusline",
    "words": {
      "/statusline": {
        "tip": "Use /statusline to customize terminal status display",
        "when": "wants to see the model, branch, cost or context use at a glance",
        "say": "Want model, branch and context at a glance? /statusline puts them in the footer"
      }
    }
  },
  {
    "id": "teleport",
    "words": {
      "/teleport": {
        "tip": "Use /teleport to continue session on claude.ai web",
        "when": "wants to continue this session on another machine or from the phone",
        "say": "Carry on elsewhere? /teleport moves this session; /rc continues it from your phone"
      }
    }
  },
  {
    "id": "terminal-setup",
    "words": {
      "/terminal-setup": {
        "tip": "Run /terminal-setup for Shift+Enter linebreak config",
        "when": "complains that Enter sends the message when they wanted a new line",
        "say": "Enter sending too early? /terminal-setup once makes Shift+Enter a newline"
      }
    }
  },
  {
    "id": "usage-cost",
    "words": {
      "/usage": {
        "tip": "Use /usage to check token consumption and reset timers",
        "when": "asks how much they have used, hits a usage limit, or asks when the limit resets",
        "say": "Hit a limit? /usage shows the 5-hour and weekly bars and when they reset"
      },
      "/cost": {
        "tip": "Check costs with /usage command",
        "when": "asks what this is costing, why the bill is high, or says it is burning through their budget, credits or money",
        "say": "Wondering what this costs? /cost shows the totals; the whole history is re-sent every turn"
      },
      "tokens": {
        "tip": "Use /usage to check token consumption",
        "when": "asks about token use or why tokens are being burned",
        "say": "Burning tokens? Name the file with @ so it stops scanning, and /clear between tasks"
      },
      "limit": {
        "tip": "Approaching limit? Use /compact to summarize and free space",
        "when": "has hit a usage limit or asks about limits",
        "say": "Hit a limit? /usage shows when it resets; /model sonnet if it is an Opus-only limit"
      }
    }
  },
  {
    "id": "vscode",
    "words": {
      "vscode": {
        "tip": "VS Code integration shows diffs in gutter, supports inline edits",
        "when": "wants the tool inside the editor",
        "say": "Want it in the editor? The VS Code extension; Cmd+Esc toggles focus"
      }
    }
  },
  {
    "id": "wsl-performance",
    "words": {
      "slow": {
        "tip": "Run on native Linux/macOS - WSL has overhead",
        "when": "says the model is slow, takes ages, or thinks too long on a small or one-line change",
        "say": "Too slow for a small change? /effort low, or a cheaper model with /model"
      },
      "wsl": {
        "tip": "WSL has overhead - native Linux/macOS is faster",
        "when": "is on Windows and hits install, path or slowness problems",
        "say": "On Windows? Keep the repo in your Linux home, not under /mnt/c, and use the native installer"
      }
    }
  }
]
```
