fn main() {
    if milagre_content_store::design::raster::helper_main().is_err() {
        // Never log the request, document, image bytes or local paths.
        eprintln!("Design renderer failed.");
        std::process::exit(1);
    }
}
