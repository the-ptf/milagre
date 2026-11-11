use milagre_command_policy::ShellClassifier;
use milagre_providers::codex::guard::CommandClassifier;
fn main() {
    let input = std::fs::read_to_string(std::env::args().nth(1).expect("fixture path")).unwrap();
    let cases: Vec<serde_json::Value> = serde_json::from_str(&input).unwrap();
    let output: Vec<_> = cases
        .iter()
        .map(|case| {
            let command = case["command"].as_str().unwrap();
            match ShellClassifier.actions(command) {
                Ok(actions) => serde_json::json!({"command":command,"actions":actions}),
                Err(error) => serde_json::json!({"command":command,"error":error}),
            }
        })
        .collect();
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}
