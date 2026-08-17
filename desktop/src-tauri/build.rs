fn main() {
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "runtime_bootstrap",
        "runtime_apply_action",
        "runtime_history",
        "runtime_dispatch",
        "graphics_runtime_status",
        "admin_graphics_set_master",
        "admin_graphics_restart",
        "admin_gpu_set_process_policy",
        "admin_gpu_undo_process_policy",
        "admin_gpu_remove_rule",
        "admin_process_close",
        "admin_process_terminate",
        "admin_process_terminate_tree",
        "admin_ccc_start",
        "admin_ccc_stop",
        "admin_ccc_restart",
        "admin_memory_test_start",
        "admin_memory_test_stop",
        "admin_memory_diagnostic_open",
        "admin_update_install",
        "admin_system_reboot_to_firmware",
        "admin_system_restart",
        "admin_system_shutdown",
        "admin_system_cancel_power",
        "frontend_ready",
    ]);
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        let windows = tauri_build::WindowsAttributes::new()
            .app_manifest(include_str!("windows-app-manifest.xml"));
        let attributes = tauri_build::Attributes::new()
            .app_manifest(app_manifest)
            .windows_attributes(windows);
        tauri_build::try_build(attributes).expect("failed to build KeeMASH desktop resources");
    } else {
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app_manifest))
            .expect("failed to build KeeMASH desktop resources");
    }
}
