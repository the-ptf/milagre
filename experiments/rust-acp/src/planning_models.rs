use super::{id, ModelOption, ModelRequest, Refusal, Vendor};

const FALLBACK: &[(&str, &str)] = &[
    ("gemini-4-argon-medium", "Gemini 4 Argon (Medium)"),
    ("gemini-4-argon-high", "Gemini 4 Argon (High)"),
    ("gemini-4-argon-low", "Gemini 4 Argon (Low)"),
    ("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"),
    ("gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"),
    ("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"),
];
fn split(name: &str) -> (&str, Option<String>) {
    let name = name.trim();
    if let Some((family, level)) = name.strip_suffix(')').and_then(|s| s.rsplit_once('(')) {
        let level = level.trim();
        if !family.trim_end().is_empty()
            && level.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && level.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            && !level.eq_ignore_ascii_case("thinking")
        {
            return (family.trim_end(), Some(level.to_ascii_lowercase()));
        }
    }
    (name, None)
}
fn slug(s: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'.' {
            if gap && !out.is_empty() {
                out.push('-');
            }
            gap = false;
            out.push((b as char).to_ascii_lowercase());
        } else {
            gap = true;
        }
    }
    out
}
struct Family {
    id: String,
    variants: Vec<(Option<String>, String)>,
}
fn resolve_anti(options: &[ModelOption], model: &str, effort: Option<&str>) -> Option<String> {
    let mut families: Vec<Family> = vec![];
    for option in options {
        let (name, level) = split(if option.name.trim().is_empty() { &option.value } else { &option.name });
        let mut family_id = slug(name);
        if family_id.is_empty() {
            family_id = option.value.clone();
        }
        if ["claude", "gpt"].iter().any(|s| family_id == *s || family_id.starts_with(&format!("{s}-"))) {
            family_id = format!("antigravity:{family_id}");
        }
        let at = if let Some(at) = families.iter().position(|f| f.id == family_id) {
            at
        } else {
            families.push(Family { id: family_id, variants: vec![] });
            families.len() - 1
        };
        if !families[at].variants.iter().any(|(l, _)| *l == level) {
            families[at].variants.push((level, option.value.clone()));
        }
    }
    if families.iter().any(|f| f.variants.iter().any(|(_, v)| v == model)) {
        return Some(model.to_string());
    }
    let family = families.iter().find(|f| f.id == model || f.id == format!("antigravity:{model}"))?;
    let mut levels: Vec<_> = family.variants.iter().filter_map(|(l, v)| l.as_ref().map(|l| (l, v))).collect();
    if levels.is_empty() {
        return family.variants.first().map(|(_, v)| v.clone());
    }
    if let Some((_, v)) = levels.iter().find(|(l, _)| Some(l.as_str()) == effort) {
        return Some((*v).clone());
    }
    if let Some((_, v)) = levels.iter().find(|(l, _)| l.as_str() == "high") {
        return Some((*v).clone());
    }
    levels.sort_by_key(|(l, _)| match l.as_str() {
        "low" => 0,
        "medium" => 1,
        "high" => 2,
        _ => 3,
    });
    levels.last().map(|(_, v)| (*v).clone())
}
pub(super) fn resolve(vendor: Vendor, r: &ModelRequest) -> Result<(String, Option<String>), Refusal> {
    if !id(&r.model)
        || r.effort.as_ref().is_some_and(|e| !id(e))
        || r.offered.iter().any(|o| {
            !id(&o.value)
                || !o.name.is_ascii()
                || o.name.chars().any(char::is_control)
                || o.efforts.iter().any(|e| !id(e))
                || matches!(split(&o.name).1.as_deref(), Some("__proto__" | "constructor"))
        })
    {
        return Err(Refusal::Model);
    }
    if vendor == Vendor::Kiro {
        let model = r.model.strip_prefix("kiro:").unwrap_or(&r.model);
        if model.is_empty() {
            return Err(Refusal::Model);
        }
        let effort =
            r.effort.as_ref().filter(|e| r.offered.iter().find(|m| m.value == model).is_some_and(|m| m.efforts.contains(e))).cloned();
        return Ok((model.into(), effort));
    }
    let fallback: Vec<_> = FALLBACK.iter().map(|(v, n)| ModelOption { value: (*v).into(), name: (*n).into(), efforts: vec![] }).collect();
    let options = if r.offered.is_empty() { &fallback } else { &r.offered };
    let model = resolve_anti(options, &r.model, r.effort.as_deref())
        .or_else(|| resolve_anti(&fallback, &r.model, r.effort.as_deref()))
        .unwrap_or_else(|| r.model.clone());
    Ok((model, None))
}
