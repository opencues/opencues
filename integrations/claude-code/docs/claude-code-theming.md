---
last_updated: 2026-01-17
---

# Claude Code Text Color Rendering System

This document explains how Claude Code renders colored text internally, based on analysis of the tweakcc patching system.

## Architecture Overview

Claude Code uses two complementary technologies for terminal text rendering:

1. **Ink** - React-based terminal UI framework
2. **Chalk** - Terminal string styling library

## Ink Components

Ink provides React components for building terminal UIs. Key components:

### Text Component

```tsx
<Text
  color="text"              // Named theme color or hex
  backgroundColor="..."     // Background color
  dimColor={true}          // Dimmed/muted appearance
  bold={true}              // Bold text
  italic={true}            // Italic text
  underline={true}         // Underlined text
  strikethrough={true}     // Strikethrough text
  inverse={true}           // Inverted colors
/>
```

### Box Component

```tsx
<Box
  borderStyle="round"       // Border style: round, single, double, etc.
  borderColor="rgb(r,g,b)"  // Border color
  paddingX={1}              // Horizontal padding
  paddingY={1}              // Vertical padding
  alignSelf="flex-start"    // Alignment
/>
```

## Chalk Styling

Chalk provides method chaining for terminal string styling:

```javascript
// Color methods
chalk.rgb(255, 100, 50)("text")     // RGB foreground color
chalk.bgRgb(0, 0, 0)("text")        // RGB background color
chalk.ansi256(208)("text")          // 256-color mode

// Style methods
chalk.bold("text")
chalk.italic("text")
chalk.underline("text")
chalk.strikethrough("text")
chalk.inverse("text")

// Chaining
chalk.rgb(255,0,0).bgRgb(0,0,0).bold.italic("styled text")
```

## Theme Color System

Claude Code defines 60+ named colors in its theme system (from `types.ts`):

### Core Colors
| Name | Purpose |
|------|---------|
| `text` | Primary text color |
| `inverseText` | Inverted text |
| `subtle` | Muted/secondary text |
| `inactive` | Disabled elements |
| `suggestion` | Autocomplete suggestions |

### UI Colors
| Name | Purpose |
|------|---------|
| `claude` | Claude branding color |
| `claudeShimmer` | Claude shimmer effect |
| `promptBorder` | Input prompt border |
| `promptBorderShimmer` | Input prompt shimmer |
| `bashBorder` | Bash command border |
| `permission` | Permission request accent |
| `permissionShimmer` | Permission shimmer |

### Status Colors
| Name | Purpose |
|------|---------|
| `success` | Success messages (green) |
| `error` | Error messages (red) |
| `warning` | Warning messages (yellow) |
| `warningShimmer` | Warning shimmer |

### Diff Colors
| Name | Purpose |
|------|---------|
| `diffAdded` | Added lines |
| `diffRemoved` | Removed lines |
| `diffAddedDimmed` | Dimmed added lines |
| `diffRemovedDimmed` | Dimmed removed lines |
| `diffAddedWord` | Added words (inline) |
| `diffRemovedWord` | Removed words (inline) |

### Subagent Colors
| Name | Purpose |
|------|---------|
| `red_FOR_SUBAGENTS_ONLY` | Subagent red |
| `blue_FOR_SUBAGENTS_ONLY` | Subagent blue |
| `green_FOR_SUBAGENTS_ONLY` | Subagent green |
| `yellow_FOR_SUBAGENTS_ONLY` | Subagent yellow |
| `purple_FOR_SUBAGENTS_ONLY` | Subagent purple |
| `orange_FOR_SUBAGENTS_ONLY` | Subagent orange |
| `pink_FOR_SUBAGENTS_ONLY` | Subagent pink |
| `cyan_FOR_SUBAGENTS_ONLY` | Subagent cyan |

### Rainbow Colors (used for special animations)
| Name | Purpose |
|------|---------|
| `rainbow_red` | Rainbow spectrum |
| `rainbow_orange` | Rainbow spectrum |
| `rainbow_yellow` | Rainbow spectrum |
| `rainbow_green` | Rainbow spectrum |
| `rainbow_blue` | Rainbow spectrum |
| `rainbow_indigo` | Rainbow spectrum |
| `rainbow_violet` | Rainbow spectrum |

## How tweakcc Patches Colors

tweakcc modifies Claude Code by finding patterns in the minified `cli.js`:

### 1. Theme Switch Statement

```javascript
// tweakcc finds this pattern:
switch(themeVar){
  case"light":return{...lightColors};
  case"dark":return{...darkColors};
}

// And replaces with custom themes:
switch(themeVar){
  case"custom":return{...customColors};
  default:return{...customColors};
}
```

### 2. Finding Components

tweakcc uses pattern matching to find React components:

```typescript
// Find Text component
const textPattern = /function ([$\w]+)\({color:[$\w]+,backgroundColor:[$\w]+,dimColor/;

// Find Box component
const boxPattern = /\.displayName="Box"/;

// Find Chalk variable (most used styling)
const chalkPattern = /\.(cyan|gray|green|red|yellow|ansi256|bold|dim)\(/g;
```

### 3. Building Chalk Chains

```typescript
// tweakcc's buildChalkChain() function:
function buildChalkChain(
  chalkVar: string,
  rgbValues: string | null,      // "255,100,50"
  backgroundRgbValues: string,
  bold: boolean,
  italic: boolean,
  underline: boolean,
  strikethrough: boolean,
  inverse: boolean
): string {
  let chain = chalkVar;

  if (rgbValues) chain += `.rgb(${rgbValues})`;
  if (backgroundRgbValues) chain += `.bgRgb(${backgroundRgbValues})`;
  if (bold) chain += '.bold';
  if (italic) chain += '.italic';
  if (underline) chain += '.underline';
  if (strikethrough) chain += '.strikethrough';
  if (inverse) chain += '.inverse';

  return chain;
}
```

## Example: Styling the Thinking Label

The "∴ Thinking…" label is styled using this approach:

```typescript
// Original in cli.js:
React.createElement(Text, null, thinkingTextVar)

// tweakcc patches to:
React.createElement(Box, null,
  React.createElement(Text, {italic:true, dimColor:true}, thinkingTextVar)
)
```

## Example: User Message Display

User messages can be customized with:

```typescript
// Chalk chain for custom styling:
chalk.rgb(255,255,255).bgRgb(50,50,50).bold("user message")

// Or using Ink Text props:
<Text color="text" backgroundColor="userMessageBackground">
  {message}
</Text>
```

## Color Format Reference

### RGB Format
```javascript
"rgb(255, 100, 50)"  // Standard RGB
"rgb(255,100,50)"    // Compact (used in patches)
```

### Hex Format
```javascript
"#ff6432"            // 6-digit hex
"#f64"               // 3-digit hex (expanded to #ff6644)
```

### HSL Format
```javascript
"hsl(15, 100%, 60%)" // Hue, Saturation, Lightness
```

### 256-Color Mode
```javascript
chalk.ansi256(208)   // Color number 0-255
"38;5;208"           // ANSI escape sequence format
```

## Practical Tips

1. **Theme Colors vs. Hardcoded**: Use theme color names (like `"text"`, `"success"`) for consistency with light/dark themes

2. **Chalk for Dynamic Styling**: Use chalk when you need runtime-computed colors or complex styling chains

3. **Ink for Layout**: Use Ink Box/Text components for structural UI elements

4. **dimColor for Subtlety**: Use `dimColor={true}` instead of gray colors for better theme compatibility

5. **Bold for Emphasis**: Prefer `bold` over brighter colors for emphasis

## Related Files

- `tweakcc/src/patches/themes.ts` - Theme patching logic
- `tweakcc/src/patches/userMessageDisplay.ts` - Message styling
- `tweakcc/src/patches/thinkingLabel.ts` - Thinking label styling
- `tweakcc/src/types.ts` - Theme type definitions
- `tweakcc/src/utils.ts` - buildChalkChain helper
