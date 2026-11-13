use super::*;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
/// Strip only the generated head's known font block; legacy/custom HTML remains
/// self-contained. The hash identifies font CSS, never a filesystem resource.
pub(crate) fn transfer(mut current: Value, have: &Value) -> Value {
    if current["format"] != "design" || !have.is_array() {
        return current;
    }
    static HEAD: OnceLock<regex::Regex> = OnceLock::new();
    let pattern=HEAD.get_or_init(||regex::Regex::new(r#"^<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=[0-9]+, initial-scale=1"><style>[^<]*</style><style>((?:@font-face\{font-family:"[^"<>;{}]+";font-weight:[0-9]+(?: [0-9]+)?;font-style:normal;src:url\(data:font/ttf;base64,[A-Za-z0-9+/=]+\) format\("truetype"\)\})+)</style></head><body><main id="design-root">"#).unwrap());
    let Some(html) = current["html"].as_str() else {
        return current;
    };
    let Some(block) = pattern.captures(html) else {
        return current;
    };
    let css = block[1].to_owned();
    let key = hex::encode(Sha256::digest(css.as_bytes()));
    let stripped = html.replacen(&format!("<style>{css}</style>"), "", 1);
    current["html"] = json!(stripped);
    current["fontKey"] = json!(key);
    if !have.as_array().unwrap().iter().any(|known| known == &key) {
        current["fontCss"] = json!(css);
    }
    current
}
