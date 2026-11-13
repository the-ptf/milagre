//! Packaged helper entry point used only by explicit native raster callers.
fn main() {
    if milagre_content_store::design::raster::helper_main().is_err() {
        eprintln!("Design renderer failed.");
        std::process::exit(1);
    }
}
