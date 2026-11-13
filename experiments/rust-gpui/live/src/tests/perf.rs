//! A CPU probe, ignored by default: the built app (`GPUI_PERF_BIN`, the `milagre-gpui-live` binary) on the fake daemon,
//! with a long Chat open, idle and then during a running turn whose calls start, run and end. It runs the app as a
//! child process with its own `HOME` (so nothing of the Preview's is read or written), never activated, and prints the
//! CPU each phase used (`ps -o time`), then ends the child it started.
//!
//!   GPUI_PERF_BIN=target/release/milagre-gpui-live cargo test --release perf_probe -- --ignored --nocapture

use std::process::{Child, Command};
use std::time::{Duration, Instant};

use serde_json::json;

use super::fake_daemon::{FakeDaemon, World, data_folder};

const PATH: &str = "/fake-node/perf";

fn cpu_seconds(child: &Child) -> f64 {
    let out = Command::new("ps").args(["-o", "time=", "-p", &child.id().to_string()]).output().expect("ps");
    let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    // `M:SS.cc` or `H:MM:SS`.
    text.split(':').fold(0.0, |acc, part| acc * 60.0 + part.trim().parse::<f64>().unwrap_or(0.0))
}

fn phase(child: &Child, seconds: u64, mut during: impl FnMut(u64)) -> f64 {
    let (start, at) = (cpu_seconds(child), Instant::now());
    for tick in 0..seconds * 4 {
        during(tick);
        std::thread::sleep(Duration::from_millis(250));
    }
    (cpu_seconds(child) - start) / at.elapsed().as_secs_f64() * 100.0
}

fn long_world() -> World {
    let mut messages = Vec::new();
    for n in 0..150 {
        messages.push(("user", format!("Question {n}: what does the parser do with nested lists?")));
        messages.push((
            "assistant",
            format!("Answer {n}. The parser walks the list, **keeps** the depth and `emits` a block per item.\n\n- one\n- two\n- three"),
        ));
    }
    let chats = vec![(1, "Long thread", messages.iter().map(|(r, b)| (*r, b.as_str())).collect::<Vec<_>>())];
    let mut world = World::with(vec![(PATH, "perf", true, chats)]);
    let list = world.projects.get_mut(PATH).unwrap().messages.get_mut(&1).unwrap();
    for (n, message) in list.iter_mut().enumerate().filter(|(n, _)| n % 2 == 1) {
        message["steps"] = json!([
            {"id":format!("t{n}"),"kind":"thinking","title":"Thought","status":"done","offset":0,"durationMs":1200},
            {"id":format!("r{n}"),"kind":"read","title":"Read `parser.rs`","status":"done","offset":0,"durationMs":40},
            {"id":format!("s{n}"),"kind":"shell","title":"Ran `cargo test`","status":"done","offset":0,"durationMs":5400},
        ]);
    }
    world
}

#[test]
#[ignore = "a CPU probe of the built app: GPUI_PERF_BIN=... --ignored --nocapture"]
fn perf_probe() {
    let bin = std::env::var("GPUI_PERF_BIN").expect("GPUI_PERF_BIN names the built milagre-gpui-live");
    let data = data_folder("perf");
    let home = data.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let fake = FakeDaemon::start(&data, long_world());
    let mut child = Command::new(&bin)
        .args(["--profile", data.to_str().unwrap(), "--no-installed-app"])
        .env("HOME", &home)
        .env("MILAGRE_GPUI_NO_ACTIVATE", "1")
        .stderr(std::fs::File::create(data.join("app.log")).unwrap())
        .spawn()
        .expect("the app");
    std::thread::sleep(Duration::from_secs(12));
    let idle = phase(&child, 10, |_| {});
    let key = format!("{PATH}#1");
    {
        let mut world = fake.world();
        world.runs.insert(key.clone(), json!({"text":"","model":"gpt-5.5","startedAt":crate::transcript::now_ms(),"steps":[],"approvals":[],"questions":[],"answered":{}}));
        world.agent(&key, json!({"type":"turn-started","turnId":"perf-1"}));
    }
    let mut n = 0;
    let running = phase(&child, 10, |tick| {
        let mut world = fake.world();
        // A call starts every second and ends a second later; text streams between.
        if tick % 4 == 0 {
            n += 1;
            world
                .agent(&key, json!({"type":"step-started","step":{"id":format!("c{n}"),"kind":"shell","title":format!("Ran `step {n}`")}}));
            if n > 1 {
                world.agent(&key, json!({"type":"step-completed","id":format!("c{}", n - 1),"status":"done","durationMs":1000}));
            }
        } else {
            world.agent(&key, json!({"type":"text-delta","text":"More words stream in. "}));
        }
    });
    // Running, nothing new arriving (a long tool call): only the running marks move.
    let waiting = phase(&child, 10, |_| {});
    {
        let mut world = fake.world();
        world.runs.remove(&key);
        world.agent(&key, json!({"type":"turn-completed"}));
    }
    std::thread::sleep(Duration::from_secs(3));
    let after = phase(&child, 10, |_| {});
    println!("PERF idle {idle:.1}% | streaming {running:.1}% | running, quiet {waiting:.1}% | idle after {after:.1}%");
    let _ = child.kill();
    let _ = child.wait();
    let log = std::fs::read_to_string(data.join("app.log")).unwrap_or_default();
    println!("PERF log tail:\n{}", log.lines().rev().take(25).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"));
    fake.stop();
    let _ = std::fs::remove_dir_all(&data);
}
