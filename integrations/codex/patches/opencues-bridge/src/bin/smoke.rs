//! Smoke test binary — verifies the bridge can:
//!   1. spawn the daemon + exchange a boot RPC
//!   2. send a text-change notification
//!   3. dispatch a key event with proper request/response correlation
//!      (returns the daemon's actual `consumed` value, not always-false)
//!   4. invoke a hoisted control via the control-invoke RPC
//!   5. register a set-text callback (basic registration check —
//!      no daemon-driven set-text in scaffold)
//!   6. exit cleanly on drop
//!
//! Usage: `cargo run --bin opencues-bridge-smoke -- /path/to/daemon.js`

use opencues_bridge::{Bridge, BridgeConfig, KeyEvent, Modifiers};
use std::env;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: {} <path-to-daemon.js>", args[0]);
        std::process::exit(2);
    }
    let daemon_path = PathBuf::from(&args[1]);
    if !daemon_path.exists() {
        eprintln!("error: daemon not found at {:?}", daemon_path);
        std::process::exit(1);
    }

    eprintln!("[smoke] spawning daemon: {:?}", daemon_path);
    let bridge = Bridge::start(BridgeConfig {
        daemon_path,
        cwd: env::current_dir().expect("cwd"),
        config_search_paths: vec![],
    })
    .expect("bridge start failed");

    // Give the daemon a moment to boot (ConfigLoader.load is awaited
    // by defaultBuildRuntime so any RPC sent immediately may be queued
    // until boot finishes — the daemon serializes RPCs FIFO).
    thread::sleep(Duration::from_millis(50));

    eprintln!("[smoke] sending text-change notification...");
    bridge.notify_text_change("hello from rust", 5, "user");

    eprintln!("[smoke] dispatching key event (now uses real request/response correlation)...");
    let consumed = bridge.dispatch_key(KeyEvent {
        key: "ArrowUp".into(),
        modifiers: Modifiers { ctrl: true, alt: true, ..Default::default() },
        text: "hello from rust".into(),
        cursor_offset: 5,
    });
    eprintln!("[smoke] consumed = {consumed}  (expected: false — no Cycling state for this text)");

    eprintln!("[smoke] invoking control-invoke (opencues get voice-mode)...");
    match bridge.invoke_control("opencues", "get", &["voice-mode"]) {
        Some(result) => {
            eprintln!("[smoke] control result: {result}");
        }
        None => {
            eprintln!("[smoke] control returned None (unknown / null result)");
        }
    }

    eprintln!("[smoke] registering set-text callback (verifies wiring without firing)...");
    let captured: Arc<Mutex<Option<(String, usize)>>> = Arc::new(Mutex::new(None));
    let captured_for_cb = Arc::clone(&captured);
    bridge.on_set_text(Some(Box::new(move |text, cursor| {
        if let Ok(mut g) = captured_for_cb.lock() {
            *g = Some((text.to_string(), cursor));
        }
    })));
    eprintln!("[smoke] callback registered (daemon doesn't currently emit set-text in scaffold;");
    eprintln!("        the wiring is verified via the unit tests on the daemon side instead).");

    let dirs = bridge.directives();
    eprintln!(
        "[smoke] directives: {} dim ranges, active = {:?}, tip = {:?}",
        dirs.dim.len(),
        dirs.active,
        dirs.tip
    );

    eprintln!("[smoke] dropping bridge → daemon should exit cleanly");
    drop(bridge);
}
