# Cursor Position Tracking

Exports Claude Code's input cursor state to a JSON file, enabling external tools to know:
- Current cursor position (character offset)
- The word the cursor is currently on
- Whether the cursor is at the end of the input
- The full input text

## Performance

Uses **debounced async writes** to avoid blocking the UI:
- Non-blocking `fs.promises.writeFile()` (doesn't freeze input)
- 100ms debounce batches rapid keystrokes
- File updates ~100ms after typing stops

## Output Format

Written to `/tmp/claude-cursor-state.json` (updates ~100ms after typing stops):

```json
{
  "text": "the full input text",
  "cursorPosition": 15,
  "currentWord": "input",
  "atEnd": false,
  "textLength": 19,
  "timestamp": 1705500000000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | Complete input text |
| `cursorPosition` | number | 0-indexed character offset from start |
| `currentWord` | string | Word containing/adjacent to cursor |
| `atEnd` | boolean | True if cursor is at end of text |
| `textLength` | number | Total characters in input |
| `timestamp` | number | Unix timestamp (ms) when written |

## Version Compatibility

| Claude Code Version | Status | Notes |
|---------------------|--------|-------|
| v0.2.x | Untested | Pattern should work (function `RI1`) |
| v2.0.67 | Working | Tested, function `f31` |
| v2.0.x | Should work | Same pattern as v2.0.67 |
| v2.1.x | Untested | May need pattern updates |

## Installation

### Prerequisites

1. **Clone tweakcc with our patches:**
   ```bash
   cd /home/wilfred
   git clone https://github.com/Piebald-AI/tweakcc.git tweakcc-source
   ```

2. **Apply our custom patch files** (copy from this repo):
   - `src/patches/cursorStateExport.ts` - The main patch
   - Update `src/patches/index.ts` - Add import and application
   - Update `src/types.ts` - Add config types
   - Update `src/defaultSettings.ts` - Add defaults

### Build and Apply

```bash
cd /home/wilfred/tweakcc-source

# Install dependencies
npm install --legacy-peer-deps

# Build
npm run build

# Apply to Claude Code (specify installation path if multiple)
TWEAKCC_CC_INSTALLATION_PATH="/home/wilfred/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js" \
  node dist/index.mjs --apply
```

### Configuration

The feature is controlled by two settings in tweakcc config:

```typescript
// In src/types.ts - MiscConfig interface
enableCursorStateExport?: boolean;   // Enable/disable the feature
cursorStateExportPath?: string;      // Output file path (default: /tmp/claude-cursor-state.json)
```

```typescript
// In src/defaultSettings.ts
enableCursorStateExport: true,
cursorStateExportPath: '/tmp/claude-cursor-state.json',
```

## How It Works

### Architecture

```
Claude Code Input Box
        │
        ▼
┌─────────────────────────────┐
│  Input State Handler (f31)  │ ◄── tweakcc injects code here
│  - value (text)             │
│  - externalOffset (cursor)  │
│  - InputZone instance       │
└─────────────────────────────┘
        │
        ▼ (on every keystroke)
┌─────────────────────────────┐
│  Injected Export Code       │
│  - Compute currentWord      │
│  - Debounce (100ms)         │
│  - Async write to file      │
└─────────────────────────────┘
        │
        ▼ (after 100ms idle)
/tmp/claude-cursor-state.json
```

### Key Components in cli.js

1. **Input State Handler Function** (`f31` in v2.0.67, `RI1` in v0.2.x)
   - Manages all input state including text and cursor position
   - Parameters: `value`, `onChange`, `externalOffset`, `onOffsetChange`
   - Creates `InputZone` instance with `fromText(value, columns, offset)`

2. **InputZone Class** (`G7` in v2.0.67, `iZ` in v0.2.x)
   - `measuredText` - The text content
   - `offset` - Cursor position (0-indexed)
   - `selection` - Selection state

3. **Pattern Used to Find Injection Point**
   ```regex
   /function ([$\w]+)\(\{value:([$\w]+),onChange:([$\w]+),[^}]+externalOffset:([$\w]+),onOffsetChange:([$\w]+)[^}]+\}\)\{let ([$\w]+)=([$\w]+),([$\w]+)=([$\w]+),([$\w]+)=([$\w]+)\.fromText\(/
   ```

### Injected Code

The patch injects this code just before the `return` statement. Uses debounced async writes to avoid blocking the UI:

```javascript
(function(){
  try{
    var _text=A;           // value parameter
    var _offset=O??0;      // offset variable
    var _words=_text.split(/\s+/);
    var _pos=0;
    var _currentWord="";
    for(var _i=0;_i<_words.length;_i++){
      var _wEnd=_pos+_words[_i].length;
      if(_offset>=_pos&&_offset<=_wEnd){_currentWord=_words[_i];break}
      _pos=_wEnd+1;
    }
    var _data={
      text:_text,
      cursorPosition:_offset,
      currentWord:_currentWord,
      atEnd:_offset>=_text.length,
      textLength:_text.length,
      timestamp:Date.now()
    };
    // Debounced async write - doesn't block UI
    if(globalThis._cwt)clearTimeout(globalThis._cwt);
    globalThis._cwt=setTimeout(function(){
      require("fs").promises.writeFile("/tmp/claude-cursor-state.json",JSON.stringify(_data)).catch(function(){});
    },100);
  }catch(_e){}
})();
```

**Key design decisions:**
- `globalThis._cwt` - Timer stored globally to persist between calls
- `clearTimeout` + `setTimeout` - Debounces rapid keystrokes (100ms)
- `fs.promises.writeFile` - Non-blocking async write
- `.catch(function(){})` - Silent failure, never crashes Claude Code

## Reading the Output

### Shell (polling)
```bash
watch -n 0.1 cat /tmp/claude-cursor-state.json
```

### Shell (inotify - Linux)
```bash
while inotifywait -e modify /tmp/claude-cursor-state.json 2>/dev/null; do
  cat /tmp/claude-cursor-state.json
  echo "---"
done
```

### Node.js
```javascript
const fs = require('fs');

fs.watch('/tmp/claude-cursor-state.json', (event) => {
  if (event === 'change') {
    const state = JSON.parse(fs.readFileSync('/tmp/claude-cursor-state.json'));
    console.log(`Cursor at ${state.cursorPosition}, word: "${state.currentWord}"`);
  }
});
```

### Python
```python
import json
import time
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

class CursorHandler(FileSystemEventHandler):
    def on_modified(self, event):
        if event.src_path.endswith('claude-cursor-state.json'):
            with open(event.src_path) as f:
                state = json.load(f)
            print(f"Cursor: {state['cursorPosition']}, Word: {state['currentWord']}")

observer = Observer()
observer.schedule(CursorHandler(), '/tmp', recursive=False)
observer.start()
```

## Extending the Feature

### Adding More State

To export additional cursor/input state, modify the `_data` object in `cursorStateExport.ts`:

```typescript
const exportCode = `
(function(){
  try{
    var _text=${valueParam};
    var _offset=${offsetVar}??0;
    // ... word detection code ...

    // Add new computed values here
    var _lineNumber = (_text.substring(0, _offset).match(/\\n/g) || []).length + 1;
    var _columnNumber = _offset - _text.lastIndexOf('\\n', _offset - 1);

    var _data={
      text:_text,
      cursorPosition:_offset,
      currentWord:_currentWord,
      atEnd:_offset>=_text.length,
      textLength:_text.length,
      lineNumber:_lineNumber,      // NEW
      columnNumber:_columnNumber,  // NEW
      timestamp:Date.now()
    };

    // Debounced async write
    if(globalThis._cwt)clearTimeout(globalThis._cwt);
    globalThis._cwt=setTimeout(function(){
      ${requireFuncName}("fs").promises.writeFile("${exportPath}",JSON.stringify(_data)).catch(function(){});
    },100);
  }catch(_e){}
})();
`;
```

### Supporting New Claude Code Versions

When Claude Code updates break the patch:

1. **Find the new function name:**
   ```bash
   grep -oP 'function \w+\(\{value:\w+,onChange:\w+.{0,200}externalOffset' cli.js
   ```

2. **Find the variable assignments:**
   ```bash
   grep -oP 'externalOffset.{100}' cli.js | head -5
   ```

3. **Update the regex pattern** in `findInputStateHandlerLocation()` if needed

4. **Rebuild and test:**
   ```bash
   npm run build && node dist/index.mjs --apply
   ```

## Files Reference

| File | Purpose |
|------|---------|
| `/home/wilfred/tweakcc-source/src/patches/cursorStateExport.ts` | Main patch implementation |
| `/home/wilfred/tweakcc-source/src/patches/index.ts` | Imports and applies the patch |
| `/home/wilfred/tweakcc-source/src/types.ts` | Config type definitions |
| `/home/wilfred/tweakcc-source/src/defaultSettings.ts` | Default values |
| `/tmp/claude-cursor-state.json` | Runtime output file |

## Troubleshooting

### Patch fails to apply

Check the console output for:
```
patch: cursorStateExport: failed to find input state handler function pattern
```

This means the regex pattern doesn't match the current cli.js structure. Use the grep commands above to identify the new pattern.

### File not being written

1. Check permissions on `/tmp`
2. Verify the patch was applied:
   ```bash
   grep 'claude-cursor-state.json' /path/to/cli.js
   # Also check for debounce code:
   grep 'globalThis._cwt' /path/to/cli.js
   ```
3. Check for JavaScript errors in Claude Code's console

### Data seems delayed

The file updates ~100ms after typing stops (by design, for performance). This is the debounce delay. If you need lower latency, you can reduce the `100` in the setTimeout call, but this increases I/O load.

### Stale data

If data seems very stale (not updating at all):
- Verify Claude Code is using the patched installation
- Check that tweakcc was applied to the correct installation path
- Verify the patch is present: `grep 'globalThis._cwt' /path/to/cli.js`

## Future Improvements

- [ ] Support for selection ranges (start/end)
- [ ] Line and column numbers
- [ ] Character under cursor
- [ ] Input mode detection (vim normal/insert)
- [ ] Unix socket option for lower latency
- [x] ~~Rate limiting option (reduce I/O)~~ - Done via debouncing
