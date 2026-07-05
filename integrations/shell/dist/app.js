// @bun
var __require = import.meta.require;

// src/app.tsx
import { createComponent as _$createComponent } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { render, useKeyboard, useRenderer } from "@opentui/solid";
import { createSignal, onMount } from "solid-js";
import { SyntaxStyle as SyntaxStyle2, TextAttributes } from "@opentui/core";

// src/bootstrap.ts
import { RGBA } from "@opentui/core";
import { boot } from "@opencues/runtime/dist/adapters/shell/v1/boot";
import { buildOpenTuiModifiers } from "@opencues/runtime/dist/src/modules/mac-keyboard";
import { createSourceReclassifier } from "@opencues/runtime/dist/src/boot-common";
import { codeUnitsToCells } from "@opencues/runtime/dist/src/util/cell-width";
import {
  createBlankInvoke,
  createDefaultBlanksRegistry
} from "@opencues/runtime/dist/src/blanks";
import {
  validateScriptPath,
  appendAuditLog
} from "@opencues/runtime/dist/src/security/spawn-sandbox";
import { wrapWithBwrap } from "@opencues/runtime/dist/src/security/sandbox-runner";
import {
  buildUserBlankRegistry,
  createNativeLlmAdapter
} from "@opencues/runtime/dist/src/user-blanks/registry";
import { parseSingleCueMd } from "@opencues/core";
import {
  existsSync as fsExistsSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync
} from "fs";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { spawn as nodeSpawn } from "child_process";

// src/daemon-client.ts
import * as net from "net";
function writeFrame(sock, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  sock.write(head);
  sock.write(body);
}
function readFrame(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let needed = -1;
    let received = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("daemon read timeout"));
    }, timeoutMs);
    const onData = (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (needed < 0 && received >= 4) {
        const head = Buffer.concat(chunks);
        needed = head.readUInt32BE(0);
        if (needed < 0 || needed > 32 * 1024 * 1024) {
          cleanup();
          reject(new Error(`daemon: oversized frame (${needed} bytes)`));
          return;
        }
      }
      if (needed >= 0 && received >= needed + 4) {
        const all = Buffer.concat(chunks);
        const body = all.slice(4, 4 + needed).toString("utf8");
        cleanup();
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      }
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("daemon closed before frame complete"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("error", onErr);
      sock.off("end", onEnd);
    };
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.on("end", onEnd);
  });
}
async function fetchSnapshot(sockPath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.createConnection(sockPath);
    const connectTimer = setTimeout(() => {
      if (settled)
        return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve(null);
    }, timeoutMs);
    sock.once("error", () => {
      if (settled)
        return;
      settled = true;
      clearTimeout(connectTimer);
      resolve(null);
    });
    sock.once("connect", async () => {
      clearTimeout(connectTimer);
      try {
        writeFrame(sock, { cmd: "GET_SNAPSHOT" });
        const reply = await readFrame(sock, timeoutMs);
        if (!settled) {
          settled = true;
          if (reply?.ok && reply.snapshot)
            resolve(reply.snapshot);
          else
            resolve(null);
        }
      } catch {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      } finally {
        try {
          sock.end();
        } catch {}
      }
    });
  });
}

class SnapshotCache {
  snap;
  constructor(snap) {
    this.snap = snap;
  }
  readFile(absPath) {
    if (Object.prototype.hasOwnProperty.call(this.snap.files, absPath)) {
      return { hit: true, content: this.snap.files[absPath] ?? null };
    }
    return { hit: false };
  }
  readDir(absPath) {
    if (Object.prototype.hasOwnProperty.call(this.snap.dirs, absPath)) {
      return { hit: true, entries: this.snap.dirs[absPath] ?? null };
    }
    return { hit: false };
  }
  get version() {
    return this.snap.version;
  }
  get builtAt() {
    return this.snap.builtAt;
  }
}

// src/bootstrap.ts
var _daemonCache = null;
var _ocSock = process.env["OPENCUES_OCEDITD_SOCK"];
if (_ocSock) {
  try {
    const snap = await fetchSnapshot(_ocSock);
    if (snap) {
      _daemonCache = new SnapshotCache(snap);
    }
  } catch {}
}
function userCwd() {
  return process.env["OPENCUES_USER_CWD"] || process.cwd();
}
function getCuesRoots() {
  const roots = [];
  if (process.env["OPENCUES_HOME"])
    roots.push(process.env["OPENCUES_HOME"]);
  roots.push(path.join(userCwd(), ".cues"));
  roots.push(path.join(os.homedir(), ".cues"));
  return roots;
}
function findOpenCuesMdPath() {
  if (process.env["OPENCUES_HOME"]) {
    return path.join(process.env["OPENCUES_HOME"], "OPENCUES.md");
  }
  return path.join(process.env["HOME"] ?? os.homedir(), ".cues", "OPENCUES.md");
}
function findIdentityMdPath() {
  if (process.env["OPENCUES_HOME"]) {
    return path.join(process.env["OPENCUES_HOME"], "IDENTITY.md");
  }
  return path.join(process.env["HOME"] ?? os.homedir(), ".cues", "IDENTITY.md");
}
function resolveTtsScript() {
  const root = process.env["OPENCUES_HOME"] ?? path.join(process.env["HOME"] ?? os.homedir(), ".cues");
  return path.join(root, "scripts/speak.sh");
}
var blanksRegistry = createDefaultBlanksRegistry({
  finnhubApiKey: process.env["FINNHUB_API_KEY"],
  opencuesMdIO: {
    readFile: async () => {
      try {
        return await fs.readFile(findOpenCuesMdPath(), "utf8");
      } catch {
        return null;
      }
    },
    writeFile: async (content) => {
      await fs.writeFile(findOpenCuesMdPath(), content, "utf8");
    }
  },
  identityMdIO: {
    readFile: async () => {
      try {
        return await fs.readFile(findIdentityMdPath(), "utf8");
      } catch {
        return null;
      }
    },
    writeFile: async (content) => {
      await fs.writeFile(findIdentityMdPath(), content, "utf8");
    }
  }
});
function _discoverUserBlankConfigs() {
  const rawRoots = [];
  if (process.env["OPENCUES_HOME"])
    rawRoots.push(process.env["OPENCUES_HOME"]);
  rawRoots.push(path.join(userCwd(), ".cues"));
  rawRoots.push(path.join(process.env["HOME"] ?? os.homedir(), ".cues"));
  const seen = new Set;
  const roots = [];
  for (const r of rawRoots) {
    const abs = path.resolve(r);
    if (seen.has(abs))
      continue;
    seen.add(abs);
    roots.push(abs);
  }
  const cache = _daemonCache;
  const dirEntries = (p) => {
    if (cache) {
      const hit = cache.readDir(p);
      if (hit.hit)
        return hit.entries;
    }
    try {
      return fsReaddirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return null;
    }
  };
  const fileContent = (p) => {
    if (cache) {
      const hit = cache.readFile(p);
      if (hit.hit)
        return hit.content;
    }
    try {
      return fsReadFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  const fileExists = (p) => {
    if (cache) {
      const fileHit = cache.readFile(p);
      if (fileHit.hit)
        return fileHit.content !== null;
      const dirHit = cache.readDir(p);
      if (dirHit.hit)
        return dirHit.entries !== null;
    }
    return fsExistsSync(p);
  };
  const out = [];
  for (const root of roots) {
    const blanksDir = path.join(root, "blanks");
    if (!fileExists(blanksDir))
      continue;
    const entries = dirEntries(blanksDir);
    if (!entries)
      continue;
    for (const entry of entries) {
      if (!entry.isDirectory)
        continue;
      const blankMdPath = path.join(blanksDir, entry.name, "BLANK.md");
      const content = fileContent(blankMdPath);
      if (content === null)
        continue;
      try {
        const parsed = parseSingleCueMd(content, path.dirname(blankMdPath));
        const blk = parsed.blanks?.[entry.name];
        if (blk?.impl)
          out.push(blk);
      } catch {}
    }
  }
  return out;
}
var _userBlanks = buildUserBlankRegistry(_discoverUserBlankConfigs(), {
  storageRoot: process.env["OPENCUES_HOME"] ?? path.join(process.env["HOME"] ?? os.homedir(), ".cues"),
  secrets: process.env,
  llm: createNativeLlmAdapter(process.env),
  log: (lvl, msg) => {
    if (lvl === "warn" || lvl === "error")
      console.warn(`[opencues] user-blank ${lvl}: ${msg}`);
    else if (process.env["DEBUG_OPENCUES"])
      console.log(`[opencues] user-blank ${lvl}: ${msg}`);
  }
});
for (const [n, b] of _userBlanks)
  blanksRegistry.set(n, b);
var blankInvoke = createBlankInvoke(blanksRegistry);
var sourceReclassifier = createSourceReclassifier();
var bootResult;
function startOpenCues(opts) {
  if (bootResult)
    return bootResult;
  const log = (level, msg, data) => {
    try {
      const ts = new Date().toISOString().slice(11, 23);
      let dataStr = "";
      if (data !== undefined && data !== null) {
        if (data instanceof Error) {
          dataStr = `${data.name}: ${data.message}${data.stack ? `
` + data.stack : ""}`;
        } else if (typeof data === "string") {
          dataStr = data;
        } else {
          dataStr = JSON.stringify(data).slice(0, 400);
        }
      }
      const line = `[${ts}][term][${level}] ${msg} ${dataStr}
`;
      __require("fs").appendFile("/tmp/opencues.log", line, () => {});
    } catch {}
  };
  const getText = () => opts.textarea.plainText;
  const getCursor = () => opts.textarea.cursorOffset;
  bootResult = boot({
    hostVersion: "0.1.0",
    cwd: opts.cwd || process.cwd(),
    getText,
    getCursorOffset: getCursor,
    setText: (text) => {
      sourceReclassifier.markRuntimeWrite(text);
      opts.textarea.setText(text);
      ownedExtmarks = new Map;
    },
    setCursorOffset: (offset) => {
      opts.textarea.cursorOffset = offset;
    },
    pushText: (text, cursor) => {
      sourceReclassifier.markRuntimeWrite(text);
      opts.textarea.setText(text);
      if (cursor !== undefined)
        opts.textarea.cursorOffset = cursor;
      ownedExtmarks = new Map;
    },
    forceRender: () => {
      try {
        triggerOpenCuesRender(getText(), getCursor());
      } catch {}
      opts.renderer.requestRender();
    },
    readFile: async (p) => {
      if (_daemonCache) {
        const hit = _daemonCache.readFile(p);
        if (hit.hit)
          return hit.content;
      }
      try {
        return await fs.readFile(p, "utf8");
      } catch {
        return null;
      }
    },
    readDir: async (p) => {
      if (_daemonCache) {
        const hit = _daemonCache.readDir(p);
        if (hit.hit)
          return hit.entries;
      }
      try {
        const entries = await fs.readdir(p, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
      } catch {
        return null;
      }
    },
    writeFile: async (p, c) => {
      await fs.writeFile(p, c);
    },
    spawnProcess: (spec) => {
      const cuesRoots = getCuesRoots();
      const rawArgs = Array.isArray(spec.args) ? spec.args.map(String) : [];
      const safeArgs = [];
      for (const a of rawArgs) {
        const r = validateScriptPath(a, cuesRoots);
        if (!r.ok) {
          appendAuditLog("shell", spec, { exitCode: 126 }, cuesRoots);
          return {
            result: Promise.resolve({ exitCode: 126, stdout: "", stderr: r.reason ?? "path outside CUES roots", timedOut: false }),
            kill: () => {}
          };
        }
        safeArgs.push(r.resolved ?? a);
      }
      const wrapped = wrapWithBwrap(spec.command, safeArgs, spec.sandbox, cuesRoots);
      const finalCommand = wrapped?.command ?? spec.command;
      const finalArgs = wrapped?.args ?? safeArgs;
      const startedAt = Date.now();
      const wantStdin = typeof spec.input === "string" && spec.input.length > 0;
      const stdio = spec.detached ? "ignore" : [wantStdin ? "pipe" : "ignore", "pipe", "pipe"];
      let child;
      try {
        child = nodeSpawn(finalCommand, finalArgs, {
          env: spec.env,
          cwd: spec.cwd,
          detached: !!spec.detached,
          stdio
        });
      } catch (err) {
        appendAuditLog("shell", spec, { exitCode: 127 }, cuesRoots);
        return {
          result: Promise.resolve({ exitCode: 127, stdout: "", stderr: String(err?.message ?? err), timedOut: false }),
          kill: () => {}
        };
      }
      if (wantStdin && child.stdin) {
        try {
          child.stdin.write(spec.input);
          child.stdin.end();
        } catch {}
      }
      let stdout = "", stderr = "";
      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      const result = new Promise((resolve2) => {
        let timedOut = false;
        let killer = null;
        const timer = spec.timeoutMs ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGTERM");
          } catch {}
          killer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 1000);
        }, spec.timeoutMs) : null;
        const finish = (code) => {
          if (timer)
            clearTimeout(timer);
          if (killer)
            clearTimeout(killer);
          const exit = code ?? 0;
          appendAuditLog("shell", spec, { exitCode: exit, timedOut }, cuesRoots, Date.now() - startedAt);
          resolve2({ exitCode: exit, stdout, stderr, timedOut });
        };
        child.on("exit", finish);
        child.on("error", (err) => {
          stderr += String(err?.message ?? err);
          finish(127);
        });
      });
      if (spec.detached)
        child.unref();
      return { result, kill: (sig) => {
        try {
          child.kill(sig || "SIGTERM");
        } catch {}
      } };
    },
    log,
    blankInvoke,
    blanks: blanksRegistry,
    statusFilePath: `/tmp/opencues-status-${process.pid}.json`,
    cursorStatePath: `/tmp/opencues-cursor-state-${process.pid}.json`,
    statusSnapshotHook: (payload) => {
      if (!opts.onTipChange)
        return;
      const tut = payload?.tutorial;
      if (tut) {
        const head = tut.stepCount > 0 ? `C_ Tutorial ${tut.step}/${tut.stepCount}:` : "C_ Tutorial:";
        opts.onTipChange(`${head} ${tut.coach ?? tut.stepTitle}`);
        return;
      }
      const agentTask = payload?.agentTask;
      const agentBadge = agentTask ? `[task: ${agentTask}]` : null;
      let wordPart = null;
      if (payload?.active) {
        const tip = payload?.cueTip;
        const word = payload?.highlightedWord;
        const alts = payload?.alts;
        const cueBlank = !!payload?.cueBlank;
        if (cueBlank) {
          wordPart = tip ?? null;
        } else if (alts && alts.length > 1 && word) {
          const idx = (payload?.currentAltIndex ?? 0) + 1;
          const head = `${word} (${idx}/${alts.length})`;
          wordPart = tip ? `${head} - ${tip}` : head;
        } else {
          wordPart = tip ?? null;
        }
      }
      const combined = wordPart && agentBadge ? `${wordPart} | ${agentBadge}` : agentBadge ?? wordPart ?? null;
      opts.onTipChange(combined);
    },
    ttsScriptPath: resolveTtsScript(),
    ttsRate: 2,
    llmApiKey: process.env["GROQ_API_KEY"],
    llmEndpoint: process.env["OPENCUES_LLM_ENDPOINT"],
    llmDefaultModel: process.env["OPENCUES_LLM_MODEL"],
    llmApiKeys: {
      GROQ_API_KEY: process.env["GROQ_API_KEY"],
      OPENROUTER_API_KEY: process.env["OPENROUTER_API_KEY"],
      GEMINI_API_KEY: process.env["GEMINI_API_KEY"],
      OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
      ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
      CEREBRAS_API_KEY: process.env["CEREBRAS_API_KEY"]
    }
  });
  opts.textarea.onContentChange = () => {
    const text = getText();
    const cursor = getCursor();
    const actualSource = sourceReclassifier.reclassify(text, "user");
    bootResult.notifyTextChange(text, cursor, actualSource);
    triggerOpenCuesRender(text, cursor);
  };
  opts.textarea.onCursorChange = () => {
    bootResult.notifyCursorChange(getText(), getCursor(), "user");
  };
  _textareaRef = opts.textarea;
  _syntaxRef = opts.syntax;
  return bootResult;
}
function dispatchOpenCuesKey(evt) {
  if (!bootResult)
    return false;
  const text = _textareaRef?.plainText ?? "";
  const cursor = _textareaRef?.cursorOffset ?? 0;
  const keyName = normaliseKeyName(evt);
  const e = {
    key: keyName,
    modifiers: buildOpenTuiModifiers({
      ctrl: !!evt.ctrl,
      alt: !!evt.alt,
      option: !!evt.option,
      meta: !!evt.meta,
      shift: !!evt.shift,
      sequence: typeof evt.sequence === "string" ? evt.sequence : undefined,
      name: keyName
    }),
    text,
    cursorOffset: cursor
  };
  const consumed = bootResult.dispatchKey(e);
  if (consumed)
    triggerOpenCuesRender(_textareaRef?.plainText ?? text, _textareaRef?.cursorOffset ?? cursor);
  return consumed;
}
function normaliseKeyName(evt) {
  if (evt.name)
    return String(evt.name).toLowerCase();
  if (evt.sequence)
    return String(evt.sequence);
  return "";
}
var ownedExtmarks = new Map;
var styleIds = {};
var loadingColorIds = new Map;
var _textareaRef = null;
var _syntaxRef = null;
function resetOpenCuesBufferState() {
  bootResult?.resetBufferState?.();
}
function triggerOpenCuesRender(text, cursor) {
  if (!bootResult || !_textareaRef || !_syntaxRef)
    return;
  const syntax = _syntaxRef;
  const textarea = _textareaRef;
  if (textarea.isDestroyed)
    return;
  if (styleIds.dim === undefined) {
    styleIds.dim = syntax.getStyleId("opencues-dim") ?? syntax.registerStyle("opencues-dim", { dim: true });
  }
  if (styleIds.highlight === undefined) {
    styleIds.highlight = syntax.getStyleId("opencues-highlight") ?? syntax.registerStyle("opencues-highlight", {
      fg: RGBA.fromValues(1, 1, 1, 1),
      bg: RGBA.fromValues(0, 0, 0, 1)
    });
  }
  if (styleIds.bold === undefined) {
    styleIds.bold = syntax.getStyleId("opencues-bold") ?? syntax.registerStyle("opencues-bold", { bold: true });
  }
  if (styleIds.italic === undefined) {
    styleIds.italic = syntax.getStyleId("opencues-italic") ?? syntax.registerStyle("opencues-italic", { italic: true });
  }
  if (styleIds.code === undefined) {
    styleIds.code = syntax.getStyleId("opencues-code") ?? syntax.registerStyle("opencues-code", { fg: RGBA.fromValues(0.9, 0.7, 0.4, 1) });
  }
  if (styleIds.strike === undefined) {
    try {
      styleIds.strike = syntax.getStyleId("opencues-strike") ?? syntax.registerStyle("opencues-strike", { strikethrough: true });
    } catch {
      styleIds.strike = syntax.getStyleId("opencues-strike-dim") ?? syntax.registerStyle("opencues-strike-dim", { dim: true });
    }
  }
  if (styleIds.heading === undefined) {
    styleIds.heading = syntax.getStyleId("opencues-heading") ?? syntax.registerStyle("opencues-heading", { bold: true, underline: true });
  }
  if (styleIds.list === undefined) {
    styleIds.list = syntax.getStyleId("opencues-list") ?? syntax.registerStyle("opencues-list", { fg: RGBA.fromValues(0.7, 0.7, 0.7, 1) });
  }
  if (styleIds.typeId === undefined) {
    styleIds.typeId = textarea.extmarks.registerType("opencues");
  }
  const desired = new Map;
  const addRanges = (ranges, kind) => {
    if (!ranges)
      return;
    for (const r of ranges) {
      desired.set(`${kind}:${r.start}:${r.end}`, { kind, start: r.start, end: r.end });
    }
  };
  const desiredColored = new Map;
  const directiveSets = bootResult.collectRenderDirectives(text, cursor);
  for (const directives of directiveSets) {
    addRanges(directives.dimRanges, "d");
    if (directives.highlight) {
      const h = directives.highlight;
      desired.set(`h:${h.start}:${h.end}`, { kind: "h", start: h.start, end: h.end });
    }
    addRanges(directives.boldRanges, "b");
    addRanges(directives.italicRanges, "i");
    addRanges(directives.codeRanges, "c");
    addRanges(directives.strikeRanges, "s");
    addRanges(directives.headingRanges, "H");
    addRanges(directives.listRanges, "L");
    const cr = directives.coloredRanges;
    if (cr) {
      for (const r of cr) {
        if (!r.rgb)
          continue;
        const hex = r.rgb.toLowerCase();
        desiredColored.set(`load:${hex}:${r.start}:${r.end}`, { hex, start: r.start, end: r.end });
      }
    }
  }
  for (const [key, id] of ownedExtmarks) {
    if (desired.has(key) || desiredColored.has(key))
      continue;
    try {
      textarea.extmarks.delete?.(id);
    } catch {}
    ownedExtmarks.delete(key);
  }
  const styleFor = (kind) => {
    switch (kind) {
      case "d":
        return styleIds.dim;
      case "h":
        return styleIds.highlight;
      case "b":
        return styleIds.bold;
      case "i":
        return styleIds.italic;
      case "c":
        return styleIds.code;
      case "s":
        return styleIds.strike;
      case "H":
        return styleIds.heading;
      case "L":
        return styleIds.list;
    }
  };
  const toCell = (offset) => codeUnitsToCells(text, offset);
  for (const [key, spec] of desired) {
    if (ownedExtmarks.has(key))
      continue;
    const styleId = styleFor(spec.kind);
    if (styleId === undefined)
      continue;
    const id = textarea.extmarks.create({
      start: toCell(spec.start),
      end: toCell(spec.end),
      styleId,
      typeId: styleIds.typeId
    });
    ownedExtmarks.set(key, id);
  }
  for (const [key, spec] of desiredColored) {
    if (ownedExtmarks.has(key))
      continue;
    let styleId = loadingColorIds.get(spec.hex);
    if (styleId === undefined) {
      const styleName = `opencues-load-${spec.hex.slice(1)}`;
      try {
        styleId = syntax.getStyleId(styleName) ?? syntax.registerStyle(styleName, { fg: RGBA.fromHex(spec.hex) });
      } catch {
        continue;
      }
      loadingColorIds.set(spec.hex, styleId);
    }
    const id = textarea.extmarks.create({
      start: toCell(spec.start),
      end: toCell(spec.end),
      styleId,
      typeId: styleIds.typeId
    });
    ownedExtmarks.set(key, id);
  }
}

// src/app.tsx
process.on("SIGINT", () => {});
function App(props) {
  const renderer = useRenderer();
  const [tip, setTip] = createSignal(null);
  const tipRows = () => {
    const t = tip();
    if (t == null)
      return [];
    const width = Math.max(20, (process.stdout.columns ?? 80) - 4);
    const rows = [];
    let rest = t.trim();
    while (rest.length > 0 && rows.length < 3) {
      if (rest.length <= width) {
        rows.push(rest);
        break;
      }
      let cut = rest.lastIndexOf(" ", width);
      if (cut < width * 0.6)
        cut = width;
      rows.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (rest.length > 0 && rows.length === 3 && rows[2].length > 1) {
      rows[2] = rows[2].slice(0, Math.max(0, width - 1)) + "\u2026";
    }
    return rows.length > 0 ? rows : [""];
  };
  let textarea;
  const syntax = SyntaxStyle2.create();
  onMount(() => {
    if (!textarea)
      return;
    textarea.syntaxStyle = syntax;
    if (props.initialText) {
      textarea.setText(props.initialText);
      textarea.cursorOffset = props.initialText.length;
    }
    startOpenCues({
      renderer,
      textarea,
      syntax,
      cwd: process.env.OPENCUES_USER_CWD || process.cwd(),
      onTipChange: (t) => setTip(t)
    });
    textarea.focus();
  });
  useKeyboard((evt) => {
    if (evt.ctrl && evt.meta && evt.name === "s") {
      finish(textarea?.plainText ?? "", 0);
      return;
    }
    if (evt.sequence === "\x1B\x13") {
      finish(textarea?.plainText ?? "", 0);
      return;
    }
    if (evt.ctrl && evt.meta && evt.name === "q") {
      finish("", 130);
      return;
    }
    if (evt.sequence === "\x1B\x11") {
      finish("", 130);
      return;
    }
    if (evt.ctrl && !evt.meta && evt.name === "c" || evt.sequence === "\x03") {
      try {
        if (textarea) {
          textarea.setText("");
          textarea.cursorOffset = 0;
        }
        resetOpenCuesBufferState();
      } catch {}
      return;
    }
    dispatchOpenCuesKey(evt);
  });
  function finish(text, exitCode) {
    if (props.keepAlive) {
      const toInject = exitCode === 0 ? text : props.restoreOnCancel ?? "";
      if (toInject && props.targetPane) {
        try {
          injectIntoPane(props.targetPane, toInject);
        } catch {}
      }
      if (textarea) {
        try {
          textarea.setText("");
          textarea.cursorOffset = 0;
        } catch {}
      }
      try {
        resetOpenCuesBufferState();
      } catch {}
      deactivate();
      return;
    }
    try {
      renderer?.destroy?.();
    } catch {}
    try {
      if (props.outputPath) {
        __require("fs").writeFileSync(props.outputPath, text);
      } else {
        process.stdout.write(text + `
`);
      }
    } catch {}
    setTimeout(() => process.exit(exitCode), 0);
  }
  function deactivate() {
    const tmuxBin = process.env.OPENCUES_TMUX || "tmux";
    const me = process.env.TMUX_PANE;
    try {
      if (me)
        runTmux(tmuxBin, ["kill-pane", "-t", me]);
    } catch {}
    setTimeout(() => process.exit(0), 50);
  }
  if (props.keepAlive) {
    return (() => {
      var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("textarea");
      _$insertNode(_el$, _el$2);
      _$setProp(_el$, "style", {
        flexDirection: "column",
        width: "100%",
        height: "100%",
        paddingLeft: 1,
        paddingRight: 1
      });
      _$insertNode(_el$2, _el$3);
      _$setProp(_el$2, "style", {
        flexGrow: 1,
        width: "100%"
      });
      _$use((t) => {
        textarea = t;
      }, _el$3);
      _$setProp(_el$3, "style", {
        width: "100%",
        height: "100%"
      });
      _$setProp(_el$3, "wrapMode", "word");
      _$insert(_el$, (() => {
        var _c$ = _$memo(() => tip() != null);
        return () => _c$() && (() => {
          var _el$4 = _$createElement("box");
          _$insert(_el$4, () => tipRows().map((row) => (() => {
            var _el$5 = _$createElement("text");
            _$insert(_el$5, row);
            return _el$5;
          })()));
          _$effect((_$p) => _$setProp(_el$4, "style", {
            height: tipRows().length,
            width: "100%",
            paddingLeft: 1,
            paddingRight: 1,
            flexDirection: "column"
          }, _$p));
          return _el$4;
        })();
      })(), null);
      return _el$;
    })();
  }
  return (() => {
    var _el$6 = _$createElement("box"), _el$7 = _$createElement("box"), _el$8 = _$createElement("textarea"), _el$9 = _$createElement("box");
    _$insertNode(_el$6, _el$7);
    _$insertNode(_el$6, _el$9);
    _$setProp(_el$6, "style", {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      paddingLeft: 1,
      paddingRight: 1
    });
    _$insertNode(_el$7, _el$8);
    _$setProp(_el$7, "style", {
      flexGrow: 1,
      width: "100%"
    });
    _$use((t) => {
      textarea = t;
    }, _el$8);
    _$setProp(_el$8, "style", {
      width: "100%",
      height: "100%"
    });
    _$setProp(_el$8, "wrapMode", "word");
    _$setProp(_el$9, "style", {
      height: 1,
      width: "100%",
      flexDirection: "row",
      backgroundColor: "#1a1a1a",
      paddingLeft: 1,
      paddingRight: 1
    });
    _$insert(_el$9, (() => {
      var _c$2 = _$memo(() => tip() != null);
      return () => _c$2() ? (() => {
        var _el$0 = _$createElement("text");
        _$setProp(_el$0, "fg", "#ffffff");
        _$insert(_el$0, tip);
        return _el$0;
      })() : (() => {
        var _el$1 = _$createElement("box"), _el$10 = _$createElement("text"), _el$12 = _$createElement("text");
        _$insertNode(_el$1, _el$10);
        _$insertNode(_el$1, _el$12);
        _$setProp(_el$1, "style", {
          flexDirection: "row"
        });
        _$insertNode(_el$10, _$createTextNode(`C_`));
        _$setProp(_el$10, "fg", "#1a1a1a");
        _$setProp(_el$10, "bg", "#ffffff");
        _$insertNode(_el$12, _$createTextNode(` OpenCues_ \xB7 Submit: Ctrl+Alt+S \xB7 Cancel: Ctrl+Alt+Q`));
        _$setProp(_el$12, "fg", "#ffffff");
        _$effect((_$p) => _$setProp(_el$10, "attributes", TextAttributes.BOLD, _$p));
        return _el$1;
      })();
    })());
    return _el$6;
  })();
}
function runTmux(tmuxBin, args) {
  const {
    spawnSync
  } = __require("child_process");
  spawnSync(tmuxBin, args, {
    stdio: ["ignore", "ignore", "inherit"]
  });
}
function injectIntoPane(targetPane, text) {
  const tmuxBin = process.env.OPENCUES_TMUX || "tmux";
  const mode = process.env.OPENCUES_POPUP_PASTE_MODE || "typed";
  if (mode === "typed") {
    const lines = text.split(`
`);
    for (let i = 0;i < lines.length; i++) {
      if (lines[i])
        runTmux(tmuxBin, ["send-keys", "-t", targetPane, "-l", lines[i]]);
      if (i < lines.length - 1)
        runTmux(tmuxBin, ["send-keys", "-t", targetPane, "C-j"]);
    }
    return;
  }
  const fs2 = __require("fs");
  const os2 = __require("os");
  const path2 = __require("path");
  const tmp = path2.join(os2.tmpdir(), `oc-popup-buf-${process.pid}-${Date.now()}`);
  fs2.writeFileSync(tmp, text);
  try {
    runTmux(tmuxBin, ["load-buffer", "-b", "oc-popup", tmp]);
    const flags = mode === "raw" ? ["-b", "oc-popup", "-t", targetPane] : ["-p", "-b", "oc-popup", "-t", targetPane];
    runTmux(tmuxBin, ["paste-buffer", ...flags]);
    runTmux(tmuxBin, ["delete-buffer", "-b", "oc-popup"]);
  } finally {
    try {
      fs2.unlinkSync(tmp);
    } catch {}
  }
}
function parseArgs(argv) {
  let initialText = "";
  let outputPath = null;
  let keepAlive = false;
  let targetPane = null;
  for (let i = 2;i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "-o") {
      outputPath = argv[++i] ?? null;
    } else if (a === "--initial" || a === "-i") {
      initialText = argv[++i] ?? "";
    } else if (a === "--keep-alive") {
      keepAlive = true;
    } else if (a === "--target-pane") {
      targetPane = argv[++i] ?? null;
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: oc-edit [--initial TEXT] [--out FILE]");
      console.log("       echo TEXT | oc-edit");
      console.log("Slide-pane mode (used by `oc-shell`):");
      console.log("       oc-edit --keep-alive --target-pane <pane-id>");
      process.exit(0);
    } else if (!a.startsWith("-")) {
      try {
        initialText = __require("fs").readFileSync(a, "utf8");
        outputPath = a;
      } catch {}
    }
  }
  return {
    initialText,
    outputPath,
    keepAlive,
    targetPane
  };
}
async function main() {
  const args = parseArgs(process.argv);
  let restoreOnCancel;
  const lineBuf = process.env["OPENCUES_LINE_BUF"];
  if (lineBuf && !args.initialText) {
    try {
      const fs2 = __require("fs");
      if (fs2.existsSync(lineBuf)) {
        const captured = fs2.readFileSync(lineBuf, "utf8");
        if (captured) {
          args.initialText = captured;
          restoreOnCancel = captured;
        }
        fs2.unlinkSync(lineBuf);
      }
    } catch {}
  }
  if (!process.stdin.isTTY && !args.initialText) {
    args.initialText = await new Promise((resolve2) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buf += chunk;
      });
      process.stdin.on("end", () => resolve2(buf));
    });
  }
  await render(() => _$createComponent(App, {
    get initialText() {
      return args.initialText;
    },
    get outputPath() {
      return args.outputPath;
    },
    get keepAlive() {
      return args.keepAlive;
    },
    get targetPane() {
      return args.targetPane ?? undefined;
    },
    restoreOnCancel
  }), {
    exitOnCtrlC: false
  });
}
main().catch((err) => {
  console.error("[oc-edit] fatal:", err);
  process.exit(1);
});
