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
//!   bridge.notify_text_change(text, cursor, "user");
//!   if bridge.dispatch_key(key_event) { /* swallow */ }
//!   let dirs = bridge.directives();   // current highlight ranges
//!
//! See integrations/codex/docs/protocol.md for the wire format.
//! See integrations/codex/docs/architecture.md for design rationale.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

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

pub struct Bridge {
    child: Mutex<Option<Child>>,
    next_id: AtomicU64,
    directives: Arc<Mutex<Directives>>,
}

impl Bridge {
    /// Spawn the daemon, send `boot`, wait for ack. Errors propagate so the
    /// caller can decide whether to fall back to vanilla codex behaviour.
    pub fn start(cfg: BridgeConfig) -> std::io::Result<Self> {
        let mut child = Command::new("node")
            .arg(&cfg.daemon_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        // Move stdout reader into a background thread so we don't block
        // codex's main thread on daemon output.
        let stdout = child.stdout.take().expect("child stdout missing");
        let directives = Arc::new(Mutex::new(Directives::default()));
        let directives_for_thread = Arc::clone(&directives);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() { continue; }
                let Ok(frame): Result<Value, _> = serde_json::from_str(&line) else { continue };
                handle_frame(frame, &directives_for_thread);
            }
        });

        // Send boot RPC. We don't strictly need the response for the
        // smoke test — daemon's `log` notification confirms it started.
        let bridge = Self {
            child: Mutex::new(Some(child)),
            next_id: AtomicU64::new(1),
            directives,
        };
        bridge.send_request("boot", json!({
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

    /// Ask the daemon whether it consumed a key event. Currently
    /// returns `false` always (TODO: synchronous wait for response is
    /// noisy without tokio; this returns the LAST `consumed` value seen
    /// from the daemon's response stream, which is wrong for keystroke
    /// pacing — needs proper request/response correlation by id).
    pub fn dispatch_key(&self, _key: &str) -> bool {
        // TODO: send `key` request, wait for response keyed by id.
        // For now: best-effort fire-and-forget; consider this a no-op
        // that lets every key fall through to codex's normal handling.
        false
    }

    /// Fetch the latest render directives. Cheap clone; codex calls this
    /// every frame.
    pub fn directives(&self) -> Directives {
        self.directives.lock().expect("directives mutex poisoned").clone()
    }

    fn send_request(&self, method: &str, params: Value) -> std::io::Result<()> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let frame = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": id,
        });
        self.write_frame(&frame)
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
        let mut guard = self.child.lock().expect("child mutex poisoned");
        let Some(child) = guard.as_mut() else {
            return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "daemon not running"));
        };
        let stdin = child.stdin.as_mut().expect("child stdin missing");
        stdin.write_all(frame.to_string().as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        Ok(())
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                // Closing stdin signals daemon to exit cleanly; give it
                // a beat then kill if needed.
                drop(child.stdin.take());
                let _ = child.wait();
            }
        }
    }
}

fn handle_frame(frame: Value, directives: &Arc<Mutex<Directives>>) {
    let Some(method) = frame.get("method").and_then(Value::as_str) else { return };
    let Some(params) = frame.get("params") else { return };
    match method {
        "directives" => {
            if let Ok(d) = serde_json::from_value::<Directives>(params.clone()) {
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
            // TODO: route back to codex's TextArea — needs callback registration
            // from the TUI patch site (or a shared channel the patch reads).
        }
        _ => {}
    }
}
