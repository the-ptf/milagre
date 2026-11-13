//! Test-only bounded JSON driver. No timer or host/process integration.
use milagre_routines::{every_to_cron, next_run, parse_cron};
use serde_json::{json, Value};
use std::io::{Read, Write};
fn call(value: &Value) -> Value {
    let text = |name: &str| {
        value[name]
            .as_str()
            .ok_or("Expected typed string input".to_string())
    };
    let result: Result<Value, String> = (|| match text("op")? {
        "parse" => {
            let c = parse_cron(text("expr")?).map_err(|e| e.to_string())?;
            Ok(
                json!({"minute":c.minute(),"hour":c.hour(),"dayOfMonth":c.day_of_month(),"month":c.month(),"dayOfWeek":c.day_of_week()}),
            )
        }
        "every" => every_to_cron(text("every")?)
            .map(|v| json!(v))
            .map_err(|e| e.to_string()),
        "next" => next_run(
            text("expr")?,
            text("zone")?,
            value["after"]
                .as_i64()
                .ok_or("Expected integer epoch milliseconds")?,
        )
        .map(|v| json!(v))
        .map_err(|e| e.to_string()),
        _ => Err("Unknown fixture operation".into()),
    })();
    match result {
        Ok(value) => json!({"ok":value}),
        Err(error) => json!({"error":error}),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    std::io::stdin()
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut input)?;
    if input.len() > 8 * 1024 * 1024 {
        return Err("Fixture byte bound".into());
    }
    let values: Vec<Value> = serde_json::from_slice(&input)?;
    if values.len() > 20000 {
        return Err("Fixture request bound".into());
    }
    let output = values.iter().map(call).collect::<Vec<_>>();
    serde_json::to_writer(std::io::stdout().lock(), &output)?;
    std::io::stdout().write_all(b"\n")?;
    Ok(())
}
