//! After `packages/shared/src/tokens.mjs`.

use crate::logic::copy::js;

/// `formatTokens`: a token count the way model windows are named: 366k, 1M, 1.5M.
pub fn format_tokens(tokens: f64) -> String {
    let thousands = js::round(tokens / 1000.0);
    if thousands < 1.0 {
        return js::number_string(js::round(tokens));
    }
    if thousands < 1000.0 {
        return format!("{}k", js::number_string(thousands));
    }
    format!("{}M", js::number_string(js::round(tokens / 100_000.0) / 10.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_read_like_model_windows() {
        assert_eq!(format_tokens(0.0), "0");
        assert_eq!(format_tokens(499.0), "499");
        assert_eq!(format_tokens(500.0), "1k");
        assert_eq!(format_tokens(1000.0), "1k");
        assert_eq!(format_tokens(366_000.0), "366k");
        assert_eq!(format_tokens(200_000.0), "200k");
        assert_eq!(format_tokens(999_499.0), "999k");
        assert_eq!(format_tokens(1_000_000.0), "1M");
        assert_eq!(format_tokens(1_500_000.0), "1.5M");
        assert_eq!(format_tokens(2_000_000.0), "2M");
    }
}
