//! Real copied services only. This target does not import the native core.
#![cfg(target_os = "macos")]
mod service_owner;

#[cfg(test)]
mod tests;
