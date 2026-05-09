---
last_updated: 2026-02-18
---

# Prompting Guide — Claude Code

Best practices for prompting Claude Code (the CLI tool) based on ClaudeLog.com FAQs.

## Quick Reference

### All Slash Commands

**Session Control**
| Command | One-Liner |
|---------|-----------|
| `/help` | Show all commands - your cheat sheet when stuck |
| `/clear` | Fresh start, keeps CLAUDE.md - when context is polluted |
| `/compact [hint]` | Summarize history - when "context limit" warning appears |
| `/rewind` | Undo everything - when Claude broke something |
| `/resume [id]` | Continue old session - pick up where you left off |
| `/continue` | Resume most recent - quick "where was I?" |
| `/rename [name]` | Name this session - find it later easily |

**Mode Switching**
| Command | One-Liner |
|---------|-----------|
| `/plan` | Read-only research - explore before you commit |
| `/model [name]` | Switch models - haiku=fast, sonnet=balanced, opus=max |
| `/vim` | Toggle vim mode - for vim keybinding lovers |
| `/sandbox` | Sandboxed execution - safer automation mode |

**Workspace**
| Command | One-Liner |
|---------|-----------|
| `/init` | Initialize project - set up CLAUDE.md and config |
| `/add-dir [path]` | Add another folder - work across multiple projects |
| `/project` | Repository operations - project-level commands |
| `/tasks` | Background jobs - check on running commands |
| `/agents` | Manage sub-agents - see spawned workers |

**Configuration**
| Command | One-Liner |
|---------|-----------|
| `/config` | All settings - search and modify preferences |
| `/permissions` | Tool access - what Claude can do without asking |
| `/terminal-setup` | Fix shortcuts - when keys don't work right |
| `/statusline` | Customize bar - what shows at the bottom |
| `/keybindings` | Custom shortcuts - map keys to commands |
| `/memory` | Memory management - what Claude remembers |

**Extensions**
| Command | One-Liner |
|---------|-----------|
| `/mcp` | External tools - connect databases, APIs, services |
| `/plugin` | Browse add-ons - extend Claude's capabilities |

**Diagnostics**
| Command | One-Liner |
|---------|-----------|
| `/doctor` | Health check - diagnose installation issues |
| `/bug` | Report issue - file a bug with Anthropic |
| `/status` | System status - check if services are up |
| `/context` | Context usage - visualize what's using tokens |

**Analytics & Mobility**
| Command | One-Liner |
|---------|-----------|
| `/usage` | Token stats - how much you've used, when it resets |
| `/cost` | Token costs - see pricing breakdown |
| `/stats` | Usage history - your patterns and streaks |
| `/teleport` | Move session - continue on claude.ai web |
| `/tp` | Short for teleport - same as above |

**Account**
| Command | One-Liner |
|---------|-----------|
| `/login` | Sign in - authenticate your account |
| `/logout` | Sign out - end current session |

**Custom Commands** (from `.claude/commands/`)
| Command | One-Liner |
|---------|-----------|
| `/review` | Code review - analyze diff for issues (custom) |
| `/commit` | Smart commit - generate conventional commit message (custom) |
| `/pr` | Create PR - generate title/description and open PR (custom) |

### Key Shortcuts

| Shortcut | Action |
|----------|--------|
| `Shift+Tab` x2 | Toggle Plan Mode |
| `Shift+Tab` x1 | Toggle Auto-approve |
| `Esc` x2 | Rewind to previous state |
| `Ctrl+B` | Run command in background |

---

## Prompting Principles

### 1. Be Specific About Requirements
Bad: "Fix the bug"
Good: "Fix the null pointer exception in `auth.ts:42` when user token is expired"

### 2. Provide Project Context
- Mention relevant constraints (e.g., "we use TypeScript strict mode")
- Reference existing patterns (e.g., "follow the pattern in `api/users.ts`")
- Specify dependencies (e.g., "we're using React 18 with hooks")

### 3. Set Clear Scope
- State what's in bounds: "Only modify the login flow"
- State what's out of bounds: "Don't change the database schema"

### 4. Include Examples
Reference existing code:
- "Follow the error handling pattern from `handleApiError` in utils.ts"
- "Use the same component structure as `UserCard.tsx`"

### 5. Use Numbered Steps for Complex Tasks
```
1. First, read the current implementation in auth/
2. Identify where tokens are validated
3. Add expiration checking before the API call
4. Update the tests in auth.test.ts
```

---

## CLAUDE.md Configuration

Create a `CLAUDE.md` file in your project root for persistent instructions.

### Structure
```markdown
# Project: MyApp

## Tech Stack
- React 18 + TypeScript
- Node.js backend with Express
- PostgreSQL database

## Coding Standards
- Use functional components with hooks
- All functions must have TypeScript types
- Error messages should be user-friendly

## Don't
- Never commit API keys
- Don't modify migration files directly
- Avoid inline styles

## Testing
- Run `npm test` before committing
- Coverage must stay above 80%
```

### Tips
- **Iterate on failures**: When Claude makes a mistake, add a rule to prevent it
- **Be explicit**: "Always use async/await" not "prefer async"
- **Group by topic**: Separate coding standards, testing, deployment

---

## Model Selection

| Model | Best For | Cost |
|-------|----------|------|
| **Sonnet 4.6** | Most coding tasks, "30+ hours sustained focus" | Default |
| **Opus 4.1** | Complex reasoning, architecture decisions | Higher |
| **Haiku 4.5** | Simple tasks, quick answers | Lower |

### When to Switch
- **Stay on Sonnet**: Regular development, debugging, refactoring
- **Switch to Opus**: Complex multi-file refactors, architecture planning
- **Switch to Haiku**: Simple questions, well-defined small tasks

### How to Switch
```
/model haiku    # Fast, cheap
/model sonnet   # Default, balanced
/model opus     # Maximum capability
```

---

## Key Features

### Plan Mode
Activate: `Shift+Tab` twice or `/plan`

- Research code without making changes
- Claude explains what it would do
- Review the plan before approving execution
- **Use for**: Unfamiliar codebases, risky operations

### UltraThink
Add "ultrathink" to your prompt for maximum reasoning budget (31,999 tokens).

Good for:
- Complex debugging
- Architecture decisions
- Multi-step problem solving

Example: "ultrathink: Design a caching strategy for our API"

### Sub-agents / Swarms / Parallel Agents

> **These are the same thing:** sub-agents, swarms, multiple agents, parallel agents, Task tool agents - all refer to Claude spawning independent workers.

Claude can spawn parallel workers via the Task tool.

- Each agent gets independent context
- Results merge into main conversation
- Significantly faster than sequential processing

**Trigger phrases that activate this:**
- "Do this in parallel"
- "Spawn sub-agents to..."
- "Use multiple agents"
- "Search in parallel"
- "Run these tasks concurrently"

Example: "Search for all usages of deprecated API across the codebase"
Example: "In parallel, check all test files for deprecated assertions"

### Background Commands
Press `Ctrl+B` to run bash commands in background.

- Continue working while processes execute
- Useful for: dev servers, builds, tests
- Check status with `/tasks`

### Compact
Use `/compact` when running low on context.

- Summarizes conversation history
- Preserves important decisions
- Auto-compact triggers automatically near limits

### Rewind
Double-press `Esc` or use `/rewind` to:
- Roll back conversation context
- Restore code to previous state
- Undo mistakes fearlessly

---

## Performance Tips

1. **Break large tasks into smaller ones**
   - Instead of "refactor everything", do one module at a time

2. **Organize code into smaller files**
   - Reduces context window usage
   - Claude can focus on relevant code

3. **Use appropriate model complexity**
   - Don't use Opus for simple fixes
   - Don't use Haiku for complex refactors

4. **System requirements**
   - 16GB RAM recommended
   - Native Linux/macOS faster than WSL

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **503 Errors** | Server-side, wait and retry |
| **Context limit reached** | Use `/compact` to summarize |
| **Rate limit exceeded** | Wait 5 hours for reset |
| **File edit errors** | Claude retries automatically |
| **Slow performance** | Check Anthropic Status Page |

### Recovery Strategies
- **Unresponsive session**: Restart Claude Code
- **API errors**: Check internet, verify API key
- **Subscription issues**: Check account at console.anthropic.com

---

## Trigger Phrases & One-Line Wisdom

Quick phrases that unlock specific behaviors or remind you of best practices.

### Magic Words

| Trigger | Effect |
|---------|--------|
| `ultrathink` | Maximum reasoning budget (31,999 tokens) |
| `plan mode` | Research without making changes |
| `in parallel` | Spawn multiple sub-agents simultaneously |
| `sub-agents` | Same as above - spawn parallel workers |
| `swarm` | Same as above - multiple agents working together |
| `concurrently` | Same as above - parallel execution |

> **Note:** "sub-agents", "swarms", "multiple agents", "parallel", "concurrently" all trigger the same behavior - Claude spawns independent Task agents that work simultaneously and merge results back.

### Project Understanding Prompts

| You Say | Claude Does |
|---------|-------------|
| "What kind of project is this?" | Analyzes structure, identifies app type |
| "Explain what this project does" | Summarizes purpose from files |
| "Show me the main entry point" | Finds primary startup file |
| "How do I run this project?" | Finds and explains startup commands |
| "What dependencies does this have?" | Lists all project dependencies |

### Code Operation Prompts

| You Say | Claude Does |
|---------|-------------|
| "Find all React components" | Locates specific patterns |
| "Explain how authentication works" | Breaks down functionality |
| "Search for usages of [function]" | Finds all references |
| "What files import [module]?" | Traces dependencies |

### Development Task Prompts

| You Say | Claude Does |
|---------|-------------|
| "Add [feature] to the app" | Implements new functionality |
| "Fix the [bug] in [file]" | Diagnoses and repairs |
| "Refactor [code] to use [pattern]" | Modernizes code |
| "Write tests for [component]" | Generates test cases |

### Task-Based Advice

When you're about to do something significant, consider these tips:

**"Build a website" / "Create an app" / "Start a new project"**
> Start with **Plan Mode** (`/plan` or `Shift+Tab` x2). Let Claude research your codebase, understand patterns, and propose an architecture before writing code. You'll catch issues early and get better structure.

**"Refactor this" / "Rewrite the whole thing"**
> Use **Plan Mode** first to map out what changes where. Then consider breaking into smaller steps. Large refactors in one shot often miss edge cases.

**"Fix this bug" / "Debug this"**
> Add **"ultrathink"** for complex bugs. Claude will use maximum reasoning to trace through the logic. Also consider asking Claude to "explain what this code does" before fixing.

**"Search the codebase" / "Find all usages"**
> Ask for **sub-agents in parallel** for faster, more thorough results. "Use sub-agents to find all files that import X"

**"Make this faster" / "Optimize performance"**
> Start with Plan Mode to analyze before changing. Ask Claude to "explain the current performance characteristics" first.

**"Add tests" / "Write tests for this"**
> Reference existing test patterns: "Follow the testing style in `tests/example.test.ts`"

**"Deploy this" / "Set up CI/CD"**
> Put deployment steps in CLAUDE.md so Claude remembers them. Create a `/deploy` skill for repeatability.

**"I'm stuck" / "This isn't working"**
> Try `/rewind` to go back to a working state. Then use Plan Mode to approach differently.

---

### Concept Notes

**Reverting / Undoing Changes**
> ⚠️ **Don't ask Claude to "revert" or "undo" changes** - this is unreliable and risky. Claude may miss files, partially revert, or make things worse.
>
> **Instead use `/rewind`** - it properly rolls back both conversation context AND file changes to a previous checkpoint. Much safer.

**Remembering / Persistent Instructions**
> When you want Claude to "remember" something:
> - **Project-wide**: Add it to `CLAUDE.md` in your project root
> - **Reusable command**: Create a skill in `.claude/commands/your-command.md`
> - **Personal preference**: Add to `~/.claude/CLAUDE.md`
>
> Don't rely on conversation memory - it gets compacted away.

**Searching / Finding Code**
> For broad searches across a codebase, ask Claude to use **sub-agents in parallel**.
>
> "Search all files for deprecated API usage" → single slow search
> "Use sub-agents to search for deprecated API usage in parallel" → faster, more thorough

---

### Quick reference — concepts and synonyms

*Synonym Groups (user says X, means Y)*
- undo/revert/rollback/go back → `/rewind`
- approve/accept/allow/auto-yes → permissions, `Shift+Tab`
- explain/what does/how does → same intent
- fix/debug/repair/solve → same intent
- background/async/non-blocking → `Ctrl+B`
- cost/usage/tokens/limits/quota → `/usage`, `/cost`, `/stats`
- stop/cancel/abort/kill → `Esc`, `Ctrl+C`
- settings/config/preferences → `/config`, CLAUDE.md

*Thinking & Reasoning*
- extended thinking / deep thinking → Tab toggle
- ultrathink / maximum reasoning → "ultrathink" keyword
- plan mode / research mode → `Shift+Tab` x2, `/plan`

*Context & Memory*
- context limit / running out of space → `/compact`
- auto-compact / micro-compact → automatic features
- context fork → isolated sub-agent context

*Automation & CI/CD*
- headless mode / non-interactive → `claude -p "prompt"`
- print mode / scripting → `--print` flag
- max turns / limit iterations → `--max-turns`
- JSON output → `--output-format json`

*Hooks & Lifecycle*
- pre-tool hooks / before actions → PreToolUse hooks
- post-tool hooks / after actions → PostToolUse hooks
- setup hooks / initialization → Setup hooks
- once hooks / run once → Once hooks

*Skills & Extensions*
- custom commands / slash commands → `.claude/commands/`
- skills / reusable prompts → `.claude/skills/`
- hot reload / live update → skill hot-reload
- MCP servers / external tools → `/mcp`, `.mcp.json`
- plugins / add-ons → `/plugin`

*Git & Version Control*
- git integration / commits → gh CLI, git commands
- worktrees / multiple branches → git worktree support
- PR creation / pull requests → custom `/pr` command

*Safety & Permissions*
- dangerous mode / skip permissions → `--dangerously-skip-permissions`
- allowed tools / whitelist → allowedTools config
- wildcard permissions → `Bash(npm *)` patterns

*Session & History*
- resume session / continue → `/resume`, `--continue`
- named sessions → `/rename`
- teleport / move session → `/teleport`, `/tp`
- history search → `Ctrl+R`

*Editor & Terminal*
- external editor → `Ctrl+G`
- VS Code integration → extension
- terminal setup / keybindings → `/terminal-setup`

*Pricing & Limits*
- subscription tiers → Pro, Max 5x, Max 20x
- rate limits / resets → 5-hour reset cycle
- API vs subscription → different billing models

---

### One-Line Wisdom

**Context Management**
- "Running low on context" → Use `/compact` to summarize
- "Lost track of changes" → Use `/rewind` to restore
- "Need fresh start" → Use `/clear` but keep CLAUDE.md

**Safety**
- "Unfamiliar codebase" → Start with Plan Mode (`Shift+Tab` x2)
- "Risky operation" → Review plan before approving
- "Big refactor" → Use git checkpoint first

**Efficiency**
- "Simple task" → Switch to Haiku (`/model haiku`)
- "Complex reasoning" → Add "ultrathink" to prompt
- "Multiple searches" → Ask for parallel sub-agents
- "Long-running command" → Press `Ctrl+B` for background

**Configuration**
- "Repeated instructions" → Put them in CLAUDE.md
- "Team settings" → Use project `.mcp.json`
- "Personal preferences" → Use `~/.claude/settings.json`

**Prompting**
- "Vague request = vague result" → Be specific about requirements
- "Claude keeps making same mistake" → Add rule to CLAUDE.md
- "Complex task" → Break into numbered steps
- "Want consistency" → Reference existing code patterns

### CLI One-Liners

```bash
# Quick question without full session
claude -p "How many files are in this project?"

# Pipe input for analysis
git diff | claude -p "Explain these changes"

# Resume previous session
claude --resume

# Add another directory mid-session
/add-dir /path/to/other/project
```

---

## Sources

- [ClaudeLog.com FAQ](https://claudelog.com/faq) - Comprehensive Claude Code documentation
- [ClaudeLog Tutorial](https://claudelog.com/claude-code-tutorial) - Getting started guide
- [ClaudeLog Configuration](https://claudelog.com/configuration) - Settings reference
- [Anthropic Console](https://console.anthropic.com) - API usage and billing
