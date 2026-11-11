//! Test fixture only. Creates its own new temporary profile; accepts no path argument.
use milagre_owner_wire::{
    ClientContext, Config, Handler, IsolatedProfile, RpcError, RpcResult, Server,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

#[derive(Default)]
struct State {
    increments: u64,
    gates: HashMap<String, bool>,
    receipts: HashMap<String, u64>,
}
#[derive(Default)]
struct Fixtures {
    state: Mutex<State>,
    changed: Condvar,
}
impl Handler for Fixtures {
    fn methods(&self) -> Vec<String> {
        [
            "fixture:echo",
            "fixture:unicode-output",
            "fixture:unicode-event",
            "fixture:large",
            "fixture:failure",
            "fixture:large-error",
            "fixture:view",
            "fixture:block",
            "fixture:release",
            "fixture:increment",
            "fixture:oversized-state",
            "fixture:disconnect",
            "fixture:receipt",
            "fixture:accepted-without-ack",
            "project:open",
            "project:switch",
            "project:current",
            "project:snapshot",
            "link:open",
            "link:snapshot",
        ]
        .map(str::to_string)
        .to_vec()
    }
    fn encode_result(&self, value: &Value) -> Result<String, RpcError> {
        // Stand-in for an owner's UTF-16-preserving domain serializer; JavaScript receives a lone high surrogate.
        Ok(value.to_string().replace("__WIRE_UTF16__", "\\ud83d"))
    }
    fn invoke(&self, method: &str, args: &[Value], context: &ClientContext) -> RpcResult {
        let first = args.first().cloned().unwrap_or(Value::Null);
        match method {
            "fixture:echo" => Ok(first),
            "fixture:unicode-output" => {
                Ok(json!({"text":"__WIRE_UTF16__".repeat(if first == true { 1000 } else { 1 })}))
            }
            "fixture:unicode-event" => {
                context
                    .events
                    .emit("fixture:unicode", json!({"text":"__WIRE_UTF16__"}))?;
                Ok(Value::Null)
            }
            "fixture:large" => {
                let count = first
                    .as_u64()
                    .filter(|count| *count <= 10_000)
                    .ok_or_else(|| RpcError::new("INVALID_REQUEST", "Invalid fixture size"))?;
                Ok(json!({"text":"🦀\"\\\n".repeat(count as usize),"count":count}))
            }
            "fixture:failure" => Err(RpcError {
                code: "FIXTURE_DENIED".into(),
                message: "Deliberate fixture error".into(),
                details: Some(json!({"fixture":true})),
            }),
            "fixture:large-error" => Err(RpcError::new("FIXTURE_LARGE_ERROR", "x".repeat(5000))),
            "fixture:view" => {
                Ok(json!({"clientId":context.client_id(),"view":context.view().value()}))
            }
            "fixture:increment" => context.events.transaction(|publication| {
                let mut state = self.state.lock().unwrap();
                state.increments += 1;
                let seq =
                    publication.emit("fixture:incremented", json!({"value":state.increments}))?;
                Ok(json!({"value":state.increments,"seq":seq}))
            }),
            "fixture:oversized-state" => {
                context.events.emit(
                    "project:state",
                    json!({"path":"/fixture","state":{"text":"x".repeat(3000)}}),
                )?;
                Ok(Value::Null)
            }
            "fixture:disconnect" => {
                context.disconnect();
                Ok(Value::Null)
            }
            "fixture:accepted-without-ack" => {
                let key = first.as_str().unwrap_or("default").to_string();
                *self.state.lock().unwrap().receipts.entry(key).or_default() += 1;
                context.disconnect();
                Ok(Value::Null)
            }
            "fixture:receipt" => Ok(json!(self
                .state
                .lock()
                .unwrap()
                .receipts
                .get(first.as_str().unwrap_or("default"))
                .copied()
                .unwrap_or(0))),
            "fixture:block" => {
                let key = first.as_str().unwrap_or("gate").to_string();
                context.events.emit("fixture:blocked", json!({"key":key}))?;
                let expires = Instant::now() + Duration::from_secs(5);
                let mut state = self.state.lock().unwrap();
                while !state.gates.get(&key).copied().unwrap_or(false) {
                    let left = expires.saturating_duration_since(Instant::now());
                    if left.is_zero() || !context.is_connected() {
                        return Err(RpcError::new(
                            "FIXTURE_CANCELLED",
                            "Fixture gate was not released",
                        ));
                    }
                    state = self
                        .changed
                        .wait_timeout(state, left.min(Duration::from_millis(10)))
                        .unwrap()
                        .0;
                }
                Ok(json!({"released":key}))
            }
            "fixture:release" => {
                self.state
                    .lock()
                    .unwrap()
                    .gates
                    .insert(first.as_str().unwrap_or("gate").to_string(), true);
                self.changed.notify_all();
                Ok(Value::Null)
            }
            "project:snapshot" if first == "/fixture" => Ok(
                json!({"path":first,"name":"Isolated large fixture","state":{"text":"x".repeat(3000)}}),
            ),
            "project:open" | "project:switch" | "project:snapshot" => Ok(
                json!({"path":first,"name":"Isolated fixture Project","state":{"sessions":{},"messages":[]}}),
            ),
            "project:current" => Ok(
                json!({"path":"/fixture-default","name":"Isolated fixture Project","state":{"sessions":{},"messages":[]}}),
            ),
            "link:open" | "link:snapshot" => Ok(
                json!({"link":{"id":first,"name":"Isolated fixture Link"},"state":{"sessions":{},"messages":[]}}),
            ),
            _ => Err(RpcError::new("COMMAND_FAILED", "Unknown fixture command")),
        }
    }
    fn snapshot(&self, _: &ClientContext) -> RpcResult {
        Ok(
            json!({"projects":[],"links":[],"runs":{"runs":{},"seq":0},"ports":{},"unicode":"__WIRE_UTF16__","fixtureCount":self.state.lock().unwrap().increments}),
        )
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg != "--auth") {
        return Err(
            "Only --auth is accepted. The fixture never accepts a production profile path.".into(),
        );
    }
    let server = Arc::new(Server::bind(
        IsolatedProfile::create()?,
        Arc::new(Fixtures::default()),
        Config {
            max_frame_bytes: 4096,
            require_authentication: args.iter().any(|arg| arg == "--auth"),
            authentication_timeout: Duration::from_millis(500),
            page_ttl: Duration::from_secs(3),
            ..Config::default()
        },
    )?);
    println!(
        "{}",
        json!({"profile":server.profile_path(),"socket":server.socket_path(),"pid":std::process::id(),"fixture":true})
    );
    io::stdout().flush()?;
    let stopping = Arc::downgrade(&server);
    thread::spawn(move || {
        // EOF is a teardown fallback if the Node test runner exits early.
        let mut line = String::new();
        let _ = io::stdin().lock().read_line(&mut line);
        if let Some(stopping) = stopping.upgrade() {
            let _ = stopping.shutdown();
        }
    });
    while !server.is_stopped() {
        thread::sleep(Duration::from_millis(10));
    }
    server.shutdown()?;
    Ok(())
}
