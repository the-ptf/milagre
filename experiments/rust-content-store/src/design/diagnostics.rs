use super::layout::{number, text_layout};
use super::*;
fn overlaps(a: &Bounds, b: &Bounds) -> bool {
    a.x < b.x + b.width - 0.5
        && b.x < a.x + a.width - 0.5
        && a.y < b.y + b.height - 0.5
        && b.y < a.y + a.height - 0.5
}
fn contains(a: &Bounds, b: &Bounds) -> bool {
    b.x >= a.x - 1.0
        && b.y >= a.y - 1.0
        && b.x + b.width <= a.x + a.width + 1.0
        && b.y + b.height <= a.y + a.height + 1.0
}
fn luminance(value: Option<&str>) -> Option<f64> {
    let (color, opacity) = colors::key(value?)?;
    if opacity != 1.0 || color == "none" {
        return None;
    }
    let c = (0..3)
        .map(|index| {
            u8::from_str_radix(&color[1 + index * 2..3 + index * 2], 16).unwrap() as f64 / 255.0
        })
        .map(|v| {
            if v <= 0.04045 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        })
        .collect::<Vec<_>>();
    Some(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])
}
fn contrast(a: f64, b: f64) -> f64 {
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}
fn order(document: &Value, parent: &str, out: &mut Vec<usize>) {
    for (index, node) in nodes(document)
        .iter()
        .enumerate()
        .filter(|(_, node)| sid(node, "parentId") == parent)
    {
        out.push(index);
        order(document, &sid(node, "id"), out);
    }
}
fn num(value: f64) -> String {
    jsjson::to_string(&json!(value))
}
/// Measured preflight diagnostics and candidate repairs. Suggestions never mutate
/// a document; every suggested operation still requires validation by the caller.
pub fn diagnostics(input: &Value) -> Result<Value> {
    let document = validate_document(input)?;
    checked(&document)
}
pub(super) fn checked(document: &Value) -> Result<Value> {
    let layers = nodes(document);
    let bounds = layout(document)?;
    let by_id = layers
        .iter()
        .map(|node| (sid(node, "id"), node))
        .collect::<BTreeMap<_, _>>();
    let resolve = |value: &str| {
        if let Some(name) = value.strip_prefix('$') {
            document["tokens"][name].as_str().unwrap_or("").to_owned()
        } else {
            value.to_owned()
        }
    };
    let mut paint_order = vec![];
    order(document, "", &mut paint_order);
    let positions = paint_order
        .iter()
        .enumerate()
        .map(|(at, index)| (sid(&layers[*index], "id"), at))
        .collect::<BTreeMap<_, _>>();
    let mut warnings = vec![];
    let mut contrast_checks = vec![];
    for (index, node) in layers.iter().enumerate() {
        let id = sid(node, "id");
        let Some(bounds_node) = bounds.get(&id) else {
            continue;
        };
        let parent = by_id.get(&sid(node, "parentId")).copied();
        let canvas = Bounds {
            x: 0.0,
            y: 0.0,
            width: number(document, "width", 0.0),
            height: number(document, "height", 0.0),
        };
        let parent_box = parent
            .and_then(|parent| bounds.get(&sid(parent, "id")))
            .unwrap_or(&canvas);
        if node["type"] == "text" {
            let border = if yes(node, "stroke") {
                number(node, "strokeWidth", 1.0)
            } else {
                0.0
            };
            let content_width = (bounds_node.width - 2.0 * border).max(1.0);
            let layout = text_layout(node, content_width);
            let font_size = number(node, "fontSize", 16.0);
            let glyph_bottom = layout.height - (layout.line_height - font_size) / 2.0;
            let height = (bounds_node.height - 2.0 * border).max(0.0);
            let visible = if height == 0.0 {
                0
            } else {
                ((height + ((font_size - layout.line_height) / 2.0).max(0.0)) / layout.line_height)
                    .ceil() as usize
            };
            if visible < layout.lines.len()
                || glyph_bottom > bounds_node.height - 2.0 * border + 0.5
            {
                let required_height = (layout.height + 2.0 * border).ceil();
                let first = if let Some(source) = node["componentSourceId"].as_str() {
                    json!({"label":format!("Edit main text layer \"{source}\" or its exposed text property; do not edit generated children."),"requiresValidation":true})
                } else {
                    json!({"label":"Let text hug its content; validate parent overflow and movement of siblings before applying.","operations":[{"op":"update","id":id,"patch":{"heightMode":"hug"}}],"requiresValidation":true})
                };
                warnings.push(json!({"id":id,"kind":"clipped-text","path":["nodes",index,"height"],"blockerId":id,"measurements":{"availableHeight":bounds_node.height,"requiredHeight":required_height,"missingHeight":(required_height-bounds_node.height).max(0.0),"contentWidth":content_width,"lineCount":layout.lines.len()},"suggestions":[first,{"label":"Shorten the copy only if the user permits a content change.","requiresValidation":true}],"message":format!("Text \"{id}\" needs {}px but has {}px; it is cut off. Use heightMode \"hug\" or shorten it.",num(layout.height.ceil()),num(bounds_node.height.floor()))}));
            }
        }
        if !contains(parent_box, bounds_node) {
            let automatic =
                parent.is_some_and(|parent| yes(parent, "layout") && parent["layout"] != "free");
            let can_move = !automatic
                && bounds_node.width <= parent_box.width
                && bounds_node.height <= parent_box.height
                && !yes(node, "componentSourceId");
            let mut suggestion = json!({"label":if can_move{"Move inside the existing bounds; validate overlaps before applying.".into()}else if automatic{format!("Adjust sizing in automatic layout \"{}\"; x/y offsets do not move its children.",sid(parent.unwrap(),"id"))}else{"Resize the layer or its container, then validate the result.".into()},"requiresValidation":true});
            if can_move {
                suggestion["operations"] = json!([{"op":"update","id":id,"patch":{"x":(bounds_node.x-parent_box.x).min(parent_box.width-bounds_node.width).max(0.0),"y":(bounds_node.y-parent_box.y).min(parent_box.height-bounds_node.height).max(0.0)}}]);
            }
            warnings.push(json!({"id":id,"kind":if parent.is_some(){"overflow"}else{"off-canvas"},"blockerId":parent.map(|parent|sid(parent,"id")).unwrap_or("$canvas".into()),"path":["nodes",index],"measurements":{"left":(parent_box.x-bounds_node.x).max(0.0),"top":(parent_box.y-bounds_node.y).max(0.0),"right":(bounds_node.x+bounds_node.width-parent_box.x-parent_box.width).max(0.0),"bottom":(bounds_node.y+bounds_node.height-parent_box.y-parent_box.height).max(0.0),"availableWidth":parent_box.width,"availableHeight":parent_box.height,"actualWidth":bounds_node.width,"actualHeight":bounds_node.height},"suggestions":[suggestion],"message":if let Some(parent)=parent{format!("\"{id}\" extends outside its parent \"{}\" and is clipped.",sid(parent,"id"))}else{format!("\"{id}\" extends past the {}×{} screen.",num(number(document,"width",0.0)),num(number(document,"height",0.0)))}}));
        }
        if node["type"] == "image"
            && node["src"]
                .as_str()
                .is_some_and(|src| src.starts_with("https:"))
        {
            warnings.push(json!({"id":id,"kind":"remote-image","message":format!("Image \"{id}\" is a remote URL, shown as a placeholder in your preview; the user sees the real image.")}));
        }
        if node["type"] != "text" {
            continue;
        }
        let position = positions[&id];
        let behind = paint_order[..position].iter().rev().find_map(|index| {
            let candidate = &layers[*index];
            let candidate_box = bounds.get(&sid(candidate, "id"))?;
            if !overlaps(candidate_box, bounds_node) {
                return None;
            }
            if candidate["type"] == "image"
                || ["frame", "rectangle", "ellipse"].contains(&candidate["type"].as_str().unwrap())
                    && yes(candidate, "fill")
            {
                Some((candidate, candidate_box))
            } else {
                None
            }
        });
        let backdrop = if let Some((behind, behind_box)) = behind {
            if behind["type"] != "image"
                && number(behind, "opacity", 1.0) == 1.0
                && contains(behind_box, bounds_node)
            {
                behind["fill"].as_str().map(resolve)
            } else {
                None
            }
        } else {
            Some(resolve(
                document["background"].as_str().unwrap_or("#ffffff"),
            ))
        };
        let foreground = if number(node, "opacity", 1.0) == 1.0 {
            luminance(Some(&resolve(node["fill"].as_str().unwrap_or("#202720"))))
        } else {
            None
        };
        let background = luminance(backdrop.as_deref());
        let mut ancestor = parent;
        let mut opaque = true;
        while let Some(current) = ancestor {
            if number(current, "opacity", 1.0) != 1.0 {
                opaque = false;
            }
            ancestor = by_id.get(&sid(current, "parentId")).copied();
        }
        let ratio = foreground
            .zip(background)
            .filter(|_| opaque)
            .map(|(a, b)| contrast(a, b));
        contrast_checks.push(if let Some(ratio)=ratio{json!({"id":id,"status":"checked","ratio":ratio})}else{json!({"id":id,"status":"unsupported","reason":"The backdrop, color or transparency cannot be evaluated as one opaque color."})});
        if let Some(ratio) = ratio.filter(|ratio| *ratio < 3.0) {
            let palette = document["kit"]
                .get("colors")
                .or_else(|| document.get("tokens"));
            let mut alternatives = palette
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|map| map.iter())
                .filter_map(|(name, value)| {
                    let value = document["tokens"].get(name).unwrap_or(value);
                    let luminance = luminance(value.as_str())?;
                    let contrast = contrast(luminance, background.unwrap());
                    (contrast >= 3.0).then_some((name, contrast))
                })
                .collect::<Vec<_>>();
            alternatives.sort_by(|a, b| b.1.total_cmp(&a.1));
            let alternative = alternatives
                .first()
                .filter(|_| !yes(node, "componentSourceId"));
            let mut suggestion = json!({"label":if alternative.is_some(){"Use a readable palette color only when a style change is authorized."}else{"Choose a readable foreground/background pair when a style change is authorized."},"requiresValidation":true});
            if let Some((name, _)) = alternative {
                suggestion["operations"] =
                    json!([{"op":"update","id":id,"patch":{"fill":format!("${name}")}}]);
            }
            warnings.push(json!({"id":id,"kind":"low-contrast","blockerId":behind.map(|(node,_)|sid(node,"id")).unwrap_or("$canvas".into()),"measurements":{"ratio":ratio,"minimumRatio":3},"suggestions":[suggestion],"message":format!("Text \"{id}\" has {ratio:.1}:1 contrast against its background; below 3:1 it is hard to read.")}));
        }
    }
    warnings.extend(kit::warnings(document));
    Ok(json!({"warnings":warnings,"contrastChecks":contrast_checks}))
}
pub fn warning_text(warnings: &[Value]) -> String {
    let mut lines = warnings
        .iter()
        .take(20)
        .map(|warning| format!("- {}", warning["message"].as_str().unwrap_or("")))
        .collect::<Vec<_>>();
    if warnings.len() > 20 {
        lines.push(format!("…and {} more", warnings.len() - 20));
    }
    lines.join("\n")
}
