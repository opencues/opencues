//! Smoke test binary — verifies the bridge can spawn the daemon and
//! exchange a boot RPC.
//!
//! Usage: `cargo run --bin opencues-bridge-smoke -- /path/to/daemon.js`

use opencues_bridge::{Bridge, BridgeConfig};
use std::env;
use std::path::PathBuf;
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
    }).expect("bridge start failed");

    eprintln!("[smoke] sending text-change notification...");
    bridge.notify_text_change("hello from rust", 5, "user");

    eprintln!("[smoke] dispatching key event (always returns false in scaffold)...");
    let consumed = bridge.dispatch_key("ArrowUp");
    eprintln!("[smoke] consumed = {consumed}");

    // Give the daemon a moment to log + emit anything queued.
    thread::sleep(Duration::from_millis(500));

    let dirs = bridge.directives();
    eprintln!("[smoke] directives: {} dim ranges, active = {:?}, tip = {:?}",
        dirs.dim.len(), dirs.active, dirs.tip);

    eprintln!("[smoke] dropping bridge → daemon should exit cleanly");
    drop(bridge);
}
