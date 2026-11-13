#![deny(unsafe_code)]
// Only the measurement allocator forwards unsafe System allocation calls.
#[allow(unsafe_code)]
mod meter;
mod owner;
mod suite;
mod transport;

fn main() {
    suite::run();
}

#[cfg(test)]
mod tests {
    #[test]
    fn offline_parser_allocation_and_join_evidence() {
        crate::suite::run();
    }
}
