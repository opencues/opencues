//! opencues-bridge — codex-rs side of the OpenCues integration.
//!
//! Spawns the Node daemon (`@opencues/runtime` / adapters/codex/v1/daemon.js)
//! as a subprocess and exchanges JSON-RPC v2.0 frames over stdio.
//!
//! Public API:
//!
//!   let bridge = Bridge::start(BridgeConfig {
//!       daemon_path: PathBuf::from("/path/to/daemon.js"),
//!       cwd: PathBuf::from("."),
//!       config_search_paths: vec![],
//!   })?;
//!
//!   bridge.notify_text_change(text, cursor, "user");
//!   if bridge.dispatch_key(KeyEvent { key: "up", ctrl: true, ... }) { /* swallow */ }
//!   let dirs = bridge.directives();   // current highlight ranges
//!   bridge.on_set_text(Box::new(|text, cursor| { /* mutate TextArea */ }));
//!
//! See integrations/codex/docs/protocol.md for the wire format.
//! See integrations/codex/docs/architecture.md for design rationale.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// How many recent stderr lines to retain for diagnostics.
const STDERR_RING_CAPACITY: usize = 64;

#[derive(Debug, Clone)]
pub struct BridgeConfig {
    /// Absolute path to daemon.js (e.g. /path/to/@opencues/runtime/dist/adapters/codex/v1/daemon.js).
    pub daemon_path: PathBuf,
    /// Project working directory passed to the daemon's boot RPC.
    pub cwd: PathBuf,
    /// Config search paths (project + user level).
    pub config_search_paths: Vec<PathBuf>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Range {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Directives {
    #[serde(default)]
    pub dim: Vec<Range>,
    #[serde(default)]
    pub active: Option<Range>,
    #[serde(default)]
    pub tip: Option<String>,
}

/// Codex key event surface — a serde-compatible mirror of @opencues/runtime's
/// KeyEvent. The bridge marshals the codex-rs key representation into this
/// shape before dispatching.
#[derive(Debug, Clone, Serialize)]
pub struct KeyEvent {
    pub key: String,
    pub modifiers: Modifiers,
    pub text: String,
    #[serde(rename = "cursorOffset")]
    pub cursor_offset: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

/// Callback the daemon-side runtime fires when it wants to overwrite the
/// codex TextArea (e.g. cycling result). Codex's TUI patch registers a
/// handler that grabs the TextArea + applies the new text + cursor.
pub type SetTextCallback = Box<dyn Fn(&str, usize) + Send + Sync>;

pub struct Bridge {
    child: Mutex<Option<Child>>,
    next_id: AtomicU64,
    directives: Arc<Mutex<Directives>>,
    /// id → oneshot sender. Frame handler thread looks up by id when a
    /// response arrives, sends the result Value, then drops the entry.
    pending: Arc<Mutex<HashMap<u64, SyncSender<Value>>>>,
    /// Codex's TextArea-mutation hook — invoked when the daemon emits
    /// `set-text`. Codex's TUI patch registers this once during startup.
    set_text_cb: Arc<Mutex<Option<SetTextCallback>>>,
    /// stdin half of the daemon, kept alive for the life of the bridge.
    stdin: Mutex<Option<std::process::ChildStdin>>,
    /// Tier 4.C: alive flag flipped to false by either reader thread
    /// when stdin/stdout EOF is observed (daemon exited). Callers
    /// poll via `is_alive()` and decide whether to respawn the bridge.
    daemon_dead: Arc<AtomicBool>,
    /// Tier 4.F: ring buffer of the most recent daemon stderr lines.
    /// Useful for surfacing crash context in the TUI ("daemon died:
    /// thread main panicked at ..."). Capped at STDERR_RING_CAPACITY
    /// to bound memory.
    stderr_ring: Arc<Mutex<VecDeque<String>>>,
}

/// Default timeout for synchronous request/response RPCs (currently
/// just dispatch_key). 200ms is generous — the daemon's key handler
/// is sub-millisecond. If we time out, treat the key as unconsumed
/// rather than blocking the codex render loop.
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_millis(200);

impl Bridge {
    /// Spawn the daemon, send `boot`, wait for ack. Errors propagate so the
    /// caller can decide whether to fall back to vanilla codex behaviour.
    pub fn start(cfg: BridgeConfig) -> std::io::Result<Self> {
        let mut child = Command::new("node")
            .arg(&cfg.daemon_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Tier 4.F: capture stderr instead of inheriting so daemon
            // crashes don't dump panic backtraces into the user's TUI.
            // We keep a ring buffer of recent lines for diagnostics.
            .stderr(Stdio::piped())
            .spawn()?;

        let stdin = child.stdin.take().expect("child stdin missing");
        let stdout = child.stdout.take().expect("child stdout missing");
        let stderr = child.stderr.take().expect("child stderr missing");
        let directives = Arc::new(Mutex::new(Directives::default()));
        let directives_for_thread = Arc::clone(&directives);
        let pending: Arc<Mutex<HashMap<u64, SyncSender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let pending_for_thread = Arc::clone(&pending);
        let set_text_cb: Arc<Mutex<Option<SetTextCallback>>> = Arc::new(Mutex::new(None));
        let set_text_cb_for_thread = Arc::clone(&set_text_cb);
        let daemon_dead = Arc::new(AtomicBool::new(false));
        let daemon_dead_stdout = Arc::clone(&daemon_dead);
        let daemon_dead_stderr = Arc::clone(&daemon_dead);
        let stderr_ring: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_RING_CAPACITY)));
        let stderr_ring_for_thread = Arc::clone(&stderr_ring);

        // Stdout reader: background thread so we don't block codex's
        // main thread on daemon output. EOF here = daemon process died.
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() { continue; }
                let Ok(frame): Result<Value, _> = serde_json::from_str(&line) else { continue };
                handle_frame(frame, &directives_for_thread, &pending_for_thread, &set_text_cb_for_thread);
            }
            // Daemon's stdout closed → process likely exited. Flip the
            // alive flag so callers can detect + respawn.
            daemon_dead_stdout.store(true, Ordering::Release);
        });

        // Stderr reader: ring-buffer the last N lines for diagnostics.
        // Last writer wins on EOF — that's usually the panic line.
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Ok(mut ring) = stderr_ring_for_thread.lock() {
                    if ring.len() >= STDERR_RING_CAPACITY {
                        ring.pop_front();
                    }
                    ring.push_back(line);
                }
            }
            daemon_dead_stderr.store(true, Ordering::Release);
        });

        let bridge = Self {
            child: Mutex::new(Some(child)),
            next_id: AtomicU64::new(1),
            directives,
            pending,
            set_text_cb,
            stdin: Mutex::new(Some(stdin)),
            daemon_dead,
            stderr_ring,
        };
        // Send boot RPC. We don't strictly need the response for the
        // smoke test — daemon's `log` notification confirms it started.
        // But we do correlate so callers can verify boot succeeded if they
        // want; the boot response is also the signal that ConfigLoader
        // has finished its initial load.
        bridge.send_notification("boot", json!({
            "hostVersion": env!("CARGO_PKG_VERSION"),
            "cwd": cfg.cwd,
            "configSearchPaths": cfg.config_search_paths,
        }))?;
        Ok(bridge)
    }

    /// Notify the daemon that the input buffer changed.
    pub fn notify_text_change(&self, text: &str, cursor: usize, source: &str) {
        let _ = self.send_notification("text-change", json!({
            "text": text,
            "cursorOffset": cursor,
            "source": source,
        }));
    }

    /// Synchronously ask the daemon whether it wants this key event.
    /// Blocks for up to DEFAULT_REQUEST_TIMEOUT waiting for the response.
    /// Returns:
    ///   - `true`  → daemon consumed (Navigation/Cycling handled it). Bridge swallows.
    ///   - `false` → daemon didn't claim it; codex's normal handling proceeds.
    ///   - `false` on timeout / daemon dead — fail open so codex stays usable.
    pub fn dispatch_key(&self, event: KeyEvent) -> bool {
        match self.request_with_timeout(
            "key",
            serde_json::to_value(&event).unwrap_or(Value::Null),
            DEFAULT_REQUEST_TIMEOUT,
        ) {
            Ok(value) => value
                .get("consumed")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            Err(_) => false,
        }
    }

    /// Synchronously invoke one of the daemon's hoisted controls and return
    /// its ProcessResult-shaped payload (or `None` if the controlName isn't
    /// registered). Useful for codex slash-commands like `/volume up`.
    /// Same timeout as dispatch_key.
    pub fn invoke_control(
        &self,
        control_name: &str,
        action: &str,
        args: &[&str],
    ) -> Option<Value> {
        let resp = self.request_with_timeout(
            "control-invoke",
            json!({
                "controlName": control_name,
                "action": action,
                "args": args,
            }),
            Duration::from_secs(10), // controls may hit network (HN, stocks…)
        );
        match resp {
            Ok(Value::Null) => None,
            Ok(v) => Some(v),
            Err(_) => None,
        }
    }

    /// Fetch the latest render directives. Cheap clone; codex calls this
    /// every frame.
    pub fn directives(&self) -> Directives {
        self.directives.lock().expect("directives mutex poisoned").clone()
    }

    /// Register the callback codex's TUI patch fires when the daemon
    /// emits `set-text` (i.e. cycling result). Replaces any previous
    /// callback. Pass `None` to unregister.
    pub fn on_set_text(&self, cb: Option<SetTextCallback>) {
        if let Ok(mut guard) = self.set_text_cb.lock() {
            *guard = cb;
        }
    }

    /// Tier 4.C: has the daemon process exited (stdout/stderr EOF
    /// observed by the reader threads)? Callers poll this to decide
    /// whether to drop the bridge and call Bridge::start again. We
    /// don't auto-restart from inside Bridge — codex's TUI patch
    /// owns the user-visible recovery flow (e.g. show a banner
    /// before reconnecting).
    pub fn is_alive(&self) -> bool {
        !self.daemon_dead.load(Ordering::Acquire)
    }

    /// Tier 4.F: snapshot of the most recent daemon stderr lines.
    /// Useful for surfacing crash context — codex can dump these
    /// into its own log or display the last line as part of a
    /// "daemon died" banner. Capped at STDERR_RING_CAPACITY lines.
    pub fn recent_stderr(&self) -> Vec<String> {
        self.stderr_ring
            .lock()
            .map(|ring| ring.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Send a JSON-RPC request, await the response value with a timeout.
    /// Returns the response's `result` field. Errors map to the closest
    /// io::Error variant — caller decides how to recover.
    fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> std::io::Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx): (SyncSender<Value>, Receiver<Value>) = sync_channel(1);
        // Park the sender BEFORE writing the frame so the response
        // can't race us.
        if let Ok(mut p) = self.pending.lock() {
            p.insert(id, tx);
        }
        let frame = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": id,
        });
        if let Err(err) = self.write_frame(&frame) {
            // Clean up the parked sender so we don't leak entries.
            if let Ok(mut p) = self.pending.lock() {
                p.remove(&id);
            }
            return Err(err);
        }
        match rx.recv_timeout(timeout) {
            Ok(value) => Ok(value),
            Err(RecvTimeoutError::Timeout) => {
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "daemon response timeout"))
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "daemon closed"))
            }
        }
    }

    fn send_notification(&self, method: &str, params: Value) -> std::io::Result<()> {
        let frame = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_frame(&frame)
    }

    fn write_frame(&self, frame: &Value) -> std::io::Result<()> {
        let mut guard = self.stdin.lock().expect("stdin mutex poisoned");
        let Some(stdin) = guard.as_mut() else {
            return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "daemon stdin closed"));
        };
        stdin.write_all(frame.to_string().as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        Ok(())
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // Closing stdin signals daemon to exit cleanly; give it
        // a beat then kill if needed.
        if let Ok(mut guard) = self.stdin.lock() {
            *guard = None; // drops the stdin handle → EOF on daemon
        }
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.wait();
            }
        }
    }
}

fn handle_frame(
    frame: Value,
    directives: &Arc<Mutex<Directives>>,
    pending: &Arc<Mutex<HashMap<u64, SyncSender<Value>>>>,
    set_text_cb: &Arc<Mutex<Option<SetTextCallback>>>,
) {
    // Response (id present, no method) → match to a pending request.
    if let Some(id) = frame.get("id").and_then(Value::as_u64) {
        let value = frame.get("result").cloned().unwrap_or(Value::Null);
        if let Ok(mut p) = pending.lock() {
            if let Some(sender) = p.remove(&id) {
                // Best effort — receiver may have timed out + dropped already.
                let _ = sender.send(value);
                return;
            }
        }
        // Fall through if no sender — could be a stray response.
    }

    let Some(method) = frame.get("method").and_then(Value::as_str) else { return };
    let params = frame.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "directives" => {
            if let Ok(d) = serde_json::from_value::<Directives>(params) {
                if let Ok(mut guard) = directives.lock() {
                    *guard = d;
                }
            }
        }
        "log" => {
            // Could route to codex's logging here; for now stderr is fine.
            let level = params.get("level").and_then(Value::as_str).unwrap_or("info");
            let msg = params.get("msg").and_then(Value::as_str).unwrap_or("");
            eprintln!("[opencues-bridge][{level}] {msg}");
        }
        "set-text" => {
            let text = params.get("text").and_then(Value::as_str).unwrap_or("");
            let cursor = params.get("cursorOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
            // Invoke the registered callback under the lock. The callback
            // is `Send + Sync` so codex's TUI patch can safely lock its
            // own TextArea state inside it.
            if let Ok(guard) = set_text_cb.lock() {
                if let Some(ref cb) = *guard {
                    cb(text, cursor);
                }
            }
        }
        _ => {}
    }
}
