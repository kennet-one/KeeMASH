use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rand_core::{OsRng, RngCore};
use semver::Version;
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, FILETIME, HANDLE, WAIT_OBJECT_0};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const HELPER_FLAG: &str = "--keemash-update-helper";
const REQUEST_ID_BYTES: usize = 16;
const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const REMOTE_MANIFEST_URL: &str =
    "https://github.com/kennet-one/KeeMASH/releases/latest/download/latest.json";
const REMOTE_RELEASE_BASE: &str = "https://github.com/kennet-one/KeeMASH/releases/download";
const PARENT_WAIT_MS: u32 = 10 * 60 * 1_000;
#[cfg(windows)]
const PROCESS_SYNCHRONIZE: u32 = 0x0010_0000;
#[cfg(not(test))]
const UPDATE_PUBLIC_KEY_BASE64: &str = "ODS4uMg9E8/zl6xkw1rhSRVXK++rTVB55oRjRxeH52o=";

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUpdateManifest {
    pub schema_version: u8,
    pub version: String,
    pub published_at: String,
    pub installer: String,
    pub sha256: String,
    pub bytes: u64,
    pub channel: String,
    pub signature: String,
}

pub struct ValidatedLocalUpdate {
    pub manifest: LocalUpdateManifest,
    pub installer_path: PathBuf,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperRequest {
    request_id: String,
    parent_pid: u32,
    parent_created_100ns: u64,
    parent_exe: PathBuf,
    current_version: String,
    staged_installer: PathBuf,
    manifest: LocalUpdateManifest,
}

struct ProcessIdentity {
    created_100ns: u64,
    executable: PathBuf,
}

pub fn local_update_root() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
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

fn protected_update_root() -> Result<PathBuf, String> {
    let root = env::var("PROGRAMDATA")
        .map(PathBuf::from)
        .map(|value| value.join("KeeMASH/updates"))
        .map_err(|_| "PROGRAMDATA is unavailable".to_string())?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("Protected update directory creation failed: {error}"))?;
    harden_directory(&root)?;
    Ok(root)
}

#[cfg(windows)]
fn harden_directory(path: &Path) -> Result<(), String> {
    let system_root = env::var("WINDIR").map_err(|_| "WINDIR is unavailable".to_string())?;
    let status = Command::new(PathBuf::from(system_root).join("System32/icacls.exe"))
        .arg(path)
        .args([
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-18:(OI)(CI)F",
            "*S-1-5-32-544:(OI)(CI)F",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| format!("Protected update ACL setup failed: {error}"))?;
    if !status.success() {
        return Err(format!("Protected update ACL setup failed with {status}"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn harden_directory(_path: &Path) -> Result<(), String> {
    Ok(())
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

fn clean_manifest_field(name: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.chars().any(|character| character.is_control())
    {
        return Err(format!("Update manifest field {name} is invalid"));
    }
    Ok(())
}

pub fn manifest_signing_payload(manifest: &LocalUpdateManifest) -> Result<Vec<u8>, String> {
    clean_manifest_field("version", &manifest.version, 32)?;
    clean_manifest_field("publishedAt", &manifest.published_at, 64)?;
    clean_manifest_field("installer", &manifest.installer, 260)?;
    clean_manifest_field("sha256", &manifest.sha256, 64)?;
    clean_manifest_field("channel", &manifest.channel, 16)?;
    Ok(format!(
        "keemash-update-v2\nschema_version={}\nversion={}\npublished_at={}\ninstaller={}\nsha256={}\nbytes={}\nchannel={}\n",
        manifest.schema_version,
        manifest.version,
        manifest.published_at,
        manifest.installer,
        manifest.sha256.to_ascii_lowercase(),
        manifest.bytes,
        manifest.channel
    )
    .into_bytes())
}

fn update_public_key() -> Result<VerifyingKey, String> {
    #[cfg(test)]
    {
        use ed25519_dalek::SigningKey;
        Ok(SigningKey::from_bytes(&[7_u8; 32]).verifying_key())
    }
    #[cfg(not(test))]
    {
        let bytes: [u8; 32] = STANDARD
            .decode(UPDATE_PUBLIC_KEY_BASE64)
            .map_err(|error| format!("Embedded update public key is invalid: {error}"))?
            .try_into()
            .map_err(|_| "Embedded update public key has the wrong length".to_string())?;
        VerifyingKey::from_bytes(&bytes)
            .map_err(|error| format!("Embedded update public key is invalid: {error}"))
    }
}

fn verify_manifest_signature(manifest: &LocalUpdateManifest) -> Result<(), String> {
    let signature_bytes: [u8; 64] = STANDARD
        .decode(&manifest.signature)
        .map_err(|error| format!("Update signature is invalid base64: {error}"))?
        .try_into()
        .map_err(|_| "Update signature has the wrong length".to_string())?;
    update_public_key()?
        .verify(
            &manifest_signing_payload(manifest)?,
            &Signature::from_bytes(&signature_bytes),
        )
        .map_err(|_| "Update manifest signature verification failed".to_string())
}

fn validate_manifest(
    manifest: &LocalUpdateManifest,
    current_version: &str,
) -> Result<bool, String> {
    if manifest.schema_version != 2 {
        return Err("Unsupported update manifest schema".to_string());
    }
    if manifest.channel != "stable" {
        return Err("Only the stable update channel is accepted by this build".to_string());
    }
    if manifest.bytes == 0 || manifest.bytes > MAX_INSTALLER_BYTES {
        return Err("Update installer size is outside the allowed range".to_string());
    }
    if manifest.sha256.len() != 64 || !manifest.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Update SHA256 is invalid".to_string());
    }
    verify_manifest_signature(manifest)?;
    let current = Version::parse(current_version)
        .map_err(|error| format!("Current app version is invalid: {error}"))?;
    let available = Version::parse(&manifest.version)
        .map_err(|error| format!("Published update version is invalid: {error}"))?;
    Ok(available > current)
}

pub fn sync_remote_update(root: &Path, current_version: &str) -> Result<bool, String> {
    fs::create_dir_all(root).map_err(|error| format!("Update cache creation failed: {error}"))?;
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .user_agent(format!("KeeMASH/{current_version}"))
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Remote updater initialization failed: {error}"))?;
    let response = client
        .get(REMOTE_MANIFEST_URL)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Remote update manifest unavailable: {error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MANIFEST_BYTES)
    {
        return Err("Remote update manifest exceeds the 64 KiB limit".into());
    }
    let manifest_bytes = response
        .bytes()
        .map_err(|error| format!("Remote update manifest read failed: {error}"))?;
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Remote update manifest exceeds the 64 KiB limit".into());
    }
    let manifest: LocalUpdateManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("Remote update manifest JSON failed: {error}"))?;
    if !validate_manifest(&manifest, current_version)? {
        return Ok(false);
    }
    let relative = validated_relative_installer(&manifest.installer)?;
    let asset_name = relative
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Remote update installer name is invalid")?;
    if !asset_name
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("Remote update installer name contains unsupported characters".into());
    }
    let target = root.join(&relative);
    if target.is_file()
        && fs::metadata(&target).map(|metadata| metadata.len()).ok() == Some(manifest.bytes)
        && installer_sha256(&target)?.eq_ignore_ascii_case(&manifest.sha256)
    {
        publish_remote_manifest(root, &manifest_bytes)?;
        return Ok(true);
    }
    let parent = target
        .parent()
        .ok_or("Remote update installer path has no parent")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Remote update cache directory creation failed: {error}"))?;
    let temporary = parent.join(format!(".{asset_name}.{}.download", random_request_id()));
    let asset_url = format!("{REMOTE_RELEASE_BASE}/v{}/{asset_name}", manifest.version);
    let mut download = client
        .get(asset_url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Remote update installer unavailable: {error}"))?;
    if download
        .content_length()
        .is_some_and(|length| length != manifest.bytes)
    {
        return Err("Remote update Content-Length does not match signed manifest".into());
    }
    let result = download_installer(&mut download, &temporary, &manifest);
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    replace_file(&temporary, &target)
        .map_err(|error| format!("Remote update cache publication failed: {error}"))?;
    publish_remote_manifest(root, &manifest_bytes)?;
    Ok(true)
}

fn download_installer(
    input: &mut impl Read,
    destination: &Path,
    manifest: &LocalUpdateManifest,
) -> Result<(), String> {
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("Remote update cache create failed: {error}"))?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|error| format!("Remote update download failed: {error}"))?;
        if count == 0 {
            break;
        }
        total = total.saturating_add(count as u64);
        if total > manifest.bytes || total > MAX_INSTALLER_BYTES {
            return Err("Remote update download exceeded its signed size".into());
        }
        output
            .write_all(&buffer[..count])
            .map_err(|error| format!("Remote update cache write failed: {error}"))?;
        hasher.update(&buffer[..count]);
    }
    output
        .sync_all()
        .map_err(|error| format!("Remote update cache flush failed: {error}"))?;
    if total != manifest.bytes {
        return Err("Remote update size does not match signed manifest".into());
    }
    if !hex::encode(hasher.finalize()).eq_ignore_ascii_case(&manifest.sha256) {
        return Err("Remote update SHA256 does not match signed manifest".into());
    }
    Ok(())
}

fn publish_remote_manifest(root: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = root.join(format!("latest.{}.tmp", random_request_id()));
    let destination = root.join("latest.json");
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Remote manifest cache create failed: {error}"))?;
    output
        .write_all(bytes)
        .and_then(|_| output.sync_all())
        .map_err(|error| format!("Remote manifest cache write failed: {error}"))?;
    replace_file(&temporary, &destination)
        .map_err(|error| format!("Remote manifest cache publication failed: {error}"))
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(format!(
            "atomic replace failed with Win32 error {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(test)]
pub(crate) fn sign_manifest_for_test(manifest: &mut LocalUpdateManifest) {
    use ed25519_dalek::{Signer, SigningKey};
    let key = SigningKey::from_bytes(&[7_u8; 32]);
    manifest.signature = STANDARD.encode(
        key.sign(&manifest_signing_payload(manifest).expect("test manifest must be valid"))
            .to_bytes(),
    );
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
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err("Update manifest exceeds the 64 KiB limit".to_string());
    }
    let text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Update manifest read failed: {error}"))?;
    let manifest: LocalUpdateManifest = serde_json::from_str(&text)
        .map_err(|error| format!("Update manifest JSON failed: {error}"))?;
    if !validate_manifest(&manifest, current_version)? {
        return Ok(None);
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

fn random_request_id() -> String {
    let mut bytes = [0_u8; REQUEST_ID_BYTES];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn launch_update_helper(
    current_version: &str,
    installed_exe: &Path,
    update: &ValidatedLocalUpdate,
) -> Result<(), String> {
    let protected = protected_update_root()?;
    let requests = protected.join("requests");
    let staging = protected.join("staging");
    fs::create_dir_all(&requests)
        .and_then(|_| fs::create_dir_all(&staging))
        .map_err(|error| format!("Update staging creation failed: {error}"))?;
    let request_id = random_request_id();
    let request_stage = staging.join(&request_id);
    fs::create_dir(&request_stage)
        .map_err(|error| format!("Update request staging failed: {error}"))?;
    let staged_installer = request_stage.join("installer.exe");
    copy_new(&update.installer_path, &staged_installer)?;
    let staged_hash = installer_sha256(&staged_installer)?;
    if !staged_hash.eq_ignore_ascii_case(&update.manifest.sha256) {
        return Err("Staged installer SHA256 does not match signed manifest".into());
    }
    let parent_pid = std::process::id();
    let parent = process_identity(parent_pid)?;
    let installed_exe = installed_exe
        .canonicalize()
        .map_err(|error| format!("Current executable validation failed: {error}"))?;
    if parent.executable != installed_exe {
        return Err("Current process identity changed before updater launch".into());
    }
    let request = HelperRequest {
        request_id: request_id.clone(),
        parent_pid,
        parent_created_100ns: parent.created_100ns,
        parent_exe: installed_exe.clone(),
        current_version: current_version.to_string(),
        staged_installer,
        manifest: update.manifest.clone(),
    };
    let request_path = requests.join(format!("{request_id}.json"));
    write_new_json(&request_path, &request)?;

    let mut command = Command::new(&installed_exe);
    command
        .arg(HELPER_FLAG)
        .arg(&request_id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    if let Err(error) = command.spawn() {
        let _ = fs::remove_file(&request_path);
        return Err(format!("Update helper launch failed: {error}"));
    }
    Ok(())
}

fn copy_new(source: &Path, destination: &Path) -> Result<(), String> {
    let mut input =
        fs::File::open(source).map_err(|error| format!("Update source open failed: {error}"))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("Update staging create failed: {error}"))?;
    std::io::copy(&mut input, &mut output)
        .map_err(|error| format!("Update staging copy failed: {error}"))?;
    output
        .sync_all()
        .map_err(|error| format!("Update staging flush failed: {error}"))
}

fn write_new_json(path: &Path, value: &impl serde::Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Update request create failed: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Update request write failed: {error}"))
}

pub fn maybe_run_update_helper() -> Option<i32> {
    let args: Vec<_> = env::args_os().collect();
    if args.get(1).and_then(|value| value.to_str()) != Some(HELPER_FLAG) {
        return None;
    }
    let request_id = match args.get(2).and_then(|value| value.to_str()) {
        Some(value)
            if args.len() == 3
                && value.len() == REQUEST_ID_BYTES * 2
                && value.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
        {
            value.to_ascii_lowercase()
        }
        _ => return Some(2),
    };
    Some(run_update_helper(&request_id))
}

fn run_update_helper(request_id: &str) -> i32 {
    let protected = match protected_update_root() {
        Ok(value) => value,
        Err(_) => return 3,
    };
    let request_path = protected
        .join("requests")
        .join(format!("{request_id}.json"));
    let claimed_path = protected
        .join("requests")
        .join(format!("{request_id}.claimed"));
    if fs::rename(&request_path, &claimed_path).is_err() {
        return 4;
    }
    let request = match read_request(&claimed_path, request_id) {
        Ok(value) => value,
        Err(error) => {
            let _ = append_update_log(&protected, &error);
            return 5;
        }
    };
    if let Err(error) = wait_for_verified_parent(&request) {
        let _ = append_update_log(&protected, &error);
        return 6;
    }
    let installer_guard = match validate_staged_update(&protected, &request) {
        Ok(file) => file,
        Err(error) => {
            let _ = append_update_log(&protected, &error);
            return 7;
        }
    };
    let status = match Command::new(&request.staged_installer).arg("/S").status() {
        Ok(status) => status,
        Err(error) => {
            let _ = append_update_log(&protected, &format!("installer launch failed: {error}"));
            return 8;
        }
    };
    drop(installer_guard);
    if !status.success() {
        let _ = append_update_log(&protected, &format!("installer exit status={status}"));
        return status.code().unwrap_or(9);
    }
    let _ = fs::remove_file(&claimed_path);
    let _ = fs::remove_dir_all(request.staged_installer.parent().unwrap_or(&protected));
    if let Some(path) = find_installed_executable() {
        if Command::new(&path).spawn().is_ok() {
            return 0;
        }
    }
    10
}

fn read_request(path: &Path, request_id: &str) -> Result<HelperRequest, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Update request missing: {error}"))?;
    if metadata.len() > 64 * 1024 {
        return Err("Update request exceeds size limit".into());
    }
    let request: HelperRequest = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("Update request read failed: {error}"))?,
    )
    .map_err(|error| format!("Update request JSON failed: {error}"))?;
    if request.request_id != request_id {
        return Err("Update request ID mismatch".into());
    }
    Ok(request)
}

fn validate_staged_update(root: &Path, request: &HelperRequest) -> Result<std::fs::File, String> {
    if request.manifest.schema_version != 2 || request.manifest.channel != "stable" {
        return Err("Staged update manifest policy is invalid".into());
    }
    if request.manifest.bytes == 0 || request.manifest.bytes > MAX_INSTALLER_BYTES {
        return Err("Staged installer size is outside the allowed range".into());
    }
    if request.manifest.sha256.len() != 64
        || !request
            .manifest
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Staged installer SHA256 is invalid".into());
    }
    verify_manifest_signature(&request.manifest)?;
    let current = Version::parse(&request.current_version)
        .map_err(|error| format!("Current version is invalid: {error}"))?;
    let update = Version::parse(&request.manifest.version)
        .map_err(|error| format!("Staged update version is invalid: {error}"))?;
    if update <= current {
        return Err("Staged update is not newer than the running version".into());
    }
    let staged = request
        .staged_installer
        .canonicalize()
        .map_err(|error| format!("Staged installer validation failed: {error}"))?;
    let staging_root = root
        .join("staging")
        .canonicalize()
        .map_err(|error| format!("Staging root validation failed: {error}"))?;
    let expected = staging_root
        .join(&request.request_id)
        .join("installer.exe")
        .canonicalize()
        .map_err(|error| format!("Expected staged installer validation failed: {error}"))?;
    if staged != expected || !staged.starts_with(&staging_root) {
        return Err("Staged installer escaped its protected directory".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.share_mode(0x0000_0001);
    let mut installer = options
        .open(&staged)
        .map_err(|error| format!("Staged installer lock failed: {error}"))?;
    let metadata = installer
        .metadata()
        .map_err(|error| format!("Staged installer metadata failed: {error}"))?;
    if !metadata.is_file() || metadata.len() != request.manifest.bytes {
        return Err("Staged installer size does not match signed manifest".into());
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = installer
            .read(&mut buffer)
            .map_err(|error| format!("Staged installer hash failed: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let hash = hex::encode(hasher.finalize());
    if !hash.eq_ignore_ascii_case(&request.manifest.sha256) {
        return Err("Staged installer SHA256 does not match signed manifest".into());
    }
    Ok(installer)
}

#[cfg(windows)]
fn process_identity(pid: u32) -> Result<ProcessIdentity, String> {
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        );
        if handle.is_null() {
            return Err(format!("Unable to open parent process {pid}"));
        }
        let identity = process_identity_from_handle(handle);
        CloseHandle(handle);
        identity
    }
}

#[cfg(windows)]
unsafe fn process_identity_from_handle(handle: HANDLE) -> Result<ProcessIdentity, String> {
    unsafe {
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = creation;
        let mut kernel = creation;
        let mut user = creation;
        if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) == 0 {
            return Err("Unable to read parent process creation time".into());
        }
        let mut path = vec![0_u16; 32_768];
        let mut length = path.len() as u32;
        if QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut length) == 0 {
            return Err("Unable to read parent process executable".into());
        }
        path.truncate(length as usize);
        Ok(ProcessIdentity {
            created_100ns: ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64,
            executable: PathBuf::from(String::from_utf16_lossy(&path)),
        })
    }
}

#[cfg(not(windows))]
fn process_identity(_pid: u32) -> Result<ProcessIdentity, String> {
    Err("Update helper is supported only on Windows".into())
}

#[cfg(windows)]
fn wait_for_verified_parent(request: &HelperRequest) -> Result<(), String> {
    unsafe {
        let handle = OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            request.parent_pid,
        );
        if handle.is_null() {
            return Err("Update helper could not open parent handle".into());
        }
        let identity = match process_identity_from_handle(handle) {
            Ok(identity) => identity,
            Err(error) => {
                CloseHandle(handle);
                return Err(error);
            }
        };
        if identity.created_100ns != request.parent_created_100ns
            || !same_canonical_path(&identity.executable, &request.parent_exe)
        {
            CloseHandle(handle);
            return Err("Update helper parent identity mismatch".into());
        }
        let result = WaitForSingleObject(handle, PARENT_WAIT_MS);
        CloseHandle(handle);
        if result != WAIT_OBJECT_0 {
            return Err("Update helper timed out waiting for the parent process".into());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn wait_for_verified_parent(_request: &HelperRequest) -> Result<(), String> {
    Err("Update helper is supported only on Windows".into())
}

fn same_canonical_path(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

fn find_installed_executable() -> Option<PathBuf> {
    let root = env::var_os("ProgramFiles").map(PathBuf::from)?;
    ["keemash-desktop.exe", "KeeMASH.exe"]
        .into_iter()
        .map(|name| root.join("KeeMASH").join(name))
        .find(|path| path.is_file())
}

fn append_update_log(root: &Path, message: &str) -> Result<(), String> {
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
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn signed_manifest() -> LocalUpdateManifest {
        let mut manifest = LocalUpdateManifest {
            schema_version: 2,
            version: "0.10.0".into(),
            published_at: "2026-08-09T00:00:00Z".into(),
            installer: "0.10.0/KeeMASH_0.10.0_setup.exe".into(),
            sha256: "ab".repeat(32),
            bytes: 123,
            channel: "stable".into(),
            signature: String::new(),
        };
        sign_test_manifest(&mut manifest);
        manifest
    }

    fn sign_test_manifest(manifest: &mut LocalUpdateManifest) {
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        manifest.signature = STANDARD.encode(
            key.sign(&manifest_signing_payload(manifest).unwrap())
                .to_bytes(),
        );
    }

    #[test]
    fn accepts_signed_manifest_and_rejects_tampering() {
        let mut manifest = signed_manifest();
        assert!(verify_manifest_signature(&manifest).is_ok());
        manifest.bytes += 1;
        assert!(verify_manifest_signature(&manifest).is_err());
    }

    #[test]
    fn rejects_manifest_path_traversal_and_control_characters() {
        assert!(validated_relative_installer("../outside.exe").is_err());
        let mut manifest = signed_manifest();
        manifest.version = "0.10.0\nforged".into();
        assert!(manifest_signing_payload(&manifest).is_err());
    }

    #[test]
    fn validates_versions_and_streams_only_the_signed_installer() {
        let root = std::env::temp_dir().join(format!("keemash-download-{}", random_request_id()));
        fs::create_dir_all(&root).unwrap();
        let destination = root.join("installer.download");
        let fixture = b"remote signed installer fixture";
        let mut manifest = signed_manifest();
        manifest.version = "0.10.3".into();
        manifest.bytes = fixture.len() as u64;
        manifest.sha256 = hex::encode(Sha256::digest(fixture));
        sign_test_manifest(&mut manifest);

        assert!(validate_manifest(&manifest, "0.10.2").unwrap());
        assert!(!validate_manifest(&manifest, "0.10.3").unwrap());
        download_installer(&mut std::io::Cursor::new(fixture), &destination, &manifest).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), fixture);

        let invalid = root.join("invalid.download");
        assert!(download_installer(
            &mut std::io::Cursor::new(b"tampered installer"),
            &invalid,
            &manifest
        )
        .is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn atomically_replaces_the_cached_manifest() {
        let root = std::env::temp_dir().join(format!("keemash-manifest-{}", random_request_id()));
        fs::create_dir_all(&root).unwrap();
        publish_remote_manifest(&root, br#"{"version":"first"}"#).unwrap();
        publish_remote_manifest(&root, br#"{"version":"second"}"#).unwrap();
        assert_eq!(
            fs::read(root.join("latest.json")).unwrap(),
            br#"{"version":"second"}"#
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn helper_accepts_only_fixed_length_random_request_ids() {
        let good = [
            std::ffi::OsString::from("keemash"),
            std::ffi::OsString::from(HELPER_FLAG),
            std::ffi::OsString::from("00112233445566778899aabbccddeeff"),
        ];
        assert_eq!(good.len(), 3);
        assert!(good[2]
            .to_str()
            .unwrap()
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(random_request_id(), random_request_id());
    }

    #[test]
    fn staged_update_rejects_swapped_truncated_and_escaped_installers() {
        let request_id = "00112233445566778899aabbccddeeff";
        let root =
            std::env::temp_dir().join(format!("keemash-update-test-{}", random_request_id()));
        let stage = root.join("staging").join(request_id);
        fs::create_dir_all(&stage).unwrap();
        let installer = stage.join("installer.exe");
        fs::write(&installer, b"signed installer fixture").unwrap();

        let mut manifest = signed_manifest();
        manifest.bytes = fs::metadata(&installer).unwrap().len();
        manifest.sha256 = installer_sha256(&installer).unwrap();
        sign_test_manifest(&mut manifest);
        let mut request = HelperRequest {
            request_id: request_id.into(),
            parent_pid: 1,
            parent_created_100ns: 1,
            parent_exe: PathBuf::from(r"C:\Program Files\KeeMASH\KeeMASH.exe"),
            current_version: "0.9.0".into(),
            staged_installer: installer.clone(),
            manifest: manifest.clone(),
        };
        assert!(validate_staged_update(&root, &request).is_ok());

        fs::write(&installer, b"swapped installer fixture").unwrap();
        request.manifest.bytes = fs::metadata(&installer).unwrap().len();
        sign_test_manifest(&mut request.manifest);
        assert!(validate_staged_update(&root, &request)
            .unwrap_err()
            .contains("SHA256"));

        fs::write(&installer, b"signed installer fixture").unwrap();
        request.manifest = manifest.clone();
        request.manifest.bytes += 1;
        sign_test_manifest(&mut request.manifest);
        assert!(validate_staged_update(&root, &request)
            .unwrap_err()
            .contains("size"));

        let outside = root.join("installer.exe");
        fs::write(&outside, b"signed installer fixture").unwrap();
        request.manifest = manifest;
        request.staged_installer = outside;
        assert!(validate_staged_update(&root, &request)
            .unwrap_err()
            .contains("escaped"));

        let _ = fs::remove_dir_all(&root);
    }
}
