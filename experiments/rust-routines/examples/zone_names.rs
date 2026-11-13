fn main() {
    println!(
        "{}",
        serde_json::json!({"version":jiff_tzdb::VERSION,"names":jiff_tzdb::available().collect::<Vec<_>>()})
    );
}
