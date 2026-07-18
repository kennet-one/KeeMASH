use semver::Version;
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

const HELPER_FLAG: &str = "--keemash-update-helper";
const PARENT_RELEASE_DELAY: Duration = Duration::from_secs(2);

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUpdateManifest {
    pub schema_version: u8,
    pub version: String,
    pub published_at: String,
    pub installer: String,
    pub sha256: String,
    pub bytes: u64,
}

pub struct ValidatedLocalUpdate {
    pub manifest: LocalUpdateManifest,
    pub installer_path: PathBuf,
}

struct HelperRequest {
    parent_pid: u32,
    current_version: String,
    installed_exe: PathBuf,
    update_root: PathBuf,
}

pub fn local_update_root() -> Result<PathBuf, String> {
    if let Ok(explicit) = env::var("KEEMASH_UPDATE_ROOT") {
        if !explicit.trim().is_empty() {
            return Ok(PathBuf::from(explicit));
        }
    }
    env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("KeeMASH/updates"))
        .map_err(|_| "LOCALAPPDATA is unavailable".to_string())
}

fn validated_relative_installer(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.extension().and_then(|value| value.to_str()) != Some("exe")
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Update installer path must be a relative .exe path".to_string());
    }
    Ok(path.to_path_buf())
}

pub fn resolve_local_update(
    root: &Path,
    current_version: &str,
) -> Result<Option<ValidatedLocalUpdate>, String> {
    let manifest_path = root.join("latest.json");
    if !manifest_path.is_file() {
        return Ok(None);
    }
    let metadata = fs::metadata(&manifest_path)
        .map_err(|error| format!("Update manifest metadata failed: {error}"))?;
    if metadata.len() > 64 * 1024 {
        return Err("Update manifest exceeds the 64 KiB limit".to_string());
    }
    let text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Update manifest read failed: {error}"))?;
    let manifest: LocalUpdateManifest = serde_json::from_str(&text)
        .map_err(|error| format!("Update manifest JSON failed: {error}"))?;
    if manifest.schema_version != 1 {
        return Err("Unsupported update manifest schema".to_string());
    }
    let current = Version::parse(current_version)
        .map_err(|error| format!("Current app version is invalid: {error}"))?;
    let available = Version::parse(&manifest.version)
        .map_err(|error| format!("Published update version is invalid: {error}"))?;
    if available <= current {
        return Ok(None);
    }
    if manifest.sha256.len() != 64 || !manifest.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Update SHA256 is invalid".to_string());
    }
    let relative = validated_relative_installer(&manifest.installer)?;
    let installer_path = root.join(relative);
    let installer_metadata = fs::metadata(&installer_path)
        .map_err(|error| format!("Published installer is unavailable: {error}"))?;
    if !installer_metadata.is_file() || installer_metadata.len() != manifest.bytes {
        return Err("Published installer size does not match its manifest".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Update root validation failed: {error}"))?;
    let canonical_installer = installer_path
        .canonicalize()
        .map_err(|error| format!("Installer path validation failed: {error}"))?;
    if !canonical_installer.starts_with(&canonical_root) {
        return Err("Published installer resolves outside the update root".to_string());
    }
    Ok(Some(ValidatedLocalUpdate {
        manifest,
        installer_path: canonical_installer,
    }))
}

pub fn installer_sha256(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| format!("Installer open failed: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("Installer hash read failed: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn launch_update_helper(current_version: &str, installed_exe: &Path) -> Result<(), String> {
    let root = local_update_root()?;
    let runtime = root.join("runtime");
    fs::create_dir_all(&runtime)
        .map_err(|error| format!("Update helper directory creation failed: {error}"))?;
    let helper_path = runtime.join(format!("keemash-update-helper-{}.exe", std::process::id()));
    fs::copy(installed_exe, &helper_path)
        .map_err(|error| format!("Update helper copy failed: {error}"))?;

    let mut command = Command::new(&helper_path);
    command
        .arg(HELPER_FLAG)
        .arg(std::process::id().to_string())
        .arg(current_version)
        .arg(installed_exe)
        .arg(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    command
        .spawn()
        .map_err(|error| format!("Update helper launch failed: {error}"))?;
    Ok(())
}

pub fn maybe_run_update_helper() -> Option<i32> {
    let args: Vec<_> = env::args_os().collect();
    if args.get(1).and_then(|value| value.to_str()) != Some(HELPER_FLAG) {
        return None;
    }
    let request = match parse_helper_request(&args) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("Update helper arguments rejected: {error}");
            return Some(2);
        }
    };
    Some(run_update_helper(request))
}

fn parse_helper_request(args: &[std::ffi::OsString]) -> Result<HelperRequest, String> {
    if args.len() != 6 {
        return Err(
            "expected parent PID, current version, installed executable, and update root"
                .to_string(),
        );
    }
    let parent_pid = args[2]
        .to_str()
        .ok_or("parent PID is not UTF-8")?
        .parse::<u32>()
        .map_err(|error| format!("parent PID is invalid: {error}"))?;
    if parent_pid == 0 {
        return Err("parent PID must be positive".to_string());
    }
    let current_version = args[3]
        .to_str()
        .ok_or("current version is not UTF-8")?
        .to_string();
    Version::parse(&current_version)
        .map_err(|error| format!("current version is invalid: {error}"))?;
    let installed_exe = PathBuf::from(&args[4]);
    if installed_exe.file_name().and_then(|value| value.to_str()) != Some("keemash-desktop.exe") {
        return Err("installed executable name is not KeeMASH".to_string());
    }
    let update_root = PathBuf::from(&args[5]);
    if !update_root.is_dir() {
        return Err("update root is not an existing directory".to_string());
    }
    Ok(HelperRequest {
        parent_pid,
        current_version,
        installed_exe,
        update_root,
    })
}

fn run_update_helper(request: HelperRequest) -> i32 {
    if let Err(error) = append_update_log(
        &request.update_root,
        &format!(
            "helper started for parent={} current={}",
            request.parent_pid, request.current_version
        ),
    ) {
        eprintln!("{error}");
    }

    wait_for_parent_release(PARENT_RELEASE_DELAY);
    let _ = append_update_log(&request.update_root, "parent release delay completed");

    let update = match resolve_local_update(&request.update_root, &request.current_version) {
        Ok(Some(update)) => update,
        Ok(None) => {
            let _ = append_update_log(&request.update_root, "no newer verified build is available");
            return 5;
        }
        Err(error) => {
            let _ = append_update_log(
                &request.update_root,
                &format!("update validation failed: {error}"),
            );
            return 6;
        }
    };
    let hash = match installer_sha256(&update.installer_path) {
        Ok(hash) => hash,
        Err(error) => {
            let _ = append_update_log(&request.update_root, &error);
            return 7;
        }
    };
    if !hash.eq_ignore_ascii_case(&update.manifest.sha256) {
        let _ = append_update_log(
            &request.update_root,
            "installer SHA256 changed after helper launch",
        );
        return 8;
    }

    let _ = append_update_log(
        &request.update_root,
        &format!(
            "launching verified installer version={} sha256={}",
            update.manifest.version, hash
        ),
    );
    let status = match Command::new(&update.installer_path).arg("/S").status() {
        Ok(status) => status,
        Err(error) => {
            let _ = append_update_log(
                &request.update_root,
                &format!("installer launch failed: {error}"),
            );
            return 9;
        }
    };
    let _ = append_update_log(
        &request.update_root,
        &format!("installer exit status={status}"),
    );
    if !status.success() {
        return status.code().unwrap_or(10);
    }

    if !request.installed_exe.is_file() {
        let _ = append_update_log(
            &request.update_root,
            "installed KeeMASH executable is missing after installer success",
        );
        return 11;
    }
    match Command::new(&request.installed_exe).spawn() {
        Ok(_) => {
            let _ = append_update_log(&request.update_root, "updated KeeMASH relaunched");
            0
        }
        Err(error) => {
            let _ = append_update_log(
                &request.update_root,
                &format!("KeeMASH relaunch failed: {error}"),
            );
            12
        }
    }
}

fn wait_for_parent_release(delay: Duration) {
    thread::sleep(delay);
}

fn append_update_log(root: &Path, message: &str) -> Result<(), String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("Update log directory creation failed: {error}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("update.log"))
        .map_err(|error| format!("Update log open failed: {error}"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    writeln!(file, "{timestamp} {message}")
        .map_err(|error| format!("Update log write failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{parse_helper_request, wait_for_parent_release};
    use std::ffi::OsString;
    use std::time::Duration;

    #[test]
    fn helper_arguments_reject_missing_or_wrong_executable() {
        assert!(parse_helper_request(&[OsString::from("keemash")]).is_err());
        let wrong = [
            OsString::from("keemash"),
            OsString::from("--keemash-update-helper"),
            OsString::from("123"),
            OsString::from("0.3.1"),
            OsString::from("not-keemash.exe"),
            OsString::from("."),
        ];
        assert!(parse_helper_request(&wrong).is_err());
    }

    #[test]
    fn helper_arguments_accept_valid_internal_request() {
        let args = [
            OsString::from("keemash"),
            OsString::from("--keemash-update-helper"),
            OsString::from("123"),
            OsString::from("0.3.1"),
            OsString::from(r"C:\Users\test\KeeMASH\keemash-desktop.exe"),
            OsString::from("."),
        ];
        let request = parse_helper_request(&args).unwrap();
        assert_eq!(request.parent_pid, 123);
        assert_eq!(request.current_version, "0.3.1");
    }

    #[test]
    fn parent_release_delay_completes() {
        wait_for_parent_release(Duration::from_millis(1));
    }
}
