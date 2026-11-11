use crate::*;
pub(crate) fn families(document: &Value) -> Vec<String> {
    let catalog = contract()["families"].as_array().unwrap();
    let mut result = Vec::new();
    for node in document["nodes"].as_array().unwrap() {
        if node["type"] != "text" || jsjson::truthy(node.get("hidden")) {
            continue;
        }
        let Some(family) = node["fontFamily"].as_str() else {
            continue;
        };
        let family = family
            .split(',')
            .next()
            .unwrap()
            .trim()
            .trim_matches(['\'', '"']);
        if family.is_empty()
            || family.eq_ignore_ascii_case("inter")
            || catalog
                .iter()
                .any(|f| f.as_str().unwrap().eq_ignore_ascii_case(family))
        {
            continue;
        }
        if !result.iter().any(|f| f == family) {
            result.push(family.into());
        }
    }
    result
}
pub(crate) fn undrawable(document: &Value) -> Vec<String> {
    let nodes = document["nodes"].as_array().unwrap();
    let glyphs = contract()["glyphs"].as_str().unwrap();
    let mut result = Vec::new();
    for node in nodes {
        if node["type"] != "text"
            || !node["text"]
                .as_str()
                .is_some_and(|s| s.chars().any(|c| !c.is_whitespace() && !glyphs.contains(c)))
        {
            continue;
        }
        let mut current = Some(node);
        let mut hidden = false;
        let mut instance = None;
        for _ in 0..64 {
            let Some(n) = current else { break };
            if jsjson::truthy(n.get("hidden")) {
                hidden = true;
                break;
            }
            if instance.is_none() && n.get("componentId").is_some() {
                instance = Some(n);
            }
            current = n["parentId"]
                .as_str()
                .and_then(|id| nodes.iter().find(|n| n["id"] == id));
        }
        if !hidden {
            let id = instance.unwrap_or(node)["id"].as_str().unwrap().to_owned();
            if !result.contains(&id) {
                result.push(id);
            }
        }
    }
    result
}
pub(crate) async fn feedback(
    mut saved: Value,
    document: &Value,
    raster: Option<&RasterRenderer>,
    crop: Option<&Value>,
    intent: Option<&Value>,
) -> Result<Value> {
    let mut problems = Vec::new();
    let warnings = match design::diagnostics(document) {
        Ok(d) => d["warnings"].as_array().cloned().unwrap_or_default(),
        Err(e) => {
            problems.push(format!(
                "Layout warnings could not be computed: {}.",
                e.message
            ));
            Vec::new()
        }
    };
    saved["warnings"] = json!(warnings.iter().take(20).collect::<Vec<_>>());
    if warnings.len() > 20 {
        saved["warningCount"] = json!(warnings.len());
    }
    let mut notes = vec![jsjson::to_string(&saved)];
    let mut images = Vec::new();
    let render = match raster {
        Some(raster) => raster.render(document, crop).await,
        None => Err(Error::new("Native Design renderer helper is unavailable")),
    };
    match render {
        Ok(image) => {
            images.push(json!({"type":"image","data":image["base64"],"mimeType":image["mime"]}));
            notes.push(match intent.and_then(|i|i["mode"].as_str()){
 Some("text-only")=>"Look at the image. This was a text-only edit: report clipping, overflow or other warnings without changing geometry or style. Keep the same intent for further text edits; expanding the scope needs the user's permission.",
 Some("fit-text")=>"Look at the image and verify the text fits. Keep this fit-text intent and its declared scope for any correction; preserve styles and other copy. Report problems that need a wider scope.",
 _=>"Look at the image: check icons, spacing, alignment and density against the brief, fix what looks wrong and every item under Warnings within the user's requested scope with design_apply, then reply."}.into());
            let fonts = families(document);
            if !fonts.is_empty() {
                notes.push(format!(
                    "Your image shows {} in Inter; the user sees the real font.",
                    fonts.join(", ")
                ));
            }
            let blank = undrawable(document);
            if !blank.is_empty() {
                let named = blank
                    .iter()
                    .take(5)
                    .map(|id| format!("\"{id}\""))
                    .collect::<Vec<_>>()
                    .join(", ");
                notes.push(format!("Your image can't draw some characters in {}{}; they are blank and the line may look cut there, but the user sees them.",named,if blank.len()>5{format!(" and {} more",blank.len()-5)}else{String::new()}));
            }
        }
        Err(e) => notes.push(format!(
            "The preview could not be rendered: {}. Check the warnings below.",
            e.message
        )),
    }
    notes.extend(problems);
    for (remote, head) in [(false, "Warnings"), (true, "Notes")] {
        let warnings = warnings
            .iter()
            .filter(|w| (w["kind"] == "remote-image") == remote)
            .cloned()
            .collect::<Vec<_>>();
        let words = design::warning_text(&warnings);
        if !words.is_empty() {
            notes.push(format!("{head}:\n{words}"));
        }
    }
    let mut content = vec![json!({"type":"text","text":notes.join("\n")})];
    content.extend(images);
    Ok(json!({"content":content,"isError":false}))
}
