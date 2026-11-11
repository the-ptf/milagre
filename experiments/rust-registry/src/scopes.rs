use crate::*;
const PREFIX: &str = "milagre-link:";
pub fn valid_link_id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 36
            && s.bytes().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
    })
}
fn computer_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}
fn parts(key: &str) -> (bool, &str, &str) {
    let link = key.starts_with(PREFIX);
    let rest = key.strip_prefix(PREFIX).unwrap_or(key);
    let qualified = rest
        .split_once('|')
        .filter(|(id, _)| computer_id(id) && *id != "local");
    let (computer, bare) = qualified.unwrap_or(("local", rest));
    (link, computer, bare)
}
pub fn computer_of_key(key: &Value) -> String {
    key.as_str()
        .map(|key| parts(key).1)
        .unwrap_or("local")
        .into()
}
pub fn unqualify(key: &Value) -> Value {
    let Some(key) = key.as_str() else {
        return key.clone();
    };
    let (link, _, bare) = parts(key);
    json!(if link {
        format!("{PREFIX}{bare}")
    } else {
        bare.into()
    })
}
pub fn qualify(computer: &Value, key: &Value) -> Result<Value> {
    let Some(key) = key.as_str() else {
        return Ok(key.clone());
    };
    if !jsjson::truthy(Some(computer)) {
        return Ok(json!(key));
    }
    let computer = js_string(computer);
    let computer = computer.as_str();
    if computer.is_empty() || computer == "local" {
        return Ok(json!(key));
    }
    if !computer_id(computer) {
        return Err("Invalid computer id.".into());
    }
    let (link, current, bare) = parts(key);
    Ok(json!(if current != "local" {
        key.into()
    } else if link {
        format!("{PREFIX}{computer}|{bare}")
    } else {
        format!("{computer}|{key}")
    }))
}
pub fn is_link(key: &Value) -> bool {
    key.as_str()
        .is_some_and(|key| key.starts_with(PREFIX) && valid_link_id(&json!(parts(key).2)))
}
fn absolute(s: &str) -> bool {
    s.starts_with('/')
        || s.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && s.as_bytes().get(1) == Some(&b':')
            && matches!(s.as_bytes().get(2), Some(b'/' | b'\\'))
}
pub fn scope_key(scope: &Value) -> Result<String> {
    if scope["kind"] == "link" {
        if let Some(id) = scope["linkId"].as_str() {
            if valid_link_id(&json!(parts(&format!("{PREFIX}{id}")).2)) {
                return Ok(format!("{PREFIX}{id}"));
            }
        }
    }
    if scope["kind"] == "project" {
        if let Some(path) = scope["projectPath"].as_str() {
            if absolute(parts(path).2) {
                return Ok(path.into());
            }
        }
    }
    Err("Choose a valid Project or Link.".into())
}
pub fn scope_from_key(key: &Value) -> Value {
    if is_link(key) {
        json!({"kind":"link","linkId":key.as_str().unwrap().strip_prefix(PREFIX).unwrap()})
    } else {
        json!({"kind":"project","projectPath":key})
    }
}
pub fn chat_key(scope: &Value, id: &Value) -> Result<String> {
    let number = id.as_f64().ok_or("Invalid Chat ID.")?;
    if number < 1.0 || number.fract() != 0.0 || number > 9007199254740991.0 {
        return Err("Invalid Chat ID.".into());
    }
    Ok(format!("{}#{}", scope_key(scope)?, number as u64))
}
pub fn scope_from_chat(key: &Value) -> Result<Value> {
    let key = key.as_str().ok_or("Invalid Chat key.")?;
    let (owner, id) = key.rsplit_once('#').ok_or("Invalid Chat key.")?;
    if id.is_empty() || !id.bytes().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Chat key.".into());
    }
    let scope = scope_from_key(&json!(owner));
    scope_key(&scope)?;
    Ok(scope)
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(n) => jsjson::f64_to_js(jsjson::as_f64(n)),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}
