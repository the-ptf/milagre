//! Fresh portable HTML produced in Rust. Only the existing sandboxed iframe
//! controller remains JavaScript; layout, fonts and markup need no Node process.
use super::layout::{data, number, text_layout};
use super::*;

fn num(value: f64) -> String {
    jsjson::to_string(&json!(value))
}
fn escape(value: &str) -> String {
    utf8(value)
        .chars()
        .map(|c| match c {
            '&' => "&amp;".into(),
            '<' => "&lt;".into(),
            '>' => "&gt;".into(),
            '"' => "&quot;".into(),
            '\'' => "&#39;".into(),
            c => c.to_string(),
        })
        .collect()
}
fn safe_json(value: &Value) -> String {
    jsjson::to_string(value)
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}
fn color(document: &Value, value: Option<&Value>, fallback: &str) -> String {
    let value = value.and_then(Value::as_str).unwrap_or(fallback);
    if let Some(token) = value.strip_prefix('$') {
        document["tokens"][token]
            .as_str()
            .unwrap_or(fallback)
            .to_owned()
    } else {
        value.to_owned()
    }
}
fn fill(node: &Value) -> &str {
    match node["type"].as_str().unwrap() {
        "text" | "icon" => "#202720",
        "frame" => "transparent",
        "image" if yes(node, "src") => "transparent",
        _ => "#d8ded8",
    }
}
fn family(node: &Value) -> String {
    node["fontFamily"]
        .as_str()
        .unwrap_or("Inter, Arial, sans-serif")
        .split(',')
        .map(|part| {
            let name = trim(part);
            let lower = name.to_lowercase();
            if [
                "serif",
                "sans-serif",
                "monospace",
                "cursive",
                "fantasy",
                "system-ui",
                "ui-serif",
                "ui-sans-serif",
                "ui-monospace",
                "ui-rounded",
                "math",
                "fangsong",
            ]
            .contains(&lower.as_str())
            {
                lower
            } else {
                format!("\"{name}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}
fn faces(document: &Value) -> String {
    let mut faces = BTreeMap::<String, (String, f64, Vec<f64>, String)>::new();
    for node in nodes(document)
        .iter()
        .filter(|node| node["type"] == "text" && !yes(node, "hidden"))
    {
        let entry = if layout::inter(node) {
            None
        } else {
            layout::catalog(node)
        };
        if !layout::inter(node) && entry.is_none() {
            continue;
        }
        let family = entry
            .and_then(|entry| entry["family"].as_str())
            .unwrap_or("Inter");
        let weights = entry
            .map(|entry| &entry["weights"])
            .unwrap_or(&data()["interWeights"])
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_f64().unwrap())
            .collect::<Vec<_>>();
        let weight = layout::nearest(&weights, number(node, "fontWeight", 400.0));
        let bytes = entry
            .map(|entry| &entry["faces"])
            .unwrap_or(&data()["inter"])[num(weight)]
        .as_str()
        .unwrap();
        faces.insert(
            format!("{family}\0{}", num(weight)),
            (family.to_owned(), weight, weights, bytes.to_owned()),
        );
    }
    faces.values().map(|(family,weight,weights,bytes)|{let index=weights.iter().position(|n|n==weight).unwrap();let start=if index==0{1.0}else{(weights[index-1]+weight)/2.0+1.0};let end=weights.get(index+1).map(|next|(next+weight)/2.0).unwrap_or(1000.0);format!("@font-face{{font-family:\"{family}\";font-weight:{} {};font-style:normal;src:url(data:font/ttf;base64,{bytes}) format(\"truetype\")}}",num(start),num(end))}).collect()
}
fn styles(
    document: &Value,
    node: &Value,
    bounds: &Bounds,
    parent: Option<&Bounds>,
    parent_node: Option<&Value>,
) -> String {
    let parent_stroke = parent_node
        .filter(|node| yes(node, "stroke"))
        .map(|node| number(node, "strokeWidth", 1.0))
        .unwrap_or(0.0);
    let background = if node["type"] == "text" || node["type"] == "icon" {
        "transparent".into()
    } else {
        color(document, node.get("fill"), fill(node))
    };
    let radius = if node["type"] == "ellipse" {
        "50%".into()
    } else {
        format!("{}px", num(number(node, "radius", 0.0)))
    };
    let border = if yes(node, "stroke") && node["type"] != "icon" {
        number(node, "strokeWidth", 1.0)
    } else {
        0.0
    };
    let mut parts = vec![
        "position:absolute".into(),
        "box-sizing:border-box".into(),
        format!(
            "left:{}px",
            num(bounds.x - parent.map(|b| b.x).unwrap_or(0.0) - parent_stroke)
        ),
        format!(
            "top:{}px",
            num(bounds.y - parent.map(|b| b.y).unwrap_or(0.0) - parent_stroke)
        ),
        format!("width:{}px", num(bounds.width)),
        format!("height:{}px", num(bounds.height)),
        format!("background:{background}"),
        format!("opacity:{}", num(number(node, "opacity", 1.0))),
        format!("border-radius:{radius}"),
        format!(
            "border:{}px solid {}",
            num(border),
            color(document, node.get("stroke"), "transparent")
        ),
        "overflow:hidden".into(),
    ];
    if node["type"] == "text" {
        parts.extend([
            format!("color:{}", color(document, node.get("fill"), fill(node))),
            format!("font-size:{}px", num(number(node, "fontSize", 16.0))),
            format!("font-family:{}", family(node)),
            format!("font-weight:{}", num(number(node, "fontWeight", 400.0))),
            format!(
                "text-align:{}",
                node["textAlign"].as_str().unwrap_or("left")
            ),
            format!("line-height:{}", num(number(node, "lineHeight", 1.35))),
            "font-kerning:none".into(),
            "font-variant-ligatures:none".into(),
            "font-feature-settings:\"calt\" 0".into(),
            "white-space:pre-wrap".into(),
            "overflow-wrap:normal".into(),
        ]);
    }
    parts.join(";")
}
struct Output {
    html: String,
}
impl Output {
    fn append(&mut self, part: &str, node: Option<&Value>) -> Result<()> {
        if self.html.len() + part.len() > 8 * 1024 * 1024 {
            let layer = node
                .map(|node| {
                    format!(
                        " at layer \"{}\" ({})",
                        node["name"]
                            .as_str()
                            .unwrap_or(node["id"].as_str().unwrap()),
                        sid(node, "id")
                    )
                })
                .unwrap_or_default();
            return Err(error(format!("Design HTML exceeds the 8 MiB rendered size limit{layer}. Reduce visible text or image content.")));
        }
        self.html.push_str(part);
        Ok(())
    }
}
fn markup(
    document: &Value,
    bounds: &BTreeMap<String, Bounds>,
    parent: &str,
    out: &mut Output,
) -> Result<()> {
    for node in nodes(document)
        .iter()
        .filter(|node| sid(node, "parentId") == parent)
    {
        let id = sid(node, "id");
        let Some(bounds_node) = bounds.get(&id) else {
            continue;
        };
        let parent_node = nodes(document).iter().find(|node| node["id"] == parent);
        out.append(
            &format!(
                "<div data-design-node=\"{}\" aria-label=\"{}\" style=\"{}\">",
                escape(&id),
                escape(node["name"].as_str().unwrap_or(&id)),
                escape(&styles(
                    document,
                    node,
                    bounds_node,
                    bounds.get(parent),
                    parent_node
                ))
            ),
            Some(node),
        )?;
        if node["type"] == "text" {
            let border = if yes(node, "stroke") {
                number(node, "strokeWidth", 1.0)
            } else {
                0.0
            };
            let layout = text_layout(node, (bounds_node.width - 2.0 * border).max(1.0));
            let height = (bounds_node.height - 2.0 * border).max(0.0);
            let overhang = ((number(node, "fontSize", 16.0) - layout.line_height) / 2.0).max(0.0);
            let visible = if height == 0.0 {
                0
            } else {
                ((height + overhang) / layout.line_height).ceil() as usize
            };
            for line in layout.lines.iter().take(visible) {
                let line = escape(line);
                out.append(
                    &format!(
                        "<span style=\"display:block;white-space:pre;height:{}px\">{}</span>",
                        num(layout.line_height),
                        if line.is_empty() { "&#8203;" } else { &line }
                    ),
                    Some(node),
                )?;
            }
        } else if node["type"] == "image" && yes(node, "src") {
            out.append(&format!("<img src=\"{}\" alt=\"{}\" draggable=\"false\" style=\"width:100%;height:100%;object-fit:cover;pointer-events:none\"/>",escape(node["src"].as_str().unwrap()),escape(node["name"].as_str().unwrap_or(""))),Some(node))?;
        } else if node["type"] == "icon" {
            let color = escape(&color(document, node.get("fill"), fill(node)));
            out.append(&format!("<svg viewBox=\"0 0 24 24\" width=\"100%\" height=\"100%\" preserveAspectRatio=\"xMidYMid meet\" fill=\"none\" stroke=\"{color}\" stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\" color=\"{color}\" aria-hidden=\"true\">{}</svg>",num(number(node,"strokeWidth",2.0)),data()["icons"][sid(node,"icon")].as_str().unwrap()),Some(node))?;
        }
        markup(document, bounds, &id, out)?;
        out.append("</div>", Some(node))?;
    }
    Ok(())
}
fn ordered_bounds(
    document: &Value,
    bounds: &BTreeMap<String, Bounds>,
    parent: &str,
    output: &mut Map<String, Value>,
) {
    for node in nodes(document)
        .iter()
        .filter(|node| sid(node, "parentId") == parent)
    {
        let id = sid(node, "id");
        if let Some(bound) = bounds.get(&id) {
            output.insert(id.clone(), bound.value());
            ordered_bounds(document, bounds, &id, output);
        }
    }
}

/// Static saved preview, including the exact measured font faces it uses.
pub fn render_html(document: &Value) -> Result<String> {
    render_html_with_options(document, &json!({}))
}
/// Existing sandboxed iframe controller and selected-layer outline are retained.
/// The caller must still apply the artifact CSP and opaque-origin iframe sandbox.
pub fn render_html_with_options(input: &Value, options: &Value) -> Result<String> {
    let document = validate_document(input)?;
    let bounds = layout(&document)?;
    let selected = options["selectedId"]
        .as_str()
        .filter(|id| nodes(&document).iter().any(|node| node["id"] == *id));
    let selected_box = selected.and_then(|id| bounds.get(id));
    let interactive = options["interactive"] == true;
    let selection=format!("<div id=\"design-selection\" style=\"position:absolute;box-sizing:border-box;pointer-events:none;border:2px solid #367bf5;z-index:2147483646;{}\">{}</div>",selected_box.map(|b|format!("left:{}px;top:{}px;width:{}px;height:{}px",num(b.x),num(b.y),num(b.width),num(b.height))).unwrap_or_else(||"display:none".into()),if interactive{"<span id=\"design-resize\" style=\"position:absolute;right:-5px;bottom:-5px;width:10px;height:10px;border:1px solid #367bf5;background:white;pointer-events:auto;cursor:nwse-resize\"></span>"}else{""});
    let fonts = faces(&document);
    let width = num(number(&document, "width", 0.0));
    let height = num(number(&document, "height", 0.0));
    let mut output = Output {
        html: String::new(),
    };
    output.append(&format!("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width={width}, initial-scale=1\"><style>html,body{{margin:0;padding:0;width:{width}px;height:{height}px;overflow:hidden}}body{{background:{}}}*{{box-sizing:border-box}}#design-root{{position:relative;width:100%;height:100%;{}}}</style>{}</head><body><main id=\"design-root\">",escape(&color(&document,document.get("background"),"#ffffff")),if interactive{"touch-action:none;user-select:none;cursor:default"}else{""},if fonts.is_empty(){String::new()}else{format!("<style>{fonts}</style>")}),None)?;
    markup(&document, &bounds, "", &mut output)?;
    let controller = if interactive {
        let mut ordered = Map::new();
        ordered_bounds(&document, &bounds, "", &mut ordered);
        let bounds = Value::Object(ordered);
        format!(
            "<script type=\"application/json\" id=\"design-config\">{}</script><script>{}</script>",
            safe_json(&json!([document, selected, bounds])),
            data()["controller"].as_str().unwrap()
        )
    } else {
        String::new()
    };
    output.append(
        &format!("{selection}</main>{controller}</body></html>"),
        None,
    )?;
    Ok(output.html)
}
