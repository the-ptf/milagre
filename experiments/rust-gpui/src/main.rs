//! Milagre's GPUI desktop app. Startup lives in `app.rs` (library) so tests and tools can share it.

fn main() {
    milagre_gpui_spike::app::run();
}
