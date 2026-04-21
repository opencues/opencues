---
name: claude-code-cues
domain: claude-code
version: 1
---

# cues.md

OpenCues configuration for Claude Code. Defines word tips and LLM prompt customizations.
For cue-controls see controls.md. For blank-fill behaviour see blanks.md.

## Tips

```json
[
  {
    "id": "extended-thinking",
    "words": {
      "ultrathink": {
        "tip": "Add ultrathink to prompt for max reasoning",
        "alts": ["Tab", "deep thinking", "think harder"],
        "speak": true
      },
      "Tab": {
        "tip": "Press Tab to toggle extended thinking mode",
        "alts": ["ultrathink", "deep thinking", "think harder"],
        "speak": true
      },
      "deep thinking": {
        "tip": "Extended thinking - Claude reasons longer before responding",
        "alts": ["ultrathink", "Tab", "think harder"]
      },
      "think harder": {
        "tip": "Request more reasoning by adding 'think harder' to prompt",
        "alts": ["ultrathink", "Tab", "deep thinking"]
      }
    }
  },
  {
    "id": "context-management",
    "words": {
      "/compact": {
        "tip": "Summarize history when 'context limit' warning appears",
        "alts": ["/clear", "/rewind"]
      },
      "/clear": {
        "tip": "Fresh start - clears context but keeps CLAUDE.md",
        "alts": ["/compact", "/rewind"]
      },
      "/rewind": {
        "tip": "Undo everything - rolls back context AND file changes",
        "alts": ["/compact", "/clear", "Esc x2"]
      },
      "Esc x2": {
        "tip": "Double-tap Escape for quick /rewind (rolls back context + files)",
        "alts": ["/rewind", "/compact", "/clear"]
      },
      "undo": {
        "tip": "Use /rewind (Esc x2) to undo - rolls back context AND file changes",
        "alts": ["/rewind", "revert", "rollback"]
      },
      "revert": {
        "tip": "Use /rewind to revert - rolls back context AND file changes",
        "alts": ["/rewind", "undo", "rollback"]
      },
      "rollback": {
        "tip": "Use /rewind to rollback - rolls back context AND file changes",
        "alts": ["/rewind", "undo", "revert"]
      },
      "context": {
        "tip": "Manage context: /compact (summarize), /clear (fresh), /rewind (undo all)",
        "alts": ["/compact", "/clear", "/rewind"]
      }
    }
  },
  {
    "id": "parallel-execution",
    "groups": [
      {
        "synonyms": ["agents", "sub-agents", "subagents", "parallel agents", "spawn"],
        "tip": "Spawn parallel workers via Task tool - faster for multi-file ops",
        "alts": ["swarm", "background"]
      },
      {
        "synonyms": ["swarm", "team"],
        "tip": "Multiple coordinated agents working on related tasks",
        "alts": ["agents", "background"]
      },
      {
        "synonyms": ["background", "Ctrl+B"],
        "tip": "Press Ctrl+B to send running agent to background",
        "alts": ["agents", "swarm"]
      }
    ]
  },
  {
    "id": "model-selection",
    "words": {
      "opus": {
        "tip": "Use Opus for complex architecture - best reasoning, higher cost",
        "alts": ["sonnet", "haiku", "/model"]
      },
      "sonnet": {
        "tip": "Use Sonnet for routine coding - good balance of speed/quality",
        "alts": ["opus", "haiku", "/model"]
      },
      "haiku": {
        "tip": "Use Haiku for simple tasks - 3x cheaper than Sonnet",
        "alts": ["opus", "sonnet", "/model"]
      },
      "/model": {
        "tip": "Use /model command to switch models mid-session",
        "alts": ["opus", "sonnet", "haiku"]
      }
    }
  },
  {
    "id": "plan-mode",
    "words": {
      "plan": {
        "tip": "Use plan mode (Shift+Tab x2) - research before making changes",
        "alts": ["Shift+Tab", "risky", "careful"]
      },
      "Shift+Tab": {
        "tip": "Double Shift+Tab enters plan mode for careful exploration",
        "alts": ["plan", "risky", "careful"]
      },
      "risky": {
        "tip": "For risky changes, use plan mode (Shift+Tab x2) first",
        "alts": ["plan", "Shift+Tab", "careful"]
      },
      "careful": {
        "tip": "Be careful - use plan mode to explore before changing",
        "alts": ["plan", "Shift+Tab", "risky"]
      }
    }
  },
  {
    "id": "project-config",
    "words": {
      "CLAUDE.md": {
        "tip": "Put repeated instructions in CLAUDE.md - Claude follows it strictly",
        "alts": ["/config", ".claude/rules/", "remember"]
      },
      "/config": {
        "tip": "Use /config with search to find settings quickly",
        "alts": ["CLAUDE.md", ".claude/rules/", "remember"]
      },
      ".claude/rules/": {
        "tip": "Use .claude/rules/ directory for organized instructions",
        "alts": ["CLAUDE.md", "/config", "remember"]
      },
      "remember": {
        "tip": "Put repeated instructions in CLAUDE.md - Claude follows it strictly",
        "alts": ["CLAUDE.md", "/config", ".claude/rules/"]
      }
    }
  },
  {
    "id": "editing",
    "words": {
      "Ctrl+G": {
        "tip": "Press Ctrl+G to edit prompts in external editor",
        "alts": ["Ctrl+R", "editor", "multiline"]
      },
      "Ctrl+R": {
        "tip": "Press Ctrl+R to search command history",
        "alts": ["Ctrl+G", "history", "previous"]
      },
      "editor": {
        "tip": "Press Ctrl+G to edit prompts in external editor",
        "alts": ["Ctrl+G", "Ctrl+R", "multiline"]
      },
      "multiline": {
        "tip": "Press Ctrl+G for multiline editing in external editor",
        "alts": ["Ctrl+G", "editor"]
      }
    }
  },
  {
    "id": "session-control",
    "words": {
      "Ctrl+Z": {
        "tip": "Press Ctrl+Z to suspend, fg to resume - don't restart",
        "alts": ["suspend", "resume", "pause"]
      },
      "suspend": {
        "tip": "Ctrl+Z suspends Claude, fg resumes - context preserved",
        "alts": ["Ctrl+Z", "resume", "pause"]
      },
      "resume": {
        "tip": "Use --resume to continue a named session",
        "alts": ["Ctrl+Z", "suspend", "/rename"]
      },
      "/rename": {
        "tip": "Use /rename for memorable sessions, --resume to continue",
        "alts": ["resume", "session"]
      },
      "pause": {
        "tip": "Ctrl+Z pauses, fg resumes - don't restart and lose context",
        "alts": ["Ctrl+Z", "suspend", "resume"]
      }
    }
  },
  {
    "id": "git-worktrees",
    "words": {
      "worktree": {
        "tip": "Use git worktrees (--worktree) for parallel Claude sessions",
        "alts": ["branches", "parallel sessions"]
      },
      "branches": {
        "tip": "Use worktrees for simultaneous work on multiple branches",
        "alts": ["worktree", "parallel sessions"]
      },
      "parallel sessions": {
        "tip": "Use git worktrees for parallel Claude sessions on different branches",
        "alts": ["worktree", "branches"]
      }
    }
  },
  {
    "id": "shell-commands",
    "words": {
      "!": {
        "tip": "Use ! prefix for quick shell commands (!git status)",
        "alts": ["shell", "bash", "terminal"]
      },
      "shell": {
        "tip": "Use ! prefix for quick shell commands (!git status)",
        "alts": ["!", "bash", "terminal"]
      },
      "bash": {
        "tip": "Use ! prefix for quick shell commands (!git status)",
        "alts": ["!", "shell", "terminal"]
      },
      "terminal": {
        "tip": "Use ! prefix for quick shell commands (!git status)",
        "alts": ["!", "shell", "bash"]
      }
    }
  },
  {
    "id": "usage-cost",
    "words": {
      "/usage": {
        "tip": "Use /usage to check token consumption and reset timers",
        "alts": ["/cost", "tokens", "limit"]
      },
      "/cost": {
        "tip": "Check costs with /usage command",
        "alts": ["/usage", "tokens", "limit"]
      },
      "tokens": {
        "tip": "Use /usage to check token consumption",
        "alts": ["/usage", "/cost", "limit"]
      },
      "limit": {
        "tip": "Approaching limit? Use /compact to summarize and free space",
        "alts": ["/usage", "/compact", "tokens"]
      }
    }
  },
  {
    "id": "permissions",
    "words": {
      "permission": {
        "tip": "Use allowedTools config instead of --dangerously-skip-permissions",
        "alts": ["allow", "dangerous", "skip"]
      },
      "allow": {
        "tip": "Configure allowedTools in settings for safe auto-approval",
        "alts": ["permission", "dangerous", "skip"]
      },
      "dangerous": {
        "tip": "Prefer allowedTools config over --dangerously-skip-permissions",
        "alts": ["permission", "allow", "skip"]
      },
      "skip": {
        "tip": "Use allowedTools config for persistent permissions",
        "alts": ["permission", "allow", "dangerous"]
      }
    }
  },
  {
    "id": "mcp-extensions",
    "words": {
      "mcp": {
        "tip": "Configure MCP servers in ~/.claude.json for extra tools",
        "alts": ["plugin", "extension", "server"]
      },
      "plugin": {
        "tip": "Use MCP servers for additional tools and integrations",
        "alts": ["mcp", "extension", "server"]
      },
      "extension": {
        "tip": "MCP servers extend Claude with custom tools",
        "alts": ["mcp", "plugin", "server"]
      },
      "server": {
        "tip": "MCP servers provide external tool integrations",
        "alts": ["mcp", "plugin", "extension"]
      }
    }
  },
  {
    "id": "skills",
    "words": {
      "skill": {
        "tip": "Create skills in ~/.claude/skills for reusable prompts",
        "alts": ["skills", "custom command", "reusable"]
      },
      "skills": {
        "tip": "Create skills in ~/.claude/skills for reusable prompts",
        "alts": ["skill", "custom command", "reusable"]
      },
      "custom command": {
        "tip": "Skills are custom commands - create in ~/.claude/skills",
        "alts": ["skill", "skills", "reusable"]
      }
    }
  },
  {
    "id": "hooks",
    "words": {
      "hook": {
        "tip": "Use hooks (PreToolUse, PostToolUse) for automation",
        "alts": ["hooks", "automation", "lifecycle"]
      },
      "hooks": {
        "tip": "Use hooks (PreToolUse, PostToolUse) for automation",
        "alts": ["hook", "automation", "lifecycle"]
      },
      "automation": {
        "tip": "Hooks automate actions before/after tool use",
        "alts": ["hook", "hooks", "lifecycle"]
      },
      "lifecycle": {
        "tip": "Hook into Claude's lifecycle with PreToolUse/PostToolUse",
        "alts": ["hook", "hooks", "automation"]
      }
    }
  },
  {
    "id": "ci-cd",
    "words": {
      "--print": {
        "tip": "Use --print flag for CI/CD non-interactive execution",
        "alts": ["ci", "cd", "pipeline", "scripting"]
      },
      "ci": {
        "tip": "Use --print flag for CI/CD non-interactive execution",
        "alts": ["--print", "cd", "pipeline"]
      },
      "cd": {
        "tip": "Use --print flag for CI/CD non-interactive execution",
        "alts": ["--print", "ci", "pipeline"]
      },
      "pipeline": {
        "tip": "Use --print flag for pipeline/CI non-interactive execution",
        "alts": ["--print", "ci", "cd"]
      }
    }
  },
  {
    "id": "multi-project",
    "words": {
      "--add-dir": {
        "tip": "Use --add-dir to access multiple projects",
        "alts": ["monorepo", "multiple", "directory"]
      },
      "monorepo": {
        "tip": "Use --add-dir for monorepo with multiple project dirs",
        "alts": ["--add-dir", "multiple", "directory"]
      }
    }
  },
  {
    "id": "statusline",
    "words": {
      "/statusline": {
        "tip": "Use /statusline to customize terminal status display",
        "alts": ["status", "terminal", "PS1"]
      },
      "status": {
        "tip": "Customize status bar with /statusline command",
        "alts": ["/statusline", "terminal"]
      }
    }
  },
  {
    "id": "terminal-setup",
    "words": {
      "/terminal-setup": {
        "tip": "Run /terminal-setup for Shift+Enter linebreak config",
        "alts": ["Shift+Enter", "linebreak", "newline"]
      },
      "Shift+Enter": {
        "tip": "Run /terminal-setup to configure Shift+Enter for newlines",
        "alts": ["/terminal-setup", "linebreak", "newline"]
      },
      "linebreak": {
        "tip": "Run /terminal-setup for Shift+Enter linebreak config",
        "alts": ["/terminal-setup", "Shift+Enter", "newline"]
      }
    }
  },
  {
    "id": "vscode",
    "words": {
      "diff": {
        "tip": "Click colored diff bubbles in VS Code gutter to view changes",
        "alts": ["gutter", "vscode", "changes"]
      },
      "gutter": {
        "tip": "VS Code gutter shows diff bubbles - click to view changes",
        "alts": ["diff", "vscode", "changes"]
      },
      "vscode": {
        "tip": "VS Code integration shows diffs in gutter, supports inline edits",
        "alts": ["diff", "gutter", "ide"]
      }
    }
  },
  {
    "id": "updates",
    "words": {
      "stable": {
        "tip": "Use /config to set stable update channel for fewer bugs",
        "alts": ["update", "channel", "latest"]
      },
      "update": {
        "tip": "Set stable channel via /config for production stability",
        "alts": ["stable", "channel", "latest"]
      },
      "channel": {
        "tip": "Choose stable or latest update channel in /config",
        "alts": ["stable", "update", "latest"]
      }
    }
  },
  {
    "id": "errors",
    "words": {
      "503": {
        "tip": "503/overloaded errors resolve in 2-5 min - just wait",
        "alts": ["overloaded", "error", "wait"]
      },
      "overloaded": {
        "tip": "Overloaded/503 errors resolve in 2-5 min - just wait",
        "alts": ["503", "error", "wait"]
      },
      "string replace": {
        "tip": "String replace errors usually auto-retry successfully",
        "alts": ["edit fail", "not found"]
      }
    }
  },
  {
    "id": "lsp",
    "words": {
      "lsp": {
        "tip": "Set ENABLE_LSP_TOOL=1 for IDE-level code intelligence",
        "alts": ["language server", "intellisense", "ide"]
      },
      "language server": {
        "tip": "Enable LSP with ENABLE_LSP_TOOL=1 env var",
        "alts": ["lsp", "intellisense", "ide"]
      },
      "intellisense": {
        "tip": "Enable LSP tool for intellisense-like code understanding",
        "alts": ["lsp", "language server", "ide"]
      }
    }
  },
  {
    "id": "debugging",
    "words": {
      "bug": {
        "tip": "Use /rewind (Esc x2) to roll back context AND code",
        "alts": ["debug", "fix", "broken", "/rewind"]
      },
      "debug": {
        "tip": "Check git changes, use /rewind if stuck",
        "alts": ["bug", "fix", "broken", "/rewind"]
      },
      "fix": {
        "tip": "Stuck on a fix? /rewind rolls back code AND context",
        "alts": ["bug", "debug", "broken", "/rewind"]
      },
      "broken": {
        "tip": "Broken code? /rewind (Esc x2) to roll back everything",
        "alts": ["bug", "debug", "fix", "/rewind"]
      },
      "stack trace": {
        "tip": "Provide complete error messages and full stack traces",
        "alts": ["error message", "full error"]
      }
    }
  },
  {
    "id": "security",
    "words": {
      "security": {
        "tip": "Request security review - Claude checks for vulnerabilities",
        "alts": ["audit", "vulnerability", "review"]
      },
      "audit": {
        "tip": "Request security audit - Claude scans for vulnerabilities",
        "alts": ["security", "vulnerability", "review"]
      },
      "vulnerability": {
        "tip": "Ask Claude for security review to find vulnerabilities",
        "alts": ["security", "audit", "review"]
      }
    }
  },
  {
    "id": "teleport",
    "words": {
      "/teleport": {
        "tip": "Use /teleport to continue session on claude.ai web",
        "alts": ["web", "claude.ai", "move session"]
      },
      "web": {
        "tip": "Use /teleport to move session to claude.ai web",
        "alts": ["/teleport", "claude.ai"]
      },
      "claude.ai": {
        "tip": "Use /teleport to continue this session on claude.ai",
        "alts": ["/teleport", "web"]
      }
    }
  },
  {
    "id": "large-files",
    "words": {
      "large": {
        "tip": "Break large files into smaller ones - reduces context waste",
        "alts": ["huge", "split", "massive"]
      },
      "huge": {
        "tip": "Split huge files into smaller modules to save context",
        "alts": ["large", "split", "massive"]
      },
      "split": {
        "tip": "Split large files to reduce context usage",
        "alts": ["large", "huge", "massive"]
      },
      "massive": {
        "tip": "Massive files waste context - break into smaller modules",
        "alts": ["large", "huge", "split"]
      }
    }
  },
  {
    "id": "wsl-performance",
    "words": {
      "slow": {
        "tip": "Run on native Linux/macOS - WSL has overhead",
        "alts": ["wsl", "performance", "lag"]
      },
      "wsl": {
        "tip": "WSL has overhead - native Linux/macOS is faster",
        "alts": ["slow", "performance", "lag"]
      },
      "performance": {
        "tip": "For best performance, run on native Linux/macOS not WSL",
        "alts": ["slow", "wsl", "lag"]
      },
      "lag": {
        "tip": "Experiencing lag? WSL is slower than native Linux/macOS",
        "alts": ["slow", "wsl", "performance"]
      }
    }
  },
  {
    "id": "search",
    "words": {
      "search": {
        "tip": "Ask for parallel sub-agents when searching - faster and thorough",
        "alts": ["find", "grep", "codebase"]
      },
      "find": {
        "tip": "Use parallel sub-agents for faster file/code search",
        "alts": ["search", "grep", "codebase"]
      },
      "grep": {
        "tip": "Install ripgrep - auto-respects .gitignore, faster than grep",
        "alts": ["search", "find", "ripgrep"]
      },
      "ripgrep": {
        "tip": "Install ripgrep (rg) - respects .gitignore, faster than grep",
        "alts": ["grep", "search", "find"]
      },
      "codebase": {
        "tip": "For codebase search, ask for parallel sub-agents",
        "alts": ["search", "find", "grep"]
      }
    }
  },
  {
    "id": "vibe-coding",
    "words": {
      "vibe": {
        "tip": "Vibe coding: focus on outcome, judge by result feel",
        "alts": ["outcome", "result", "feels right"]
      },
      "outcome": {
        "tip": "Focus on outcome - let Claude figure out the implementation",
        "alts": ["vibe", "result", "feels right"]
      }
    }
  },
  {
    "id": "privacy",
    "words": {
      "privacy": {
        "tip": "Consider data sensitivity - code is sent to Anthropic servers",
        "alts": ["sensitive", "confidential", "proprietary"]
      },
      "sensitive": {
        "tip": "Sensitive code is sent to Anthropic servers - be aware",
        "alts": ["privacy", "confidential", "proprietary"]
      },
      "confidential": {
        "tip": "Confidential code goes to Anthropic - consider implications",
        "alts": ["privacy", "sensitive", "proprietary"]
      }
    }
  },
  {
    "id": "language",
    "words": {
      "language": {
        "tip": "Set language in settings for consistent non-English responses",
        "alts": ["english", "translation"]
      },
      "english": {
        "tip": "Set preferred language in settings if not English",
        "alts": ["language", "translation"]
      }
    }
  },
  {
    "id": "expert-mode",
    "words": {
      "expert": {
        "tip": "Request role-based analysis from multiple perspectives",
        "alts": ["senior", "perspective", "role"]
      },
      "senior": {
        "tip": "Ask for senior engineer perspective for thorough analysis",
        "alts": ["expert", "perspective", "role"]
      },
      "perspective": {
        "tip": "Request analysis from multiple expert perspectives",
        "alts": ["expert", "senior", "role"]
      }
    }
  },
  {
    "id": "simplify",
    "words": {
      "/simplify": {
        "tip": "Use /simplify to invoke code-simplifier agent",
        "alts": ["clean", "readable", "clarity"]
      },
      "simplify": {
        "tip": "Use /simplify command to clean up complex code",
        "alts": ["/simplify", "clean", "readable"]
      },
      "clean": {
        "tip": "Use /simplify to clean up and simplify code",
        "alts": ["/simplify", "simplify", "readable"]
      }
    }
  },
  {
    "id": "fearless",
    "words": {
      "experiment": {
        "tip": "Experiment fearlessly - use /rewind to undo failed attempts",
        "alts": ["try", "test", "fearless"]
      },
      "fearless": {
        "tip": "Be fearless - /rewind undoes experiments that fail",
        "alts": ["experiment", "try", "test"]
      }
    }
  },
  {
    "id": "git",
    "words": {
      "git": {
        "tip": "Check if recent git changes correlate with new errors",
        "alts": ["recent", "change", "correlate"]
      },
      "commit": {
        "tip": "Use /config to manage commit attribution settings",
        "alts": ["attribution", "co-authored"]
      },
      "attribution": {
        "tip": "Configure commit attribution with /config command",
        "alts": ["commit", "co-authored"]
      }
    }
  },
  {
    "id": "help",
    "words": {
      "/help": {
        "tip": "Use /help to see all available commands",
        "alts": ["/doctor", "/status", "help"]
      },
      "/doctor": {
        "tip": "Use /doctor to diagnose Claude Code setup issues",
        "alts": ["/help", "/status"]
      },
      "/status": {
        "tip": "Use /status to see current session state",
        "alts": ["/help", "/doctor"]
      },
      "help": {
        "tip": "Type /help to see all commands, report issues on GitHub",
        "alts": ["/help", "/doctor", "/status"]
      }
    }
  }
]
```

## Prompt

### grammar

```yaml
priority: 50
```

Provide 3 alternatives per word: synonym, opposite, creative. Skip function words.

Prefer concise single-word synonyms over multi-word phrases.
For technical terms, suggest alternatives within the same domain
rather than generic synonyms. Avoid archaic or overly formal language.

Format: INDEX:alt1,alt2,alt3|INDEX:alt1,alt2

Examples:

Adjectives:
- 1=beautiful → 1:gorgeous,ugly,stunning
- 1=happy → 1:joyful,sad,cheerful
- 1=big → 1:large,small,enormous
- 1=fast → 1:quick,slow,rapid
- 1=old → 1:elderly,young,ancient
- 1=tall → 1:high,short,towering
- 1=loud → 1:quiet,soft,deafening
- 1=bright → 1:dim,brilliant,dazzling
- 1=hot → 1:cold,warm,scalding
- 1=cold → 1:hot,freezing,chilly
- 1=clean → 1:dirty,messy,spotless
- 1=easy → 1:hard,difficult,simple

Adverbs:
- 1=quickly → 1:slowly,rapidly,swiftly
- 1=softly → 1:loudly,quietly,gently
- 1=slowly → 1:quickly,gradually,leisurely
- 1=happily → 1:sadly,joyfully,cheerfully
- 1=loudly → 1:quietly,softly,noisily
- 1=silently → 1:loudly,quietly,stealthily
- 1=carefully → 1:carelessly,gently,cautiously
- 1=patiently → 1:impatiently,calmly,eagerly

Verbs:
- 1=ran → 1:walked,sprinted,jogged
- 1=said → 1:whispered,shouted,stated
- 1=looked → 1:glanced,stared,gazed
- 1=walked → 1:ran,strolled,marched
- 1=whispered → 1:shouted,murmured,screamed
- 1=demolished → 1:destroyed,built,obliterated

Nouns:
- 1=dog → 1:cat,wolf,puppy
- 1=boy → 1:girl,child,lad
- 1=man → 1:woman,person,gentleman

Proper Nouns (give similar entities, not synonyms):
- Companies: 1=Google → 1:Microsoft,Apple,Amazon
- Companies: 1=Tesla → 1:Ford,BMW,Toyota
- Companies: 1=Amazon → 1:Google,Microsoft,Apple
- People: 1=Einstein → 1:Newton,Darwin,Hawking
- Countries: 1=France → 1:Germany,Italy,Spain
- Cities: 1=Paris → 1:London,Tokyo,Berlin
- Universities: 1=Harvard → 1:Yale,MIT,Stanford
- Universities: 1=Oxford → 1:Cambridge,Harvard,Princeton
- Programming: 1=Python → 1:Java,JavaScript,C++
- Programming: 1=React → 1:Vue,Angular,Svelte
- Sports teams: 1=Lakers → 1:Celtics,Bulls,Warriors
- Sports teams: 1=Yankees → 1:Red Sox,Dodgers,Cubs
- Car brands: 1=BMW → 1:Mercedes,Audi,Tesla
- Car brands: 1=Toyota → 1:Honda,Ford,Chevrolet
- Currencies: 1=Dollar → 1:Euro,Pound,Yen
- Currencies: 1=Bitcoin → 1:Ethereum,Dogecoin,Litecoin
- Planets: 1=Mars → 1:Venus,Jupiter,Saturn
- Planets: 1=Earth → 1:Mars,Venus,Mercury
- Social media: 1=Twitter → 1:Facebook,Instagram,TikTok
- Social media: 1=YouTube → 1:Twitch,Vimeo,TikTok
- Streaming: 1=Netflix → 1:Hulu,Disney+,HBO
- Streaming: 1=Spotify → 1:Apple Music,Pandora,Tidal
- OS: 1=Windows → 1:macOS,Linux,Android
- OS: 1=iOS → 1:Android,Windows,Linux
- Sports: 1=Football → 1:Basketball,Tennis,Soccer
- Sports: 1=Golf → 1:Tennis,Baseball,Hockey
- Languages: 1=English → 1:Spanish,French,Chinese
- Languages: 1=Japanese → 1:Chinese,Korean,Vietnamese
- Months: 1=January → 1:February,March,December
- Months: 1=Summer → 1:Winter,Spring,Fall
- Days: 1=Monday → 1:Tuesday,Friday,Sunday
- Religions: 1=Christianity → 1:Islam,Buddhism,Judaism
- Historical: 1=WW2 → 1:WW1,Vietnam War,Civil War
- Musicians: 1=Beatles → 1:Rolling Stones,Queen,Led Zeppelin
- Musicians: 1=Mozart → 1:Beethoven,Bach,Chopin
- Job titles: 1=CEO → 1:CFO,CTO,President
- Job titles: 1=President → 1:CEO,Chairman,Director
- Job titles: 1=Manager → 1:Director,Supervisor,Lead
- Job titles: 1=Engineer → 1:Developer,Architect,Designer
- Job titles: 1=Doctor → 1:Nurse,Surgeon,Physician
- Job titles: 1=Teacher → 1:Professor,Instructor,Tutor
- Job titles: 1=Lawyer → 1:Attorney,Judge,Paralegal
- Job titles: 1=Chef → 1:Cook,Baker,Sous-chef
- Job titles: 1=Actor → 1:Actress,Director,Producer
- Job titles: 1=Author → 1:Writer,Novelist,Poet

Emotional:
- 1=sad → 1:happy,melancholy,depressed
- 1=angry → 1:calm,furious,enraged
- 1=excited → 1:bored,thrilled,eager
- 1=worried → 1:calm,anxious,concerned

Output ONLY index:alternatives format.

<!-- legal, medical, financial moved to cues/ folders -->