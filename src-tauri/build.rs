fn main() {
    // The installer packs the phone app from build/mobile (placed there by CI). The folder may be empty locally.
    let _ = std::fs::create_dir_all("../build/mobile");
    tauri_build::build()
}
