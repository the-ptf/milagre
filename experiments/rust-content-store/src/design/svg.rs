use super::layout::{data, number, text_layout};
use super::*;
fn n(value: f64) -> String {
    jsjson::to_string(&json!((value * 10000.0 + 0.5).floor() / 10000.0))
}
fn xml(value: &str) -> String {
    utf8(value)
        .chars()
        .map(|c| match c {
            '\u{0}'..='\u{8}'
            | '\u{b}'
            | '\u{c}'
            | '\u{e}'..='\u{1f}'
            | '\u{fffe}'
            | '\u{ffff}' => "\u{fffd}".into(),
            '&' => "&amp;".into(),
            '<' => "&lt;".into(),
            '>' => "&gt;".into(),
            '"' => "&quot;".into(),
            '\'' => "&apos;".into(),
            c => c.to_string(),
        })
        .collect()
}
fn shape(node: &Value, bounds: &Bounds, inset: f64) -> String {
    let width = (bounds.width - inset * 2.0).max(0.0);
    let height = (bounds.height - inset * 2.0).max(0.0);
    if node["type"] == "ellipse" {
        return format!(
            "ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\"",
            n(bounds.x + bounds.width / 2.0),
            n(bounds.y + bounds.height / 2.0),
            n(width / 2.0),
            n(height / 2.0)
        );
    }
    let radius = (number(node, "radius", 0.0)
        .min(bounds.width / 2.0)
        .min(bounds.height / 2.0)
        - inset)
        .max(0.0);
    format!(
        "rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\"",
        n(bounds.x + inset),
        n(bounds.y + inset),
        n(width),
        n(height),
        n(radius)
    )
}
struct Svg<'a> {
    document: &'a Value,
    bounds: BTreeMap<String, Bounds>,
    definitions: Vec<String>,
    bytes: usize,
    limit: usize,
    on_canvas: bool,
}
impl Svg<'_> {
    fn take(&mut self, part: String, node: Option<&Value>) -> Result<String> {
        self.bytes += part.len();
        if self.bytes > self.limit {
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
            return Err(error(format!("Design SVG exceeds the 8 MiB rendered size limit{layer}. Reduce visible text or image content.")));
        }
        Ok(part)
    }
    fn color(&self, kind: &str, value: Option<&Value>, fallback: &str) -> String {
        let value = render::color(self.document, value, fallback);
        let (color, opacity) = colors::paint(&value).unwrap_or(("none".into(), 1.0));
        if opacity == 0.0 {
            return format!("{kind}=\"none\"");
        }
        format!(
            "{kind}=\"{}\"{}",
            xml(&color),
            if opacity == 1.0 {
                String::new()
            } else {
                format!(" {kind}-opacity=\"{}\"", n(opacity))
            }
        )
    }
    fn text(&mut self, node: &Value, bounds: &Bounds) -> Result<String> {
        let border = if yes(node, "stroke") {
            number(node, "strokeWidth", 1.0)
        } else {
            0.0
        };
        let width = (bounds.width - border * 2.0).max(1.0);
        let layout = text_layout(node, width);
        let size = number(node, "fontSize", 16.0);
        let anchor = match node["textAlign"].as_str() {
            Some("center") => "middle",
            Some("right") => "end",
            _ => "start",
        };
        let x = bounds.x
            + border
            + if anchor == "middle" {
                width / 2.0
            } else if anchor == "end" {
                width
            } else {
                0.0
            };
        let baseline = bounds.y + border + (layout.line_height - size) / 2.0 + size * 0.8;
        let weight = if layout::inter(node) || layout::catalog(node).is_some() {
            let weights = layout::catalog(node)
                .map(|entry| &entry["weights"])
                .unwrap_or(&data()["interWeights"])
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect::<Vec<_>>();
            layout::nearest(&weights, number(node, "fontWeight", 400.0))
        } else {
            number(node, "fontWeight", 400.0)
        };
        let height = (bounds.height - 2.0 * border).max(0.0);
        let visible = if height == 0.0 {
            0
        } else {
            ((height + ((size - layout.line_height) / 2.0).max(0.0)) / layout.line_height).ceil()
                as usize
        };
        let mut spans = String::new();
        for (index, line) in layout.lines.iter().take(visible).enumerate() {
            spans.push_str(&self.take(
                format!(
                    "<tspan x=\"{}\" y=\"{}\">{}</tspan>",
                    n(x),
                    n(baseline + index as f64 * layout.line_height),
                    xml(line)
                ),
                Some(node),
            )?);
        }
        Ok(self.take(format!("<text {} font-family=\"{}\" font-size=\"{}\" font-weight=\"{}\" text-anchor=\"{anchor}\" xml:space=\"preserve\" style=\"font-kerning:none;font-variant-ligatures:none;font-feature-settings:&quot;calt&quot; 0\">",self.color("fill",node.get("fill"),render::fill(node)),xml(&render::family(node)),n(size),n(weight)),Some(node))?+&spans+&self.take("</text>".into(),Some(node))?)
    }
    fn clipped(
        &mut self,
        content: String,
        clip: &str,
        enabled: bool,
        node: &Value,
    ) -> Result<String> {
        if enabled {
            Ok(self.take(
                format!("<g clip-path=\"url(#{clip}-content)\">"),
                Some(node),
            )? + &content
                + &self.take("</g>".into(), Some(node))?)
        } else {
            Ok(content)
        }
    }
    fn children(&mut self, parent: &str) -> Result<String> {
        let layers = nodes(self.document)
            .iter()
            .enumerate()
            .filter(|(_, node)| sid(node, "parentId") == parent)
            .map(|(index, node)| (index, node.clone()))
            .collect::<Vec<_>>();
        let mut result = String::new();
        for (index, node) in layers {
            let id = sid(&node, "id");
            let Some(bounds) = self.bounds.get(&id).cloned() else {
                continue;
            };
            if yes(&node, "hidden") {
                continue;
            }
            if self.on_canvas
                && (bounds.x >= number(self.document, "width", 0.0)
                    || bounds.y >= number(self.document, "height", 0.0)
                    || bounds.x + bounds.width <= 0.0
                    || bounds.y + bounds.height <= 0.0)
            {
                continue;
            }
            if node["type"] == "icon" {
                let (color, opacity) = colors::paint(&render::color(
                    self.document,
                    node.get("fill"),
                    render::fill(&node),
                ))
                .unwrap_or(("none".into(), 1.0));
                result.push_str(&self.take(format!("<g id=\"layer-{}\" opacity=\"{}\"><title>{}</title><svg x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" viewBox=\"0 0 24 24\" preserveAspectRatio=\"xMidYMid meet\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\" color=\"{}\">{}</svg></g>",xml(&id),n(number(&node,"opacity",1.0)*opacity),xml(node["name"].as_str().unwrap_or(&id)),n(bounds.x),n(bounds.y),n(bounds.width),n(bounds.height),xml(&color),n(number(&node,"strokeWidth",2.0)),xml(&color),data()["icons"][sid(&node,"icon")].as_str().unwrap()),Some(&node))?);
                continue;
            }
            let clip = format!("clip-{index}");
            let definition = self.take(
                format!(
                    "<clipPath id=\"{clip}\" clipPathUnits=\"userSpaceOnUse\"><{}/></clipPath>",
                    shape(&node, &bounds, 0.0)
                ),
                Some(&node),
            )?;
            self.definitions.push(definition);
            let stroke_width = if yes(&node, "stroke") {
                number(&node, "strokeWidth", 1.0)
                    .min(bounds.width)
                    .min(bounds.height)
            } else {
                0.0
            };
            let stroke = if stroke_width > 0.0 {
                format!(
                    " {} stroke-width=\"{}\"",
                    self.color("stroke", node.get("stroke"), "transparent"),
                    n(stroke_width)
                )
            } else {
                String::new()
            };
            let geometry = shape(&node, &bounds, stroke_width / 2.0);
            let content_clip = stroke_width > 0.0
                && ["frame", "text", "image"].contains(&node["type"].as_str().unwrap());
            if content_clip {
                let definition=self.take(format!("<clipPath id=\"{clip}-content\" clipPathUnits=\"userSpaceOnUse\"><{}/></clipPath>",shape(&node,&bounds,stroke_width)),Some(&node))?;
                self.definitions.push(definition);
            }
            let mut contents = if node["type"] == "text" {
                let text = self.text(&node, &bounds)?;
                self.clipped(text, &clip, content_clip, &node)?
            } else if node["type"] == "image" {
                let mut content = if yes(&node, "fill") || !yes(&node, "src") {
                    self.take(
                        format!(
                            "<{} {}/>",
                            shape(&node, &bounds, 0.0),
                            self.color("fill", node.get("fill"), render::fill(&node))
                        ),
                        Some(&node),
                    )?
                } else {
                    String::new()
                };
                if yes(&node, "src") {
                    let image=self.take(format!("<image x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" href=\"{}\" xlink:href=\"{}\" preserveAspectRatio=\"xMidYMid slice\"/>",n(bounds.x+stroke_width),n(bounds.y+stroke_width),n((bounds.width-2.0*stroke_width).max(0.0)),n((bounds.height-2.0*stroke_width).max(0.0)),xml(node["src"].as_str().unwrap()),xml(node["src"].as_str().unwrap())),Some(&node))?;
                    content.push_str(&self.clipped(image, &clip, content_clip, &node)?);
                }
                content
            } else {
                self.take(
                    format!(
                        "<{} {}/>",
                        shape(&node, &bounds, 0.0),
                        self.color("fill", node.get("fill"), render::fill(&node))
                    ),
                    Some(&node),
                )?
            };
            if !stroke.is_empty() {
                contents.push_str(
                    &self.take(format!("<{geometry} fill=\"none\"{stroke}/>"), Some(&node))?,
                );
            }
            if node["type"] == "frame" {
                let children = self.children(&id)?;
                contents.push_str(&self.clipped(children, &clip, content_clip, &node)?);
            }
            result.push_str(&self.take(format!("<g id=\"layer-{}\" opacity=\"{}\" clip-path=\"url(#{clip})\"><title>{}</title>",xml(&id),n(number(&node,"opacity",1.0)),xml(node["name"].as_str().unwrap_or(&id))),Some(&node))?);
            result.push_str(&contents);
            result.push_str(&self.take("</g>".into(), Some(&node))?);
        }
        Ok(result)
    }
}
/// Standalone SVG. Fonts embed by default; agent exports disable them explicitly.
pub fn render_svg(input: &Value, options: &Value) -> Result<String> {
    let document = validate_document(input)?;
    let mut renderer = Svg {
        bounds: layout(&document)?,
        document: &document,
        definitions: vec![],
        bytes: 0,
        limit: options["renderByteLimit"]
            .as_u64()
            .map(|n| n as usize)
            .unwrap_or(8 * 1024 * 1024)
            .min(8 * 1024 * 1024),
        on_canvas: options["onCanvasOnly"] == true,
    };
    let body = renderer.children("")?;
    let width = n(number(&document, "width", 0.0));
    let height = n(number(&document, "height", 0.0));
    let fonts = if options["embedFonts"] == false {
        String::new()
    } else {
        render::faces(&document)
    };
    let mut output=renderer.take(format!("<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\" overflow=\"hidden\">"),None)?;
    if !renderer.definitions.is_empty() || !fonts.is_empty() {
        output.push_str(&renderer.take("<defs>".into(), None)?);
        if !fonts.is_empty() {
            output.push_str(&renderer.take(format!("<style>{fonts}</style>"), None)?);
        }
        output.push_str(&renderer.definitions.join(""));
        output.push_str(&renderer.take("</defs>".into(), None)?);
    }
    output.push_str(&renderer.take(
        format!(
            "<rect x=\"0\" y=\"0\" width=\"{width}\" height=\"{height}\" {}/>",
            renderer.color("fill", document.get("background"), "#ffffff")
        ),
        None,
    )?);
    output.push_str(&body);
    output.push_str(&renderer.take("</svg>".into(), None)?);
    Ok(output)
}
