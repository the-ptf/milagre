use crate::{Error, Result, MAX_INPUT_BYTES};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cron {
    fields: [Vec<u8>; 5],
}
impl Cron {
    pub fn minute(&self) -> &[u8] {
        &self.fields[0]
    }
    pub fn hour(&self) -> &[u8] {
        &self.fields[1]
    }
    pub fn day_of_month(&self) -> &[u8] {
        &self.fields[2]
    }
    pub fn month(&self) -> &[u8] {
        &self.fields[3]
    }
    pub fn day_of_week(&self) -> &[u8] {
        &self.fields[4]
    }
}
#[derive(Clone, Copy)]
struct Spec {
    name: &'static str,
    min: u8,
    max: u8,
}
const FIELDS: [Spec; 5] = [
    Spec {
        name: "minute",
        min: 0,
        max: 59,
    },
    Spec {
        name: "hour",
        min: 0,
        max: 23,
    },
    Spec {
        name: "dayOfMonth",
        min: 1,
        max: 31,
    },
    Spec {
        name: "month",
        min: 1,
        max: 12,
    },
    Spec {
        name: "dayOfWeek",
        min: 0,
        max: 7,
    },
];
fn invalid(reason: String) -> Error {
    Error::InvalidCron(reason)
}
fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}
fn number(text: &str) -> f64 {
    text.parse().unwrap_or(f64::INFINITY)
}
fn parse_number(text: &str, field: Spec) -> Result<u8> {
    if !digits(text) {
        return Err(invalid(format!("{} has \"{text}\"", field.name)));
    }
    let value = number(text);
    if value < f64::from(field.min) || value > f64::from(field.max) {
        return Err(invalid(format!(
            "{} {} is outside {}-{}",
            field.name,
            ryu_js::Buffer::new().format(value),
            field.min,
            field.max
        )));
    }
    Ok(value as u8)
}
fn parse_field(text: &str, field: Spec) -> Result<Vec<u8>> {
    let mut values = Vec::with_capacity(usize::from(field.max - field.min + 1));
    for part in text.split(',') {
        let mut pieces = part.split('/');
        let range = pieces.next().unwrap_or_default();
        let step = pieces.next();
        if pieces.next().is_some() || range.is_empty() {
            return Err(invalid(format!("{} has \"{part}\"", field.name)));
        }
        let stride = if let Some(step) = step {
            if !digits(step) || number(step) < 1.0 {
                return Err(invalid(format!("{} step \"{step}\"", field.name)));
            }
            number(step)
        } else {
            1.0
        };
        let (from, to) = if range == "*" {
            (field.min, field.max)
        } else if range.contains('-') {
            let mut pair = range.split('-');
            let low = pair.next().unwrap_or_default();
            let high = pair.next().unwrap_or_default();
            if pair.next().is_some() {
                return Err(invalid(format!("{} has \"{part}\"", field.name)));
            }
            let from = parse_number(low, field)?;
            let to = parse_number(high, field)?;
            if from > to {
                return Err(invalid(format!(
                    "{} range \"{range}\" runs backwards",
                    field.name
                )));
            }
            (from, to)
        } else {
            if step.is_some() {
                return Err(invalid(format!(
                    "{} step needs a range, got \"{part}\"",
                    field.name
                )));
            }
            let value = parse_number(range, field)?;
            (value, value)
        };
        let mut value = from;
        loop {
            if !values.contains(&value) {
                values.push(value);
            }
            // JS Number accepts arbitrarily large positive strides, including Infinity.
            // Such a stride contributes only `from`; never narrow it before this check.
            if stride > f64::from(to - value) {
                break;
            }
            value += stride as u8;
        }
    }
    Ok(values)
}
fn whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
/// Expands five fields into bounded insertion-ordered sets, matching JS Set order.
pub fn parse_cron(expression: &str) -> Result<Cron> {
    if expression.len() > MAX_INPUT_BYTES {
        return Err(Error::Bounds("cron input exceeds 4096 bytes"));
    }
    let parts: Vec<_> = expression
        .split(whitespace)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() != 5 {
        return Err(invalid(format!("expected 5 fields, got {}", parts.len())));
    }
    let mut fields: [Vec<u8>; 5] = std::array::from_fn(|_| Vec::new());
    for ((output, text), spec) in fields.iter_mut().zip(parts).zip(FIELDS) {
        *output = parse_field(text, spec)?;
    }
    if let Some(index) = fields[4].iter().position(|v| *v == 7) {
        fields[4].remove(index);
        if !fields[4].contains(&0) {
            fields[4].push(0);
        }
    }
    Ok(Cron { fields })
}
/// Converts only fixed minute/hour cadences that divide the containing hour/day.
pub fn every_to_cron(every: &str) -> Result<String> {
    if every.len() > MAX_INPUT_BYTES {
        return Err(Error::Bounds("every input exceeds 4096 bytes"));
    }
    let amount_text = every
        .get(..every.len().saturating_sub(1))
        .unwrap_or_default();
    let mut unit = every.as_bytes().last().copied().unwrap_or_default();
    if !digits(amount_text) || amount_text.starts_with('0') || !matches!(unit, b'm' | b'h') {
        return Err(Error::InvalidEvery(every.to_owned()));
    }
    let mut amount = number(amount_text);
    if unit == b'm' && amount >= 60.0 && amount % 60.0 == 0.0 {
        amount /= 60.0;
        unit = b'h';
    }
    if unit == b'm' {
        if ![1., 2., 3., 4., 5., 6., 10., 12., 15., 20., 30.].contains(&amount) {
            return Err(Error::MinutesRule);
        }
        return Ok(format!("*/{} * * * *", amount as u8));
    }
    if ![1., 2., 3., 4., 6., 8., 12., 24.].contains(&amount) {
        return Err(Error::HoursRule);
    }
    Ok(if amount == 24.0 {
        "0 0 * * *".into()
    } else {
        format!("0 */{} * * *", amount as u8)
    })
}
