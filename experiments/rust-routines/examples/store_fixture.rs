//! Explicit, private, bounded state fixture. No filesystem writer or dispatcher.
pub use milagre_routines::{
    every_to_cron, next_run, Error, MAX_AFTER_MS, MAX_INPUT_BYTES, MAX_ZONE_BYTES, MIN_AFTER_MS,
};
#[path = "../src/store/mod.rs"]
mod store;
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut output = std::io::stdout().lock();
    let mut model: Option<store::Model> = None;
    let mut now = 0;
    for _ in 0..4096 {
        let mut line = String::new();
        let n = Read::by_ref(&mut input)
            .take(store::limits::BYTES as u64 + 1)
            .read_line(&mut line)?;
        if n == 0 {
            return Ok(());
        }
        let request = store::limits::decode(&line)?;
        let op = request["op"].as_str().ok_or("Expected fixture op")?;
        if let Some(value) = request.get("now") {
            match store::time(value) {
                Ok(at) => now = at,
                Err(error) => {
                    let observation = match model.as_mut() {
                        Some(model) => {
                            model.effects.clear();
                            model.observe(Err(error))
                        }
                        None => json!({"result":store::outcome(Err(error))}),
                    };
                    writeln!(output, "{}", store::jsjson::to_string(&observation))?;
                    continue;
                }
            }
        }
        let observation = if op == "open" {
            if model.is_some() {
                return Err("Fixture opens once".into());
            }
            let seed = match &request["seed"] {
                Value::Null => None,
                Value::String(s) => Some(String::from_utf16(&store::jsjson::to_utf16(s))?),
                _ => return Err("Expected seed string or null".into()),
            };
            match store::Model::open(seed, now) {
                Ok(opened) => {
                    let observation = opened.observe(Ok(Value::Null));
                    model = Some(opened);
                    observation
                }
                Err(error) => json!({"result":store::outcome(Err(error))}),
            }
        } else {
            let args = request
                .get("args")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let fault = match request["fail"].as_str() {
                None => store::Fault::None,
                Some("write") => store::Fault::Write,
                Some("rename") => store::Fault::Rename,
                _ => return Err("Unknown fixture failure".into()),
            };
            let model = model.as_mut().ok_or("Fixture has no admitted model")?;
            let result = model.execute(op, args, now, fault);
            model.observe(result)
        };
        writeln!(output, "{}", store::jsjson::to_string(&observation))?;
    }
    let mut excess = [0];
    if input.read(&mut excess)? != 0 {
        return Err("Fixture command bound".into());
    }
    Ok(())
}
