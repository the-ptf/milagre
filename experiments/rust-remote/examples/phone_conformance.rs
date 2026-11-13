#[path = "../tests/phone_support/mod.rs"]
mod phone_support;
fn main() {
    println!("{}", phone_support::output());
}
