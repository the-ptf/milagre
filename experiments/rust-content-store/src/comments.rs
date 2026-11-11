use crate::{validation::*, *};
use std::collections::HashSet;

fn comment_id(id: &str) -> bool {
    id.len() == 8
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn layer_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id.as_bytes()[0].is_ascii_alphabetic()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}
fn string_or(value: Option<&Value>, fallback: &Value) -> String {
    jsjson::property_key(Some(
        value.filter(|value| !value.is_null()).unwrap_or(fallback),
    ))
}
fn near(text: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for character in text.chars() {
        if character == '"' || whitespace(character) {
            if !gap {
                out.push(' ');
            }
            gap = true;
        } else {
            out.push(character);
            gap = false;
        }
    }
    slice(trim(&out), 120)
}
impl ArtifactStore {
    fn read_comments(&self, folder: &Dir) -> Result<Vec<Value>> {
        match read_json(folder, "comments", 64 * 1024 * 1024) {
            Ok(Value::Array(comments)) => Ok(comments),
            Ok(_) => Ok(Vec::new()),
            Err(error) if error.missing() => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }
    fn comment_design(
        &self,
        folder: &Dir,
        comment: &Value,
        retained: bool,
        format: Option<&Value>,
    ) -> Result<()> {
        let artifact = self
            .load(folder, validation::id(&comment["design"]["id"])?, false)?
            .ok_or_else(|| Error::new("This comment's design is no longer available."))?;
        validation::format(format)?;
        if format.is_some_and(|format| format.as_str() != Some(format_of(last(&artifact)))) {
            return Err(Error::new(FORMAT_MISMATCH));
        }
        let version = integer(&comment["design"]["version"])
            .filter(|version| {
                *version >= 1 && *version as u64 <= last(&artifact)["version"].as_u64().unwrap_or(0)
            })
            .ok_or_else(|| Error::new("This comment's design version is not available."))?
            as u64;
        if format_of(last(&artifact)) == "html" {
            return Ok(());
        }
        let versions = artifact["versions"].as_array().unwrap();
        if !versions.iter().any(|entry| entry["version"] == version)
            && (retained || version >= versions[0]["version"].as_u64().unwrap_or(0))
        {
            return Err(Error::new(
                "This comment's design version is no longer kept.",
            ));
        }
        Ok(())
    }
    pub fn add_comments(&mut self, request: &Value) -> Result<Value> {
        let folder = self.chat(request, true)?.unwrap();
        let incoming = request["comments"]
            .as_array()
            .filter(|comments| !comments.is_empty() && comments.len() <= 50)
            .ok_or_else(|| Error::new("Send between 1 and 50 comments at once."))?;
        let mut added = Vec::new();
        for comment in incoming {
            let design = &comment["design"];
            if !design["id"].as_str().is_some_and(valid_id) || integer(&design["version"]).is_none()
            {
                return Err(Error::new("A comment names its design."));
            }
            let text = comment["text"]
                .as_str()
                .map(|text| slice(trim(text), 4000))
                .filter(|text| !text.is_empty())
                .ok_or_else(|| Error::new("A comment needs its text."))?;
            if comment
                .get("nodeId")
                .is_some_and(|id| !id.as_str().is_some_and(layer_id))
            {
                return Err(Error::new("A comment's layer id must use letters, numbers, dots, underscores or dashes and start with a letter."));
            }
            let id = match comment["id"].as_str().filter(|id| comment_id(id)) {
                Some(id) => id.to_owned(),
                None => self.fresh_id(true)?,
            };
            let mut value = json!({"id":id,"design":{"id":design["id"],"version":design["version"],"title":slice(&string_or(design.get("title"),&design["id"]),120)}});
            if let Some(node) = comment.get("nodeId") {
                value["nodeId"] = node.clone();
            }
            if ["x", "y"].iter().all(|key| {
                comment[key]
                    .as_f64()
                    .is_some_and(|number| (0.0..=1.0).contains(&number))
            }) {
                value["x"] = comment["x"].clone();
                value["y"] = comment["y"].clone();
            }
            if let Some(text) = comment["near"].as_str() {
                let text = near(text);
                if !text.is_empty() {
                    value["near"] = json!(text);
                }
            }
            if let Some(text) = comment["anchor"].as_str().filter(|text| anchor(text)) {
                value["anchor"] = json!(text);
            }
            if let Some(id) = comment["tab"]["id"].as_str().filter(|id| valid_id(id)) {
                let title = slice(
                    trim(&string_or(
                        comment["tab"].get("title"),
                        &comment["tab"]["id"],
                    )),
                    60,
                );
                value["tab"] =
                    json!({"id":id,"title":if title.is_empty(){id.to_owned()}else{title}});
            }
            value["text"] = json!(text);
            value["createdAt"] = json!(self.runtime.now_ms());
            self.comment_design(&folder, &value, true, None)?;
            added.push(value);
        }
        let mut kept = self.read_comments(&folder)?;
        let mut seen = kept
            .iter()
            .filter_map(|comment| comment["id"].as_str().map(str::to_owned))
            .collect::<HashSet<_>>();
        for comment in &added {
            if seen.insert(comment["id"].as_str().unwrap().to_owned()) {
                kept.push(comment.clone());
            }
        }
        if kept.len() > 2000 {
            kept.drain(..kept.len() - 2000);
        }
        self.write_json(&folder, "comments", &json!(kept))?;
        Ok(json!(added))
    }
    pub fn comments(&mut self, request: &Value) -> Result<Value> {
        let folder = self.chat(request, false)?;
        validation::format(request.get("format"))?;
        let Some(folder) = folder else {
            return Ok(json!([]));
        };
        let comments = self
            .read_comments(&folder)?
            .into_iter()
            .filter(|comment| {
                self.comment_design(&folder, comment, false, request.get("format"))
                    .is_ok()
            })
            .collect::<Vec<_>>();
        Ok(json!(comments))
    }
    pub fn resolve_comment(&mut self, request: &Value) -> Result<Value> {
        (self.active)()?;
        let folder = self.chat(request, true)?.unwrap();
        let note = request["note"]
            .as_str()
            .map(|note| slice(trim(note), 2000))
            .filter(|note| !note.is_empty())
            .ok_or_else(|| Error::new("Say how the comment was resolved."))?;
        let mut comments = self.read_comments(&folder)?;
        let comment = comments
            .iter_mut()
            .find(|comment| comment["id"] == request["id"])
            .ok_or_else(|| {
                Error::new(format!(
                    "No comment {} in this Chat. List them with artifact_comments.",
                    jsjson::property_key(request.get("id"))
                ))
            })?;
        self.comment_design(&folder, comment, false, request.get("format"))?;
        comment["resolved"] = json!({"note":note,"at":self.runtime.now_ms()});
        let result = comment.clone();
        self.write_json(&folder, "comments", &json!(comments))?;
        Ok(result)
    }
}
