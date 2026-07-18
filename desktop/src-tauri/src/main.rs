fn main() {
    if let Some(exit_code) = keemash_desktop_lib::maybe_run_update_helper() {
        std::process::exit(exit_code);
    }
    keemash_desktop_lib::run();
}
