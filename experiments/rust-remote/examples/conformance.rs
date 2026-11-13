// Emits synthetic fixtures on stdout. No sockets, profiles, credentials or filesystem writes.
#[path = "../tests/support/mod.rs"]
mod support;
fn main() {
    println!("{}", support::output());
}
