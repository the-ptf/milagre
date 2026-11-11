//! Exact comparison with `fixtures/instructions-node.json`, recorded from the actual Node
//! `events.cjs`, `bundled-skills.cjs` and `SessionManager` over explicit synthetic bundles.
use milagre_rust_runtime::instructions::{
    bundled_agents, persona_agent, prompt_suggestions_enabled, session_workspace, Bundle,
    HostNetwork,
};
use serde_json::Value;

fn oracle() -> Value {
    serde_json::from_str(include_str!("../fixtures/instructions-node.json")).unwrap()
}

#[test]
fn instruction_texts_match_node_byte_for_byte() {
    let oracle = oracle();
    let texts = oracle["texts"].as_array().unwrap();
    let text = |index: &Value| texts[index.as_u64().unwrap() as usize].as_str().unwrap();
    let mut compared = 0;
    for bundle in oracle["bundles"].as_array().unwrap() {
        let b = Bundle::new(
            bundle["skillsDir"].as_str().unwrap(),
            bundle["tldrDefault"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(
            b.writing_instructions(),
            bundle["writing"].as_str().unwrap()
        );
        assert_eq!(
            b.subagent_context(false),
            bundle["subagentPlan"].as_str().unwrap()
        );
        assert_eq!(
            b.subagent_design_instructions(),
            bundle["subagentDesign"].as_str().unwrap()
        );
        for case in bundle["instructions"].as_array().unwrap() {
            let actual = b.milagre_instructions(
                case["tldrEnabled"].as_bool().unwrap(),
                case["workspace"].as_str(),
                case["sharedLink"].as_bool().unwrap(),
            );
            assert_eq!(actual, text(&case["text"]), "{case}");
            compared += 1;
        }
        for case in bundle["sessions"].as_array().unwrap() {
            let addresses: Vec<String> = case["host"]["addresses"]
                .as_array()
                .map(|a| a.iter().map(|v| v.as_str().unwrap().to_owned()).collect())
                .unwrap_or_default();
            let host = HostNetwork {
                name: case["host"]["name"].as_str().map(str::to_owned),
                addresses,
            };
            let host_text = host.instructions();
            assert_eq!(host_text, case["hostText"].as_str().unwrap());
            let composed = session_workspace(case["workspace"].as_str(), &host_text);
            assert_eq!(composed.as_deref(), case["composed"].as_str(), "{case}");
            assert_eq!(
                b.milagre_instructions(true, composed.as_deref(), false),
                text(&case["text"])
            );
            compared += 1;
        }
        let personas: Vec<(&str, &str)> = bundle["personas"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (p[0].as_str().unwrap(), text(&p[1])))
            .collect();
        let mut expected = bundle["agents"].clone();
        for agent in expected.as_object_mut().unwrap().values_mut() {
            agent["prompt"] = Value::from(text(&agent["prompt"]));
        }
        let agents = bundled_agents(text(&bundle["agentMd"]), &personas).unwrap();
        // Same keys in the same order, and the same values.
        assert_eq!(
            serde_json::to_string(&Value::Object(agents)).unwrap(),
            serde_json::to_string(&expected).unwrap()
        );
    }
    assert_eq!(compared, 81);
    for case in oracle["personaErrors"].as_array().unwrap() {
        let result = persona_agent(case["text"].as_str().unwrap(), "rules");
        assert_eq!(case["throws"].is_string(), result.is_err(), "{case}");
    }
}

/// `promptSuggestionsEnabled` cases recorded through the actual ClaudeSession (ordinary trace),
/// and the ordinary trace's own system prompts rebuilt from its explicit bundle and host.
#[test]
fn prompt_suggestions_and_ordinary_trace_prompts_match_node() {
    let trace: Value = serde_json::from_str(include_str!(
        "../../rust-claude/tests/fixtures/conformance/claude-ordinary.json"
    ))
    .unwrap();
    let cases = trace["promptSuggestions"].as_array().unwrap();
    assert_eq!(cases.len(), 40);
    for case in cases {
        let actual = prompt_suggestions_enabled(
            case["settings"].as_str().map(str::as_bytes),
            case["env"].as_str(),
        );
        assert_eq!(Value::Bool(actual), case["promptSuggestions"], "{case}");
    }
    let b = &trace["bundle"];
    let bundle = Bundle::new(
        b["skillsDir"].as_str().unwrap(),
        b["tldrDefault"].as_str().unwrap(),
    )
    .unwrap();
    let host = HostNetwork {
        name: trace["host"]["name"].as_str().map(str::to_owned),
        addresses: vec![trace["host"]["addresses"][0].as_str().unwrap().into()],
    };
    let workspace = session_workspace(None, &host.instructions());
    for (query, turn) in trace["queries"].as_array().unwrap().iter().zip([0, 2]) {
        let tldr = trace["turns"][turn]["tldrEnabled"].as_bool().unwrap();
        assert_eq!(
            bundle.milagre_instructions(tldr, workspace.as_deref(), false),
            query["options"]["systemPrompt"]["append"].as_str().unwrap()
        );
        assert_eq!(
            bundle.subagent_context(false),
            query["subagentStart"]["hookSpecificOutput"]["additionalContext"]
                .as_str()
                .unwrap()
        );
    }
}
