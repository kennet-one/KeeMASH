use crate::serial_service::SerialService;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use btleplug::api::{
    Central, Characteristic, Manager as _, Peripheral as _, ScanFilter, ValueNotification,
    WriteType,
};
use btleplug::platform::{Manager as BleManager, Peripheral as BlePeripheral};
use futures_util::{SinkExt, Stream, StreamExt};
use hmac::{Hmac, Mac};
use keemash_keelink::{
    decode_fabric_wire, encode_fabric_wire, fabric, fabric_capability, legacy_node_id,
    new_operation_id, put_u32, put_utf8, uuid_to_id, Header, Kind, TlvIter, FABRIC_MAX_WIRE_FRAME,
    FABRIC_VERSION, HEADER_SIZE,
};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use native_tls::{TlsConnector, TlsStream};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream as TokioTcpStream;
use tokio_native_tls::TlsStream as TokioTlsStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use uuid::Uuid;
use x509_parser::parse_x509_certificate;
use zeroize::Zeroize;

#[cfg(windows)]
use windows_sys::Win32::Foundation::FILETIME;
#[cfg(windows)]
use windows_sys::Win32::Security::Credentials::{
    CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

const DEFAULT_ROOT: &str = "192.168.1.50";
const HTTPS_PORT: u16 = 443;
const CREDENTIAL_TARGET: &str = "KeeMASH/KeeLink/root";
const EXPECTED_ROOT_SPKI_SHA256: &str =
    "46247faf04cd4d6d98ad00f94c2ab28cb358f32ce4294c2af77039a7f63fbd1c";
const ROOT_CERTIFICATE_PEM: &[u8] = include_bytes!("node0_https_servercert.pem");
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const BLE_FALLBACK_DELAY: Duration = Duration::from_secs(3);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);
const UART_CLAIM_CONTEXT: &[u8] = b"KeeLink UART claim v1";
const UART_CLAIM_TIMEOUT: Duration = Duration::from_secs(20);

const CH_SYSTEM: u16 = 1;
const CH_INVENTORY: u16 = 2;
const CH_CONTROL: u16 = 3;
const CH_STATE: u16 = 4;
const CH_SENSORS: u16 = 5;
const CH_TOPOLOGY: u16 = 6;
const CH_TASKS: u16 = 7;
const CH_MEMORY: u16 = 8;
const CH_LOG: u16 = 9;
const CH_OTA_STATUS: u16 = 10;
const FIELD_PROTOCOL_VERSION: u16 = 1;
const FIELD_LAST_EVENT: u16 = 4;
const FIELD_TEXT: u16 = 6;
const FIELD_STATUS: u16 = 7;
const FIELD_TARGET_MAC: u16 = 8;
const FIELD_COMMAND: u16 = 9;
const FIELD_TAG: u16 = 11;
const FIELD_INVENTORY_JSON: u16 = 12;
const FIELD_SNAPSHOT_ID: u16 = 13;
const FIELD_PART_INDEX: u16 = 14;
const FIELD_PART_COUNT: u16 = 15;
const FIELD_LOG_SUBSCRIBED: u16 = 16;
const FIELD_RTT_MS: u16 = 19;
const FABRIC_TRAFFIC_CLASS_COUNT: usize = 9;
const FABRIC_TRAFFIC_CLASS_SLOTS: usize = FABRIC_TRAFFIC_CLASS_COUNT + 1;

#[cfg(debug_assertions)]
static DEBUG_RECONNECT_USED: AtomicBool = AtomicBool::new(false);

const BLE_SERVICE_UUID: &str = "8e8b7d00-2d2c-4f6e-9b15-4b65654c696e";
const BLE_CHALLENGE_UUID: &str = "8e8b7d00-2d2c-4f6e-9b15-4b65654c0001";
const BLE_AUTH_UUID: &str = "8e8b7d00-2d2c-4f6e-9b15-4b65654c0002";
const BLE_REQUEST_UUID: &str = "8e8b7d00-2d2c-4f6e-9b15-4b65654c0003";
const BLE_RESPONSE_UUID: &str = "8e8b7d00-2d2c-4f6e-9b15-4b65654c0004";

type HmacSha256 = Hmac<Sha256>;
type KeeSocket = WebSocketStream<TokioTlsStream<TokioTcpStream>>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootStatus {
    pub connected: bool,
    pub paired: bool,
    pub transport: String,
    pub root_identity: Option<String>,
    pub address: Option<String>,
    pub security: String,
    pub latency_ms: Option<u32>,
    pub connection_id: u32,
    pub reconnect_phase: String,
    pub last_error: Option<String>,
}

impl Default for RootStatus {
    fn default() -> Self {
        Self {
            connected: false,
            paired: false,
            transport: "none".into(),
            root_identity: None,
            address: None,
            security: "unpaired".into(),
            latency_ms: None,
            connection_id: 0,
            reconnect_phase: "discovering".into(),
            last_error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshCommandResult {
    pub correlation_id: u32,
    pub status: u32,
    pub text: String,
    pub transport: String,
}

#[derive(Serialize, Deserialize)]
struct CredentialRecord {
    token: String,
    fingerprint: String,
    root_mac: String,
    address: String,
}

impl Drop for CredentialRecord {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

#[derive(Debug, Deserialize)]
struct RootInfo {
    root_mac: String,
    tls_public_key_sha256: String,
    #[serde(default)]
    fabric_version: Option<u32>,
}

struct CommandRequest {
    owner: String,
    command: String,
    result: Sender<Result<MeshCommandResult, String>>,
}

struct PendingCommand {
    result: Sender<Result<MeshCommandResult, String>>,
    started: Instant,
    target_mac: String,
    command: String,
    read_only: bool,
    connection_id: u32,
    root_session: u64,
    operation_id: Option<fabric::Id128>,
    replay_required: bool,
}

fn is_latency_query(command: &str) -> bool {
    matches!(
        command,
        "temp_echo"
            | "ppm_echo"
            | "humi_echo"
            | "lux_echo"
            | "pm1"
            | "echo_turb"
            | "heho"
            | "heater.climate?"
            | "heater.relay?"
            | "pwech"
            | "lamech"
            | "garland_echo"
            | "bedside_echo"
            | "jajoeh"
            | "PSQ"
            | "PSD"
            | "LSQ"
            | "LSD"
            | "S5Q"
            | "S5D"
            | "D5Q"
    ) || matches!(command, "choinka.status" | "lampk.status" | "heater.status")
}

#[derive(Default)]
struct LiveState {
    last_event: u32,
    inventory: HashMap<String, String>,
    task_inventory: HashMap<String, String>,
    fabric_enabled: bool,
    fabric_root_session: u64,
    fabric_cursors: [u64; FABRIC_TRAFFIC_CLASS_SLOTS],
    pending: HashMap<u32, PendingCommand>,
}

fn pending_error(item: &PendingCommand, reason: &str) -> String {
    if item.operation_id.is_some() {
        format!("KeeLink command outcome_unknown: {reason}")
    } else {
        format!("KeeLink command failed: {reason}")
    }
}

fn expire_pending_commands(pending: &mut HashMap<u32, PendingCommand>) -> Vec<u32> {
    let expired = pending
        .iter()
        .filter_map(|(id, item)| (item.started.elapsed() >= COMMAND_TIMEOUT).then_some(*id))
        .collect::<Vec<_>>();
    for id in &expired {
        if let Some(item) = pending.remove(id) {
            let _ = item.result.send(Err(pending_error(
                &item,
                "the bounded result deadline expired",
            )));
        }
    }
    expired
}

fn reconcile_pending_root_session(
    pending: &mut HashMap<u32, PendingCommand>,
    root_session: u64,
    connection_id: u32,
) -> Vec<u32> {
    let unknown = pending
        .iter()
        .filter_map(|(id, item)| {
            (item.operation_id.is_some()
                && item.root_session != 0
                && item.root_session != root_session)
                .then_some(*id)
        })
        .collect::<Vec<_>>();
    for id in &unknown {
        if let Some(item) = pending.remove(id) {
            let _ = item.result.send(Err(pending_error(
                &item,
                "the root boot session changed before a result was observed",
            )));
        }
    }
    for item in pending.values_mut() {
        if item.operation_id.is_some()
            && item.root_session == root_session
            && item.connection_id != connection_id
        {
            item.replay_required = true;
        }
    }
    unknown
}

fn fail_non_resumable_commands(pending: &mut HashMap<u32, PendingCommand>) {
    let rejected = pending
        .iter()
        .filter_map(|(id, item)| item.operation_id.is_none().then_some(*id))
        .collect::<Vec<_>>();
    for id in rejected {
        if let Some(item) = pending.remove(&id) {
            let _ = item
                .result
                .send(Err("KeeLink v1 command interrupted by reconnect".into()));
        }
    }
}

fn fail_all_pending(pending: &mut HashMap<u32, PendingCommand>, reason: &str) {
    for (_, item) in pending.drain() {
        let _ = item.result.send(Err(pending_error(&item, reason)));
    }
}

#[derive(Clone)]
struct FabricSession {
    enabled: bool,
    controller_id: fabric::Id128,
    transport_session: fabric::Id128,
    root_session: u64,
    welcomed: bool,
    source_gap_reported: bool,
}

impl FabricSession {
    fn v1() -> Self {
        Self {
            enabled: false,
            controller_id: fabric::Id128::default(),
            transport_session: fabric::Id128::default(),
            root_session: 0,
            welcomed: false,
            source_gap_reported: false,
        }
    }
}

fn task_monitor_link(
    address: &str,
    root: Option<&str>,
    inventory: &HashMap<String, String>,
    mac: &str,
) -> Result<String, String> {
    if mac.len() != 12 || !mac.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid node MAC".into());
    }
    let mac = mac.to_ascii_lowercase();
    if !root.is_some_and(|value| value.eq_ignore_ascii_case(&mac))
        && !inventory
            .values()
            .any(|value| value.eq_ignore_ascii_case(&mac))
    {
        return Err("Node is not in the current KeeLink inventory".into());
    }
    // Discovery supplies an IP address; reject paths, userinfo and arbitrary URLs.
    let ip: std::net::IpAddr = address.parse().map_err(|_| "Invalid root address")?;
    let host = match ip {
        std::net::IpAddr::V4(_) => ip.to_string(),
        std::net::IpAddr::V6(_) => format!("[{ip}]"),
    };
    Ok(format!("https://{host}/#tasks={mac}"))
}

enum WorkerCommand {
    Wake,
    TaskMonitor(String, Sender<Result<String, String>>),
    Send(CommandRequest),
    Stop,
}

struct RootInner {
    status: Mutex<RootStatus>,
    tx: Mutex<Option<flume::Sender<WorkerCommand>>>,
    stop: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct RootService {
    inner: Arc<RootInner>,
}

impl Default for RootService {
    fn default() -> Self {
        Self {
            inner: Arc::new(RootInner {
                status: Mutex::new(RootStatus::default()),
                tx: Mutex::new(None),
                stop: Arc::new(AtomicBool::new(false)),
                worker: Mutex::new(None),
            }),
        }
    }
}

impl RootService {
    pub fn task_monitor_url(&self, mac: String) -> Result<String, String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let tx = self
            .inner
            .tx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or("KeeLink service is not running")?;
        tx.send(WorkerCommand::TaskMonitor(mac, reply_tx))
            .map_err(|_| "KeeLink service stopped")?;
        reply_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Task Monitor request timed out")?
    }

    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        let mut worker = self.inner.worker.lock().unwrap_or_else(|p| p.into_inner());
        if worker.is_some() {
            return Ok(());
        }
        self.inner.stop.store(false, Ordering::Release);
        let (tx, rx) = flume::unbounded();
        *self.inner.tx.lock().unwrap_or_else(|p| p.into_inner()) = Some(tx);
        let inner = Arc::clone(&self.inner);
        *worker = Some(
            thread::Builder::new()
                .name("keelink-root".into())
                .spawn(move || worker_main(inner, app, rx))
                .map_err(|error| format!("Unable to start KeeLink service: {error}"))?,
        );
        Ok(())
    }

    pub fn stop(&self) {
        self.inner.stop.store(true, Ordering::Release);
        if let Some(tx) = self
            .inner
            .tx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            let _ = tx.send(WorkerCommand::Stop);
        }
        if let Some(worker) = self
            .inner
            .worker
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            let _ = worker.join();
        }
    }

    pub fn status(&self) -> RootStatus {
        self.inner
            .status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn pair_native(&self, serial: &SerialService) -> Result<RootStatus, String> {
        let address = discover_root().unwrap_or_else(|| DEFAULT_ROOT.into());
        let fingerprint = probe_tls_fingerprint(&address)?;
        if !fingerprint.eq_ignore_ascii_case(EXPECTED_ROOT_SPKI_SHA256) {
            return Err("node0 TLS public key does not match this KeeMASH build".into());
        }
        let client = pinned_https_client()?;
        let info: RootInfo = client
            .get(format!("https://{address}/keelink/info"))
            .send()
            .map_err(|error| format!("KeeLink info failed: {error}"))?
            .error_for_status()
            .map_err(|error| format!("KeeLink info rejected: {error}"))?
            .json()
            .map_err(|error| format!("Invalid KeeLink info: {error}"))?;
        if !fingerprint.eq_ignore_ascii_case(&info.tls_public_key_sha256) {
            return Err("node0 TLS public-key fingerprint does not match /keelink/info".into());
        }

        let root_mac = parse_root_mac(&info.root_mac)?;
        let mut token = [0_u8; 32];
        let mut nonce = [0_u8; 16];
        let mut uart_session = [0_u8; 2];
        OsRng.fill_bytes(&mut token);
        OsRng.fill_bytes(&mut nonce);
        OsRng.fill_bytes(&mut uart_session);
        let mut token_text = BASE64.encode(token);
        let mut nonce_text = BASE64.encode(nonce);
        let session_text = hex::encode(uart_session);
        let requests = vec![
            format!("KC1:{session_text}:N0:{}", &nonce_text[..12]),
            format!("KC1:{session_text}:N1:{}", &nonce_text[12..]),
            format!("KC1:{session_text}:T0:{}", &token_text[..11]),
            format!("KC1:{session_text}:T1:{}", &token_text[11..22]),
            format!("KC1:{session_text}:T2:{}", &token_text[22..33]),
            format!("KC1:{session_text}:T3:{}", &token_text[33..]),
        ];
        nonce_text.zeroize();
        let response = serial.claim_keelink(requests, UART_CLAIM_TIMEOUT);
        let verified = response.and_then(|response| {
            validate_uart_claim_response(&response, &session_text, &nonce, &token, &root_mac)
        });
        token.zeroize();
        nonce.zeroize();
        uart_session.zeroize();
        if let Err(error) = verified {
            token_text.zeroize();
            return Err(error);
        }

        let record = CredentialRecord {
            token: token_text,
            fingerprint,
            root_mac: info.root_mac.clone(),
            address: address.clone(),
        };
        credential_write(&record)?;
        let status = RootStatus {
            connected: false,
            paired: true,
            transport: "none".into(),
            root_identity: Some(info.root_mac),
            address: Some(address),
            security: "tls-pinned + uart-commissioned token".into(),
            latency_ms: None,
            connection_id: 0,
            reconnect_phase: "credential-installed".into(),
            last_error: None,
        };
        *self
            .inner
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = status.clone();
        if let Some(tx) = self
            .inner
            .tx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            let _ = tx.send(WorkerCommand::Wake);
        }
        Ok(status)
    }

    pub fn revoke(&self, expected_root: &str) -> Result<(), String> {
        if let Some(record) = credential_read()? {
            if record.root_mac != expected_root {
                return Err("Paired root changed during confirmation; nothing was removed".into());
            }
            let address = discover_root().unwrap_or_else(|| record.address.clone());
            let fingerprint = probe_tls_fingerprint(&address)?;
            if !fingerprint.eq_ignore_ascii_case(&record.fingerprint)
                || !fingerprint.eq_ignore_ascii_case(EXPECTED_ROOT_SPKI_SHA256)
            {
                return Err("node0 TLS public key changed; token was not revoked".into());
            }
            let mut authorization = format!("Bearer {}", record.token);
            let response = pinned_https_client()?
                .post(format!("https://{address}/keelink/revoke"))
                .header("Authorization", authorization.as_str())
                .send();
            authorization.zeroize();
            response
                .map_err(|error| format!("KeeLink revoke failed: {error}"))?
                .error_for_status()
                .map_err(|error| format!("KeeLink revoke rejected: {error}"))?;
            if !credential_read()?.is_some_and(|current| {
                current.root_mac == record.root_mac && current.token == record.token
            }) {
                return Err(
                    "Pairing changed during revocation; new credentials were preserved".into(),
                );
            }
        } else {
            return Err("No paired root to revoke".into());
        }
        credential_delete()?;
        if let Some(tx) = self
            .inner
            .tx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            let _ = tx.send(WorkerCommand::Wake);
        }
        Ok(())
    }

    pub fn send(&self, owner: String, command: String) -> Result<MeshCommandResult, String> {
        if owner.trim().is_empty() || command.trim().is_empty() || command.len() > 256 {
            return Err("KeeLink command requires a known owner and at most 256 bytes".into());
        }
        let (reply_tx, reply_rx) = mpsc::channel();
        let tx = self
            .inner
            .tx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or("KeeLink service is not running")?;
        tx.send(WorkerCommand::Send(CommandRequest {
            owner,
            command,
            result: reply_tx,
        }))
        .map_err(|_| "KeeLink service stopped".to_string())?;
        reply_rx
            .recv_timeout(COMMAND_TIMEOUT + Duration::from_secs(2))
            .map_err(|_| "KeeLink command timed out".to_string())?
    }
}

fn worker_main(inner: Arc<RootInner>, app: AppHandle, rx: flume::Receiver<WorkerCommand>) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            set_error(
                &inner,
                &app,
                "runtime-error",
                format!("KeeLink runtime failed: {error}"),
            );
            return;
        }
    };
    let mut live = LiveState::default();
    let mut ble: Option<BleFallback> = None;
    let mut offline_since = Instant::now();
    while !inner.stop.load(Ordering::Acquire) {
        expire_pending_commands(&mut live.pending);
        let record = match credential_read() {
            Ok(Some(record)) => record,
            Ok(None) => {
                set_status(
                    &inner,
                    &app,
                    RootStatus {
                        paired: false,
                        reconnect_phase: "commissioning-required".into(),
                        ..RootStatus::default()
                    },
                );
                reject_until_wake(&inner, &rx, "KeeLink is not paired");
                continue;
            }
            Err(error) => {
                set_error(&inner, &app, "credential-error", error);
                thread::sleep(RECONNECT_DELAY);
                continue;
            }
        };
        let address = discover_root().unwrap_or_else(|| record.address.clone());
        set_connecting(&inner, &app, &record, &address, offline_since.elapsed());
        let info = match fetch_root_info(&address) {
            Ok(info) => info,
            Err(error) => {
                set_error(&inner, &app, "capability-probe", error);
                service_offline_commands(
                    &inner,
                    &app,
                    &rx,
                    &record,
                    &mut live.inventory,
                    &mut ble,
                    offline_since.elapsed() >= BLE_FALLBACK_DELAY,
                );
                thread::sleep(RECONNECT_DELAY);
                continue;
            }
        };
        if !info.root_mac.eq_ignore_ascii_case(&record.root_mac)
            || !info
                .tls_public_key_sha256
                .eq_ignore_ascii_case(&record.fingerprint)
        {
            set_error(
                &inner,
                &app,
                "identity-mismatch",
                "KeeLink discovery identity does not match the paired root".into(),
            );
            thread::sleep(RECONNECT_DELAY);
            continue;
        }
        live.fabric_enabled = info
            .fabric_version
            .is_some_and(|version| version >= FABRIC_VERSION);
        if !live.fabric_enabled {
            fail_all_pending(
                &mut live.pending,
                "the authenticated root no longer supports Fabric resume",
            );
        }
        let mut reconnect_delay = RECONNECT_DELAY;
        match runtime.block_on(connect_wss(&record, &address)) {
            Ok(mut socket) => {
                if let Some(fallback) = ble.as_mut() {
                    fallback.disconnect();
                }
                offline_since = Instant::now();
                if let Err(error) = runtime.block_on(run_wss(
                    &inner,
                    &app,
                    &rx,
                    &record,
                    &address,
                    &mut socket,
                    &mut live,
                )) {
                    #[cfg(debug_assertions)]
                    if error == "debug Fabric reconnect gate" {
                        reconnect_delay = std::env::var("KEEMASH_DEBUG_RECONNECT_HOLD_MS")
                            .ok()
                            .and_then(|value| value.parse::<u64>().ok())
                            .filter(|value| (1_000..=15_000).contains(value))
                            .map(Duration::from_millis)
                            .unwrap_or(RECONNECT_DELAY);
                    }
                    set_error(&inner, &app, "reconnecting", error);
                }
                fail_non_resumable_commands(&mut live.pending);
                expire_pending_commands(&mut live.pending);
            }
            Err(error) => {
                set_error(&inner, &app, "wss-retry", error);
                service_offline_commands(
                    &inner,
                    &app,
                    &rx,
                    &record,
                    &mut live.inventory,
                    &mut ble,
                    offline_since.elapsed() >= BLE_FALLBACK_DELAY,
                );
            }
        }
        thread::sleep(reconnect_delay);
    }
    fail_all_pending(&mut live.pending, "the KeeLink service stopped");
}

async fn run_wss(
    inner: &Arc<RootInner>,
    app: &AppHandle,
    rx: &flume::Receiver<WorkerCommand>,
    record: &CredentialRecord,
    address: &str,
    socket: &mut KeeSocket,
    live: &mut LiveState,
) -> Result<(), String> {
    static CORRELATION: AtomicU32 = AtomicU32::new(1);
    let mut fabric_session = if live.fabric_enabled {
        FabricSession {
            enabled: true,
            controller_id: controller_id(record),
            transport_session: new_operation_id(),
            root_session: 0,
            welcomed: false,
            source_gap_reported: false,
        }
    } else {
        FabricSession::v1()
    };
    let hello = if fabric_session.enabled {
        make_fabric_hello(&fabric_session, live)
    } else {
        make_frame(Kind::Hello, CH_SYSTEM, 1, 0, |payload| {
            put_u32(payload, FIELD_PROTOCOL_VERSION, 1)?;
            put_u32(payload, FIELD_LAST_EVENT, live.last_event)
        })?
    };
    socket
        .send(Message::Binary(hello.into()))
        .await
        .map_err(ws_error)?;
    if !fabric_session.enabled {
        let inventory_request = make_frame(Kind::Request, CH_INVENTORY, 2, 2, |_| Ok(()))?;
        socket
            .send(Message::Binary(inventory_request.into()))
            .await
            .map_err(ws_error)?;
    }
    let log_subscription = make_frame(Kind::Request, CH_LOG, 3, 3, |payload| {
        keemash_keelink::put_bool(payload, FIELD_LOG_SUBSCRIBED, true)
    })?;
    socket
        .send(Message::Binary(log_subscription.into()))
        .await
        .map_err(ws_error)?;
    let connection_id = next_connection_id();
    let mut last_rx = Instant::now();
    #[cfg(debug_assertions)]
    let debug_reconnect_after = std::env::var("KEEMASH_DEBUG_RECONNECT_AFTER_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (1_000..=60_000).contains(value))
        .filter(|_| !DEBUG_RECONNECT_USED.swap(true, Ordering::Relaxed))
        .map(Duration::from_millis);
    #[cfg(debug_assertions)]
    let connection_started = Instant::now();
    let mut snapshots = SnapshotState::default();
    set_status(
        inner,
        app,
        RootStatus {
            connected: true,
            paired: true,
            transport: if fabric_session.enabled {
                "wss-fabric-v2".into()
            } else {
                "wss".into()
            },
            root_identity: Some(record.root_mac.clone()),
            address: Some(address.into()),
            security: "tls-pinned + token".into(),
            latency_ms: None,
            connection_id,
            reconnect_phase: "handshake".into(),
            last_error: None,
        },
    );

    let mut maintenance = tokio::time::interval(Duration::from_millis(100));
    maintenance.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            command = rx.recv_async() => {
                let Ok(command) = command else { return Ok(()); };
                match command {
                WorkerCommand::Stop => return Ok(()),
                WorkerCommand::Wake => return Err("connection refresh requested".into()),
                WorkerCommand::TaskMonitor(mac, reply) => {
                    let status = inner.status.lock().unwrap_or_else(|p| p.into_inner());
                    let _ = reply.send(task_monitor_link(
                        address,
                        status.root_identity.as_deref(),
                        &live.task_inventory,
                        &mac,
                    ));
                }
                WorkerCommand::Send(request) => {
                    let owner = request.owner.to_ascii_lowercase();
                    let Some(mac) = live.inventory.get(&owner) else {
                        let _ = request.result.send(Err(format!(
                            "Node owner '{}' is not in the live KeeLink inventory",
                            request.owner
                        )));
                        continue;
                    };
                    let correlation = next_nonzero(&CORRELATION);
                    if fabric_session.enabled && !fabric_session.welcomed {
                        let _ = request.result.send(Err(
                            "KeeLink Fabric handshake is not complete".into(),
                        ));
                        continue;
                    }
                    let operation_id = fabric_session.enabled.then(new_operation_id);
                    let read_only = is_latency_query(&request.command);
                    let frame = if let Some(operation_id) = operation_id.as_ref() {
                        make_fabric_control(
                            &fabric_session,
                            &record.root_mac,
                            mac,
                            &request.command,
                            correlation,
                            *operation_id,
                        )?
                    } else {
                        make_frame(
                            Kind::Request,
                            CH_CONTROL,
                            correlation,
                            correlation,
                            |payload| {
                                put_utf8(payload, FIELD_TARGET_MAC, mac)?;
                                put_utf8(payload, FIELD_COMMAND, &request.command)
                            },
                        )?
                    };
                    match socket.send(Message::Binary(frame.into())).await {
                        Ok(()) => {
                            live.pending.insert(
                                correlation,
                                PendingCommand {
                                    result: request.result,
                                    started: Instant::now(),
                                    target_mac: mac.clone(),
                                    command: request.command,
                                    read_only,
                                    connection_id,
                                    root_session: fabric_session.root_session,
                                    operation_id,
                                    replay_required: false,
                                },
                            );
                        }
                        Err(error) => {
                            let _ = request.result.send(Err(ws_error(error)));
                            return Err("WSS command write failed".into());
                        }
                    }
                }
            }
            }
            message = socket.next() => {
                match message {
            Some(Ok(Message::Binary(frame))) => {
                last_rx = Instant::now();
                let reported_root_latency = handle_frame(
                    app,
                    &frame,
                    &record.root_mac,
                    live,
                    &mut snapshots,
                    &mut fabric_session,
                    connection_id,
                )?;
                if fabric_session.welcomed {
                    let replays = pending_fabric_replays(
                        &live.pending,
                        &fabric_session,
                        &record.root_mac,
                    )?;
                    for (correlation_id, operation_id, replay) in replays {
                        socket
                            .send(Message::Binary(replay.into()))
                            .await
                            .map_err(ws_error)?;
                        mark_pending_replayed(
                            &mut live.pending,
                            correlation_id,
                            &operation_id,
                            connection_id,
                        );
                    }
                }
                let mut status = inner.status.lock().unwrap_or_else(|p| p.into_inner());
                if reported_root_latency.is_some() {
                    status.latency_ms = reported_root_latency;
                }
                status.reconnect_phase = "live".into();
                status.last_error = None;
                let snapshot = status.clone();
                drop(status);
                let _ = app.emit("mesh-status", snapshot);
            }
            Some(Ok(Message::Ping(value))) => {
                last_rx = Instant::now();
                socket.send(Message::Pong(value)).await.map_err(ws_error)?;
            }
            Some(Ok(Message::Pong(_))) => {
                last_rx = Instant::now();
            }
            Some(Ok(Message::Close(_))) | None => return Err("WSS closed by node0".into()),
            Some(Ok(_)) => {}
            Some(Err(error)) => return Err(ws_error(error)),
        }
            }
            _ = maintenance.tick() => {
                #[cfg(debug_assertions)]
                if debug_reconnect_after
                    .is_some_and(|after| connection_started.elapsed() >= after)
                {
                    return Err("debug Fabric reconnect gate".into());
                }
                if last_rx.elapsed() > HEARTBEAT_TIMEOUT {
                    return Err("KeeLink heartbeat timed out".into());
                }
                for correlation_id in expire_pending_commands(&mut live.pending) {
                    let _ = app.emit(
                        "mesh-command-outcome",
                        serde_json::json!({
                            "correlationId": correlation_id,
                            "outcome": "outcome_unknown",
                            "reason": "deadline",
                        }),
                    );
                }
            }
        }
    }
}

fn handle_frame(
    app: &AppHandle,
    frame: &[u8],
    root_mac: &str,
    live: &mut LiveState,
    snapshots: &mut SnapshotState,
    fabric_session: &mut FabricSession,
    connection_id: u32,
) -> Result<Option<u32>, String> {
    if frame.starts_with(keemash_keelink::FABRIC_WIRE_PREFIX) {
        return handle_fabric_frame(
            app,
            frame,
            root_mac,
            live,
            &mut snapshots.fabric_graph,
            fabric_session,
            connection_id,
        );
    }
    let mut reported_root_latency = None;
    let header =
        Header::decode(frame).map_err(|error| format!("Invalid KeeLink frame: {error:?}"))?;
    if header.message_id != 0 {
        live.last_event = live.last_event.max(header.message_id);
    }
    let payload = &frame[HEADER_SIZE..];
    match (header.kind, header.channel) {
        (Kind::Welcome, CH_SYSTEM) => {}
        (Kind::Heartbeat, CH_SYSTEM) => {
            reported_root_latency = field_u32(&read_fields(payload)?, FIELD_RTT_MS);
        }
        (Kind::Gap, _) => {
            let fields = fields_to_json(payload).unwrap_or(Value::Null);
            if let Some(text) = fields.get("text").and_then(Value::as_str) {
                let _ = app.emit("mesh-line", text.to_string());
            }
            let _ = app.emit(
                "mesh-gap",
                serde_json::json!({
                    "event": header.message_id,
                    "channel": header.channel,
                    "fields": fields,
                }),
            );
        }
        (Kind::Snapshot, CH_INVENTORY) => {
            if let Some(value) = snapshots.legacy.push(payload)? {
                if !fabric_session.enabled {
                    update_inventory(&value, &mut live.inventory);
                    update_task_inventory(&value, &mut live.task_inventory);
                }
                let _ = app.emit("mesh-inventory", value);
            }
        }
        (
            Kind::Event,
            channel @ (CH_STATE | CH_SENSORS | CH_TOPOLOGY | CH_TASKS | CH_MEMORY | CH_LOG
            | CH_OTA_STATUS),
        ) => {
            let fields = fields_to_json(payload)?;
            let data = fields
                .get("text")
                .and_then(Value::as_str)
                .and_then(|text| serde_json::from_str::<Value>(text).ok());
            let _ = app.emit(
                "mesh-event",
                serde_json::json!({
                    "channel": channel,
                    "messageId": header.message_id,
                    "fields": fields,
                    "data": data,
                }),
            );
            if matches!(channel, CH_STATE | CH_LOG) {
                if let Some(text) = fields.get("text").and_then(Value::as_str) {
                    let _ = app.emit("mesh-line", text.to_string());
                }
            }
        }
        (Kind::Response, CH_CONTROL) | (Kind::Error, CH_CONTROL) => {
            let fields = fields_to_json(payload)?;
            let result = MeshCommandResult {
                correlation_id: header.correlation_id,
                status: fields.get("status").and_then(Value::as_u64).unwrap_or(1) as u32,
                text: fields
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                transport: "wss".into(),
            };
            if let Some(waiter) = live.pending.remove(&header.correlation_id) {
                let response_latency =
                    waiter.started.elapsed().as_millis().min(u32::MAX as u128) as u32;
                if waiter.read_only && result.status == 0 {
                    let _ = app.emit(
                        "mesh-node-latency",
                        serde_json::json!({
                            "mac": waiter.target_mac, "correlationId": header.correlation_id,
                            "rttMs": response_latency, "transport": "wss",
                            "connectionId": waiter.connection_id,
                        }),
                    );
                }
                let _ = waiter.result.send(Ok(result.clone()));
            }
            if !result.text.is_empty() {
                let _ = app.emit("mesh-line", result.text.clone());
            }
            let _ = app.emit("mesh-command-result", result);
        }
        _ => {}
    }
    Ok(reported_root_latency)
}

fn handle_fabric_frame(
    app: &AppHandle,
    frame: &[u8],
    root_mac: &str,
    live: &mut LiveState,
    graphs: &mut FabricGraphAssembler,
    session: &mut FabricSession,
    connection_id: u32,
) -> Result<Option<u32>, String> {
    if !session.enabled {
        return Err("node0 sent Fabric data to a KeeLink v1 session".into());
    }
    let envelope = decode_fabric_wire(frame).map_err(|error| error.to_string())?;
    if envelope.protocol_version != FABRIC_VERSION {
        return Err(format!(
            "Unsupported KeeLink Fabric version {}",
            envelope.protocol_version
        ));
    }
    let is_welcome = matches!(
        envelope.body.as_ref(),
        Some(fabric::envelope::Body::Welcome(_))
    );
    if !is_welcome && !fabric_data_session_valid(&envelope, session) {
        return Err("KeeLink Fabric data session mismatch".into());
    }
    let traffic_class = envelope.traffic_class;
    let sequence = envelope.sequence;
    if !is_welcome && fabric_sequence_consumed(live, traffic_class, sequence) {
        return Ok(None);
    }
    match envelope.body {
        Some(fabric::envelope::Body::Welcome(welcome)) => {
            if welcome.protocol_version != FABRIC_VERSION
                || welcome.transport_session.as_ref() != Some(&session.transport_session)
                || envelope.transport_session.as_ref() != Some(&session.transport_session)
                || welcome.root_session == 0
            {
                return Err("KeeLink Fabric WELCOME identity mismatch".into());
            }
            let previous_root_session = live.fabric_root_session;
            if !welcome.resume_accepted || previous_root_session != welcome.root_session {
                live.fabric_cursors = [0; FABRIC_TRAFFIC_CLASS_SLOTS];
            }
            let unknown = reconcile_pending_root_session(
                &mut live.pending,
                welcome.root_session,
                connection_id,
            );
            for correlation_id in unknown {
                let _ = app.emit(
                    "mesh-command-outcome",
                    serde_json::json!({
                        "correlationId": correlation_id,
                        "outcome": "outcome_unknown",
                        "reason": "root_session_reset",
                        "previousRootSession": previous_root_session,
                        "rootSession": welcome.root_session,
                    }),
                );
            }
            live.fabric_root_session = welcome.root_session;
            session.root_session = welcome.root_session;
            session.welcomed = true;
            let _ = app.emit(
                "mesh-fabric-status",
                serde_json::json!({
                    "protocolVersion": welcome.protocol_version,
                    "rootSession": welcome.root_session,
                    "capabilities": welcome.capabilities,
                    "resumeAccepted": welcome.resume_accepted,
                    "fallbackReason": welcome.fallback_reason,
                    "transport": "wss",
                }),
            );
        }
        Some(fabric::envelope::Body::ControlResult(control)) => {
            if envelope.transport_session.as_ref() != Some(&session.transport_session)
                || envelope.root_session != session.root_session
                || envelope.correlation == 0
                || envelope.correlation > u32::MAX as u64
            {
                return Err("KeeLink Fabric CONTROL result session mismatch".into());
            }
            let correlation_id = envelope.correlation as u32;
            let Some(waiter) = live.pending.remove(&correlation_id) else {
                fabric_record_cursor(live, traffic_class, sequence);
                return Ok(None);
            };
            if control.operation_id.as_ref() != waiter.operation_id.as_ref()
                || envelope.operation_id.as_ref() != waiter.operation_id.as_ref()
            {
                let _ = waiter
                    .result
                    .send(Err("KeeLink Fabric CONTROL operation mismatch".into()));
                return Err("KeeLink Fabric CONTROL operation mismatch".into());
            }
            let result = MeshCommandResult {
                correlation_id,
                status: control.status,
                text: control.text,
                transport: "wss-fabric-v2".into(),
            };
            let response_latency =
                waiter.started.elapsed().as_millis().min(u32::MAX as u128) as u32;
            if waiter.read_only && result.status == 0 {
                let _ = app.emit(
                    "mesh-node-latency",
                    serde_json::json!({
                        "mac": waiter.target_mac, "correlationId": correlation_id,
                        "rttMs": response_latency, "transport": "wss-fabric-v2",
                        "connectionId": waiter.connection_id,
                    }),
                );
            }
            let _ = waiter.result.send(Ok(result.clone()));
            if !result.text.is_empty() {
                let _ = app.emit("mesh-line", result.text.clone());
            }
            let _ = app.emit("mesh-command-result", result);
        }
        Some(fabric::envelope::Body::Gap(gap)) => {
            let _ = app.emit(
                "mesh-gap",
                serde_json::json!({
                    "channel": gap.traffic_class,
                    "first": gap.first_sequence,
                    "last": gap.last_sequence,
                    "reason": gap.reason,
                    "snapshotRequired": gap.snapshot_required,
                }),
            );
        }
        Some(fabric::envelope::Body::Graph(graph)) => {
            if let Some(snapshot) = graphs.push(graph)? {
                let event = update_fabric_inventory(
                    root_mac,
                    snapshot.revision,
                    &snapshot.nodes,
                    &mut live.inventory,
                    &mut live.task_inventory,
                )?;
                session.source_gap_reported = false;
                let _ = app.emit("mesh-fabric-graph", event);
            }
        }
        Some(fabric::envelope::Body::Telemetry(sample)) => {
            let Some(target_mac) = fabric_source_mac_or_report_gap(
                app,
                root_mac,
                &live.inventory,
                envelope.source_node_id.as_ref(),
                session,
            ) else {
                return Ok(None);
            };
            emit_fabric_event(
                app,
                CH_SENSORS,
                envelope.sequence,
                &target_mac,
                fabric_telemetry_data(&sample)?,
            );
        }
        Some(fabric::envelope::Body::Tasks(tasks)) => {
            let Some(target_mac) = fabric_source_mac_or_report_gap(
                app,
                root_mac,
                &live.inventory,
                envelope.source_node_id.as_ref(),
                session,
            ) else {
                return Ok(None);
            };
            emit_fabric_event(
                app,
                CH_TASKS,
                envelope.sequence,
                &target_mac,
                serde_json::json!({
                    "requestId": tasks.request_id,
                    "updatedMs": tasks.updated_ms,
                    "uptimeS": tasks.uptime_s,
                    "cpuX10": tasks.cpu_load_x10,
                    "cpuValid": tasks.cpu_valid,
                    "total": tasks.actual_count,
                    "index": tasks.task_index,
                    "count": tasks.tasks.len(),
                    "last": !tasks.truncated,
                    "bootSession": tasks.boot_session,
                    "tasks": tasks.tasks.iter().map(|task| serde_json::json!({
                        "name": task.name,
                        "runtime": task.runtime,
                        "freeWords": task.stack_free_words,
                        "priority": task.priority,
                        "state": task.state,
                        "core": task.core,
                        "cpuX10": task.cpu_load_x10,
                    })).collect::<Vec<_>>(),
                }),
            );
        }
        Some(fabric::envelope::Body::Memory(memory)) => {
            let Some(target_mac) = fabric_source_mac_or_report_gap(
                app,
                root_mac,
                &live.inventory,
                envelope.source_node_id.as_ref(),
                session,
            ) else {
                return Ok(None);
            };
            emit_fabric_event(
                app,
                CH_MEMORY,
                envelope.sequence,
                &target_mac,
                serde_json::json!({
                    "uptimeS": memory.uptime_s,
                    "heapFree": memory.heap_free,
                    "heapMin": memory.heap_min_free,
                    "heapTotal": memory.heap_total,
                    "internalFree": memory.internal_free,
                    "internalMin": memory.internal_min_free,
                    "internalTotal": memory.internal_total,
                    "psramEnabled": memory.psram_enabled,
                    "psramFree": memory.psram_free,
                    "psramMin": memory.psram_min_free,
                    "psramTotal": memory.psram_total,
                    "psramExpected": memory.psram_expected,
                    "flashChip": memory.flash_size,
                    "appUsed": memory.image_size,
                    "appSlot": memory.app_slot_size,
                    "nvsUsed": memory.nvs_used_entries,
                    "nvsFree": memory.nvs_free_entries,
                    "nvsAvailable": memory.nvs_available_entries,
                    "nvsTotal": memory.nvs_total_entries,
                    "bootSession": memory.boot_session,
                }),
            );
        }
        Some(fabric::envelope::Body::Log(log)) => {
            let Some(target_mac) = fabric_source_mac_or_report_gap(
                app,
                root_mac,
                &live.inventory,
                envelope.source_node_id.as_ref(),
                session,
            ) else {
                return Ok(None);
            };
            let _ = app.emit("mesh-line", log.text.clone());
            let _ = app.emit(
                "mesh-event",
                serde_json::json!({
                    "channel": CH_LOG,
                    "messageId": envelope.sequence,
                    "fields": {
                        "targetMac": target_mac,
                        "text": log.text,
                    },
                    "data": Value::Null,
                }),
            );
        }
        _ => {}
    }
    if !is_welcome {
        fabric_record_cursor(live, traffic_class, sequence);
    }
    Ok(None)
}

fn fabric_source_mac(
    root_mac: &str,
    inventory: &HashMap<String, String>,
    source_node_id: Option<&fabric::Id128>,
) -> Option<String> {
    let source_node_id = source_node_id?;
    let root = parse_root_mac(root_mac).ok()?;
    inventory.values().find_map(|mac| {
        let route = parse_root_mac(mac).ok()?;
        (legacy_node_id(root, route) == *source_node_id).then(|| mac.to_ascii_lowercase())
    })
}

fn fabric_source_mac_or_report_gap(
    app: &AppHandle,
    root_mac: &str,
    inventory: &HashMap<String, String>,
    source_node_id: Option<&fabric::Id128>,
    session: &mut FabricSession,
) -> Option<String> {
    let source = fabric_source_mac(root_mac, inventory, source_node_id);
    if source.is_none() && !session.source_gap_reported {
        session.source_gap_reported = true;
        let _ = app.emit(
            "mesh-gap",
            serde_json::json!({
                "channel": "fabric-source",
                "reason": "source is not present in the completed graph revision",
                "snapshotRequired": true,
            }),
        );
    }
    source
}

fn fabric_data_session_valid(envelope: &fabric::Envelope, session: &FabricSession) -> bool {
    session.welcomed
        && envelope.transport_session.as_ref() == Some(&session.transport_session)
        && envelope.root_session == session.root_session
}

fn fabric_cursor_index(traffic_class: i32) -> Option<usize> {
    let index = usize::try_from(traffic_class).ok()?;
    (1..=FABRIC_TRAFFIC_CLASS_COUNT)
        .contains(&index)
        .then_some(index)
}

fn fabric_sequence_consumed(live: &LiveState, traffic_class: i32, sequence: u64) -> bool {
    let Some(index) = fabric_cursor_index(traffic_class) else {
        return false;
    };
    sequence != 0 && sequence <= live.fabric_cursors[index]
}

fn fabric_record_cursor(live: &mut LiveState, traffic_class: i32, sequence: u64) {
    let Some(index) = fabric_cursor_index(traffic_class) else {
        return;
    };
    if sequence > live.fabric_cursors[index] {
        live.fabric_cursors[index] = sequence;
    }
}

fn fabric_telemetry_data(sample: &fabric::TelemetrySample) -> Result<Value, String> {
    let value = match sample.value.as_ref() {
        Some(fabric::telemetry_sample::Value::DoubleValue(value)) => *value,
        Some(fabric::telemetry_sample::Value::Sint64Value(value)) => *value as f64,
        _ => return Err("KeeLink Fabric SENSOR value is not numeric".into()),
    };
    Ok(serde_json::json!({
        "generation": sample.generation,
        "sampleUptimeMs": sample.acquisition_mono_us / 1_000,
        "requestId": sample.request_id,
        "id": sample.metric_id,
        "status": sample.quality_flags,
        "scale10": sample.scale10,
        "value": value,
        "validity": sample.validity,
        "bootSession": sample.boot_session,
    }))
}

fn emit_fabric_event(
    app: &AppHandle,
    channel: u16,
    message_id: u64,
    target_mac: &str,
    data: Value,
) {
    let _ = app.emit(
        "mesh-event",
        serde_json::json!({
            "channel": channel,
            "messageId": message_id,
            "fields": { "targetMac": target_mac },
            "data": data,
        }),
    );
}

fn service_offline_commands(
    inner: &Arc<RootInner>,
    app: &AppHandle,
    rx: &flume::Receiver<WorkerCommand>,
    record: &CredentialRecord,
    inventory: &mut HashMap<String, String>,
    ble: &mut Option<BleFallback>,
    ble_allowed: bool,
) {
    if ble_allowed && ble.is_none() {
        match BleFallback::new() {
            Ok(fallback) => *ble = Some(fallback),
            Err(error) => {
                set_error(inner, app, "ble-runtime", error);
            }
        }
    }
    if ble_allowed {
        if let Some(fallback) = ble.as_mut() {
            match fallback.ensure_connected(record) {
                Ok(()) => set_status(
                    inner,
                    app,
                    RootStatus {
                        connected: true,
                        paired: true,
                        transport: "ble".into(),
                        root_identity: Some(record.root_mac.clone()),
                        address: None,
                        security: "ble-hmac".into(),
                        latency_ms: None,
                        connection_id: next_connection_id(),
                        reconnect_phase: "ble-fallback".into(),
                        last_error: None,
                    },
                ),
                Err(error) => set_error(inner, app, "ble-retry", error),
            }
        }
    }
    match rx.recv_timeout(RECONNECT_DELAY) {
        Ok(WorkerCommand::Send(request)) if ble_allowed => {
            let owner = request.owner.to_ascii_lowercase();
            if !inventory.contains_key(&owner) {
                if let Some(fallback) = ble.as_mut() {
                    if let Ok(value) = ble_inventory(fallback, record) {
                        update_inventory(&value, inventory);
                        let _ = app.emit("mesh-inventory", value);
                    }
                }
            }
            let started = Instant::now();
            let result = ble
                .as_mut()
                .ok_or("BLE fallback is unavailable".to_string())
                .and_then(|fallback| {
                    inventory
                        .get(&owner)
                        .ok_or_else(|| {
                            format!(
                                "Node owner '{}' is not in the live BLE inventory",
                                request.owner
                            )
                        })
                        .and_then(|mac| ble_command(fallback, record, mac, &request.command))
                });
            if let Ok(value) = &result {
                if value.status == 0 && is_latency_query(&request.command) {
                    if let Some(mac) = inventory.get(&owner) {
                        let _ = app.emit(
                            "mesh-node-latency",
                            serde_json::json!({
                                "mac": mac, "correlationId": value.correlation_id,
                                "rttMs": started.elapsed().as_millis().min(u32::MAX as u128) as u32,
                                "transport": "ble",
                                "connectionId": inner.status.lock().unwrap_or_else(|p| p.into_inner()).connection_id,
                            }),
                        );
                    }
                }
                let _ = app.emit("mesh-command-result", value.clone());
            }
            match &result {
                Ok(_) => {
                    let mut status = inner.status.lock().unwrap_or_else(|p| p.into_inner());
                    status.connected = true;
                    status.transport = "ble".into();
                    status.reconnect_phase = "ble-fallback".into();
                    status.security = "ble-hmac".into();
                    status.latency_ms = None;
                    status.last_error = None;
                    let snapshot = status.clone();
                    drop(status);
                    let _ = app.emit("mesh-status", snapshot);
                }
                Err(error) => set_error(inner, app, "ble-command", error.clone()),
            }
            let _ = request.result.send(result);
        }
        Ok(WorkerCommand::Send(request)) => {
            let _ = request.result.send(Err(
                "WSS is unavailable; BLE fallback is still arming".into()
            ));
        }
        Ok(WorkerCommand::TaskMonitor(_, reply)) => {
            let _ = reply.send(Err("HTTPS root is unavailable on BLE".into()));
        }
        Ok(WorkerCommand::Stop | WorkerCommand::Wake) | Err(_) => {}
    }
}

fn reject_until_wake(inner: &Arc<RootInner>, rx: &flume::Receiver<WorkerCommand>, reason: &str) {
    match rx.recv_timeout(Duration::from_secs(1)) {
        Ok(WorkerCommand::Send(request)) => {
            let _ = request.result.send(Err(reason.into()));
        }
        Ok(WorkerCommand::Stop) => inner.stop.store(true, Ordering::Release),
        Ok(WorkerCommand::TaskMonitor(_, reply)) => {
            let _ = reply.send(Err("HTTPS root is disconnected".into()));
        }
        Ok(WorkerCommand::Wake) | Err(_) => {}
    }
}

async fn connect_wss(record: &CredentialRecord, address: &str) -> Result<KeeSocket, String> {
    let socket = resolve_root_socket(address)?;
    let tcp = tokio::time::timeout(Duration::from_secs(2), TokioTcpStream::connect(socket))
        .await
        .map_err(|_| "node0 connection timed out".to_string())?
        .map_err(|error| format!("node0 connection failed: {error}"))?;
    tcp.set_nodelay(true)
        .map_err(|error| format!("Unable to enable KeeLink TCP_NODELAY: {error}"))?;
    let connector = tokio_native_tls::TlsConnector::from(insecure_tls_connector()?);
    let tls = tokio::time::timeout(
        Duration::from_secs(4),
        connector.connect("keemash-root", tcp),
    )
    .await
    .map_err(|_| "node0 TLS handshake timed out".to_string())?
    .map_err(|error| format!("node0 TLS handshake failed: {error}"))?;
    verify_async_peer_fingerprint(&tls, &record.fingerprint)?;
    let request = wss_request(address, &record.token)?;
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(4),
        tokio_tungstenite::client_async(request, tls),
    )
    .await
    .map_err(|_| "KeeLink WSS handshake timed out".to_string())?
    .map_err(|error| format!("KeeLink WSS handshake failed: {error}"))?;
    Ok(socket)
}

fn wss_request(address: &str, token: &str) -> Result<Request<()>, String> {
    let mut request = format!("wss://{address}/keelink/ws")
        .into_client_request()
        .map_err(|error| format!("Invalid WSS request: {error}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|error| format!("Invalid WSS authorization: {error}"))?,
    );
    Ok(request)
}

fn connect_tcp(address: &str) -> Result<TcpStream, String> {
    let socket = resolve_root_socket(address)?;
    let tcp = TcpStream::connect_timeout(&socket, Duration::from_secs(2))
        .map_err(|error| format!("node0 connection failed: {error}"))?;
    tcp.set_nodelay(true)
        .map_err(|error| format!("Unable to enable KeeLink TCP_NODELAY: {error}"))?;
    tcp.set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    Ok(tcp)
}

fn resolve_root_socket(address: &str) -> Result<SocketAddr, String> {
    format!("{address}:{HTTPS_PORT}")
        .parse::<SocketAddr>()
        .or_else(|_| {
            (address, HTTPS_PORT)
                .to_socket_addrs()
                .and_then(|mut a| a.next().ok_or(std::io::ErrorKind::NotFound.into()))
        })
        .map_err(|error| format!("Invalid node0 address: {error}"))
}

fn insecure_tls_connector() -> Result<TlsConnector, String> {
    let mut builder = TlsConnector::builder();
    builder.danger_accept_invalid_certs(true);
    builder.danger_accept_invalid_hostnames(true);
    builder
        .build()
        .map_err(|error| format!("TLS initialization failed: {error}"))
}

fn pinned_https_client() -> Result<reqwest::blocking::Client, String> {
    let certificate = reqwest::Certificate::from_pem(ROOT_CERTIFICATE_PEM)
        .map_err(|error| format!("Embedded node0 certificate is invalid: {error}"))?;
    reqwest::blocking::Client::builder()
        .https_only(true)
        .tls_built_in_root_certs(false)
        .add_root_certificate(certificate)
        .danger_accept_invalid_hostnames(true)
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("HTTPS client initialization failed: {error}"))
}

fn fetch_root_info(address: &str) -> Result<RootInfo, String> {
    pinned_https_client()?
        .get(format!("https://{address}/keelink/info"))
        .send()
        .map_err(|error| format!("KeeLink info failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("KeeLink info rejected: {error}"))?
        .json()
        .map_err(|error| format!("Invalid KeeLink info: {error}"))
}

fn probe_tls_fingerprint(address: &str) -> Result<String, String> {
    let tls = insecure_tls_connector()?
        .connect("keemash-root", connect_tcp(address)?)
        .map_err(|error| format!("node0 TLS probe failed: {error}"))?;
    peer_fingerprint(&tls)
}

fn peer_fingerprint(tls: &TlsStream<TcpStream>) -> Result<String, String> {
    let der = tls
        .peer_certificate()
        .map_err(|error| format!("Unable to read node0 certificate: {error}"))?
        .ok_or("node0 did not provide a TLS certificate")?
        .to_der()
        .map_err(|error| format!("Unable to decode node0 certificate: {error}"))?;
    fingerprint_der(&der)
}

fn fingerprint_der(der: &[u8]) -> Result<String, String> {
    let (_, cert) = parse_x509_certificate(der)
        .map_err(|error| format!("Unable to parse node0 certificate: {error}"))?;
    Ok(hex::encode(Sha256::digest(
        cert.tbs_certificate.subject_pki.raw,
    )))
}

fn verify_async_peer_fingerprint(
    tls: &TokioTlsStream<TokioTcpStream>,
    expected: &str,
) -> Result<(), String> {
    let der = tls
        .get_ref()
        .peer_certificate()
        .map_err(|error| format!("Unable to read node0 certificate: {error}"))?
        .ok_or("node0 did not provide a TLS certificate")?
        .to_der()
        .map_err(|error| format!("Unable to decode node0 certificate: {error}"))?;
    let actual = fingerprint_der(&der)?;
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err("node0 TLS public key changed; pairing must be reviewed again".into())
    }
}

fn discover_root() -> Option<String> {
    let daemon = ServiceDaemon::new().ok()?;
    let receiver = daemon.browse("_keelink._tcp.local.").ok()?;
    let deadline = Instant::now() + Duration::from_millis(700);
    while Instant::now() < deadline {
        if let Ok(ServiceEvent::ServiceResolved(info)) =
            receiver.recv_timeout(Duration::from_millis(100))
        {
            if let Some(IpAddr::V4(address)) = info
                .get_addresses()
                .iter()
                .find(|ip| ip.is_ipv4())
                .map(|ip| ip.to_ip_addr())
            {
                let _ = daemon.shutdown();
                return Some(address.to_string());
            }
        }
    }
    let _ = daemon.shutdown();
    None
}

fn make_frame<F>(
    kind: Kind,
    channel: u16,
    message_id: u32,
    correlation_id: u32,
    fill: F,
) -> Result<Vec<u8>, String>
where
    F: FnOnce(&mut Vec<u8>) -> Result<(), keemash_keelink::CodecError>,
{
    let mut payload = Vec::new();
    fill(&mut payload).map_err(|error| format!("KeeLink payload error: {error:?}"))?;
    let header = Header {
        kind,
        flags: 0,
        channel,
        payload_len: payload.len() as u32,
        session_id: 0,
        message_id,
        correlation_id,
    }
    .encode()
    .map_err(|error| format!("KeeLink header error: {error:?}"))?;
    let mut frame = header.to_vec();
    frame.extend_from_slice(&payload);
    Ok(frame)
}

fn controller_id(record: &CredentialRecord) -> fabric::Id128 {
    let digest = Sha256::digest(format!("{}:{}", record.root_mac, record.token).as_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid_to_id(Uuid::from_bytes(bytes))
}

fn make_fabric_hello(session: &FabricSession, live: &LiveState) -> Vec<u8> {
    let cursors = (1..=FABRIC_TRAFFIC_CLASS_COUNT)
        .map(|traffic_class| fabric::ResumeCursor {
            traffic_class: traffic_class as i32,
            sequence: live.fabric_cursors[traffic_class],
        })
        .collect();
    encode_fabric_wire(&fabric::Envelope {
        protocol_version: FABRIC_VERSION,
        traffic_class: fabric::TrafficClass::TrafficGraph as i32,
        delivery: fabric::DeliveryMode::DeliveryReliable as i32,
        root_session: 0,
        transport_session: Some(session.transport_session),
        source_node_id: None,
        target_node_id: None,
        operation_id: None,
        sequence: 1,
        correlation: 0,
        graph_revision: 0,
        body: Some(fabric::envelope::Body::Hello(fabric::Hello {
            protocol_version: FABRIC_VERSION,
            max_frame: FABRIC_MAX_WIRE_FRAME as u32,
            capabilities: fabric_capability::TYPED_GRAPH
                | fabric_capability::RESUME
                | fabric_capability::OPERATION_ID
                | fabric_capability::LATEST_SENSOR,
            controller_id: Some(session.controller_id),
            transport_session: Some(session.transport_session),
            known_root_session: live.fabric_root_session,
            manifest_digest: Vec::new(),
            cursors,
            zero_rtt: false,
        })),
    })
}

fn make_fabric_control(
    session: &FabricSession,
    root_mac: &str,
    target_mac: &str,
    command: &str,
    correlation: u32,
    operation_id: fabric::Id128,
) -> Result<Vec<u8>, String> {
    let root_mac = parse_root_mac(root_mac)?;
    let target_mac_bytes = parse_root_mac(target_mac)?;
    let target_node_id = legacy_node_id(root_mac, target_mac_bytes);
    Ok(encode_fabric_wire(&fabric::Envelope {
        protocol_version: FABRIC_VERSION,
        traffic_class: fabric::TrafficClass::TrafficControl as i32,
        delivery: fabric::DeliveryMode::DeliveryReliable as i32,
        root_session: session.root_session,
        transport_session: Some(session.transport_session),
        source_node_id: None,
        target_node_id: Some(target_node_id),
        operation_id: Some(operation_id),
        sequence: correlation as u64,
        correlation: correlation as u64,
        graph_revision: 0,
        body: Some(fabric::envelope::Body::ControlRequest(
            fabric::ControlRequest {
                operation_id: Some(operation_id),
                target_node_id: Some(target_node_id),
                endpoint_id: None,
                command: command.to_string(),
                payload: target_mac_bytes.to_vec(),
                read_only: is_latency_query(command),
            },
        )),
    }))
}

fn pending_fabric_replays(
    pending: &HashMap<u32, PendingCommand>,
    session: &FabricSession,
    root_mac: &str,
) -> Result<Vec<(u32, fabric::Id128, Vec<u8>)>, String> {
    if !session.enabled || !session.welcomed || session.root_session == 0 {
        return Ok(Vec::new());
    }
    pending
        .iter()
        .filter_map(|(correlation_id, item)| {
            let operation_id = item.operation_id?;
            (item.replay_required && item.root_session == session.root_session).then_some((
                *correlation_id,
                operation_id,
                &item.target_mac,
                &item.command,
            ))
        })
        .map(|(correlation_id, operation_id, target_mac, command)| {
            make_fabric_control(
                session,
                root_mac,
                target_mac,
                command,
                correlation_id,
                operation_id,
            )
            .map(|frame| (correlation_id, operation_id, frame))
        })
        .collect()
}

fn mark_pending_replayed(
    pending: &mut HashMap<u32, PendingCommand>,
    correlation_id: u32,
    operation_id: &fabric::Id128,
    connection_id: u32,
) {
    if let Some(item) = pending.get_mut(&correlation_id) {
        if item.operation_id.as_ref() == Some(operation_id) {
            item.connection_id = connection_id;
            item.replay_required = false;
        }
    }
}

#[derive(Default)]
struct SnapshotAssembler {
    id: u32,
    parts: Vec<Option<Vec<u8>>>,
}

#[derive(Default)]
struct SnapshotState {
    legacy: SnapshotAssembler,
    fabric_graph: FabricGraphAssembler,
}

struct FabricGraphSnapshot {
    revision: u64,
    nodes: Vec<fabric::NodeDescriptor>,
}

#[derive(Default)]
struct FabricGraphAssembler {
    revision: u64,
    page_count: usize,
    pages: Vec<Option<Vec<fabric::NodeDescriptor>>>,
}

impl FabricGraphAssembler {
    fn push(
        &mut self,
        graph: fabric::GraphSnapshot,
    ) -> Result<Option<FabricGraphSnapshot>, String> {
        let page_count = graph.page_count as usize;
        let page_index = graph.page_index as usize;
        if graph.revision == 0 || page_count == 0 || page_count > 64 || page_index >= page_count {
            return Err("invalid Fabric graph page bounds".into());
        }
        if self.revision != graph.revision || self.page_count != page_count {
            self.revision = graph.revision;
            self.page_count = page_count;
            self.pages = vec![None; page_count];
        }
        self.pages[page_index] = Some(graph.nodes);
        if self.pages.iter().any(Option::is_none) {
            return Ok(None);
        }

        let mut nodes = Vec::new();
        for page in &mut self.pages {
            if let Some(page_nodes) = page.take() {
                nodes.extend(page_nodes);
            }
        }
        self.pages.clear();
        if nodes.len() > 256 {
            return Err("Fabric graph node count exceeds the desktop limit".into());
        }
        Ok(Some(FabricGraphSnapshot {
            revision: self.revision,
            nodes,
        }))
    }
}

fn update_fabric_inventory(
    root_mac: &str,
    revision: u64,
    nodes: &[fabric::NodeDescriptor],
    inventory: &mut HashMap<String, String>,
    task_inventory: &mut HashMap<String, String>,
) -> Result<Value, String> {
    let root = parse_root_mac(root_mac)?;
    let mut seen_macs = HashSet::new();
    let mut tag_counts = HashMap::<String, usize>::new();
    let mut validated = Vec::with_capacity(nodes.len());

    for node in nodes {
        if node.route_mac.len() != 6 || node.tag.trim().is_empty() {
            return Err("Fabric graph contains an invalid node descriptor".into());
        }
        let mut route = [0_u8; 6];
        route.copy_from_slice(&node.route_mac);
        let mac = hex::encode(route);
        if !seen_macs.insert(mac.clone()) {
            return Err(format!("Fabric graph contains duplicate MAC {mac}"));
        }
        let expected = legacy_node_id(root, route);
        if node.node_id.as_ref() != Some(&expected) {
            return Err(format!("Fabric graph identity mismatch for {mac}"));
        }
        let tag = node.tag.trim().to_ascii_lowercase();
        if node.online {
            *tag_counts.entry(tag.clone()).or_default() += 1;
        }
        validated.push((tag, mac, node));
    }

    inventory.clear();
    task_inventory.clear();
    let mut event_nodes = Vec::with_capacity(validated.len());
    for (tag, mac, node) in validated {
        if node.online {
            task_inventory.insert(mac.clone(), mac.clone());
            if tag_counts.get(&tag) == Some(&1) {
                inventory.insert(tag.clone(), mac.clone());
            }
        }
        event_nodes.push(serde_json::json!({
            "nodeId": node.node_id.as_ref().map(|id| format!("{:016x}{:016x}", id.high, id.low)),
            "mac": mac,
            "tag": node.tag,
            "bootSession": node.boot_session,
            "coreVersion": node.core_version,
            "online": node.online,
            "duplicateTag": tag_counts.get(&tag).copied().unwrap_or(0) > 1,
        }));
    }
    Ok(serde_json::json!({
        "revision": revision,
        "nodes": event_nodes,
        "nodeCount": event_nodes.len(),
    }))
}

impl SnapshotAssembler {
    fn push(&mut self, payload: &[u8]) -> Result<Option<Value>, String> {
        let fields = read_fields(payload)?;
        let id = field_u32(&fields, FIELD_SNAPSHOT_ID).ok_or("inventory snapshot has no id")?;
        let index = field_u32(&fields, FIELD_PART_INDEX)
            .ok_or("inventory snapshot has no part index")? as usize;
        let count = field_u32(&fields, FIELD_PART_COUNT)
            .ok_or("inventory snapshot has no part count")? as usize;
        let data =
            field_bytes(&fields, FIELD_INVENTORY_JSON).ok_or("inventory snapshot has no data")?;
        if count == 0 || count > 16 || index >= count {
            return Err("invalid inventory snapshot bounds".into());
        }
        if self.id != id || self.parts.len() != count {
            self.id = id;
            self.parts = vec![None; count];
        }
        self.parts[index] = Some(data.to_vec());
        if self.parts.iter().any(Option::is_none) {
            return Ok(None);
        }
        let mut all = Vec::new();
        for part in &self.parts {
            let Some(part) = part.as_ref() else {
                return Ok(None);
            };
            all.extend_from_slice(part);
        }
        self.parts.clear();
        serde_json::from_slice(&all)
            .map(Some)
            .map_err(|error| format!("Invalid inventory JSON: {error}"))
    }
}

fn update_task_inventory(value: &Value, inventory: &mut HashMap<String, String>) {
    let Some(nodes) = value.get("nodes").and_then(Value::as_array) else {
        return;
    };
    inventory.clear();
    for node in nodes {
        if let Some(mac) = node.get("mac").and_then(Value::as_str) {
            if mac.len() == 12 && mac.bytes().all(|b| b.is_ascii_hexdigit()) {
                inventory.insert(mac.to_ascii_lowercase(), mac.to_ascii_lowercase());
            }
        }
    }
}

fn update_inventory(value: &Value, inventory: &mut HashMap<String, String>) {
    let Some(nodes) = value.get("nodes").and_then(Value::as_array) else {
        return;
    };
    inventory.clear();
    for node in nodes {
        if node
            .get("offline")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        if let (Some(tag), Some(mac)) = (
            node.get("tag").and_then(Value::as_str),
            node.get("mac").and_then(Value::as_str),
        ) {
            inventory.insert(tag.to_ascii_lowercase(), mac.to_string());
        }
    }
}

#[derive(Clone)]
struct RawField {
    id: u16,
    value_type: u8,
    value: Vec<u8>,
}

fn read_fields(payload: &[u8]) -> Result<Vec<RawField>, String> {
    TlvIter::new(payload)
        .map(|item| {
            let tlv = item.map_err(|error| format!("Invalid KeeLink TLV: {error:?}"))?;
            Ok(RawField {
                id: tlv.field_id,
                value_type: tlv.value_type,
                value: tlv.value.to_vec(),
            })
        })
        .collect()
}

fn field_u32(fields: &[RawField], id: u16) -> Option<u32> {
    let field = fields
        .iter()
        .find(|field| field.id == id && field.value.len() == 4)?;
    Some(u32::from_le_bytes(field.value.as_slice().try_into().ok()?))
}

fn field_bytes(fields: &[RawField], id: u16) -> Option<&[u8]> {
    fields
        .iter()
        .find(|field| field.id == id)
        .map(|field| field.value.as_slice())
}

fn fields_to_json(payload: &[u8]) -> Result<Value, String> {
    let mut object = serde_json::Map::new();
    for field in read_fields(payload)? {
        let name = match field.id {
            FIELD_TEXT => "text",
            FIELD_STATUS => "status",
            FIELD_TARGET_MAC => "targetMac",
            FIELD_TAG => "tag",
            _ => continue,
        };
        let value = match field.value_type {
            1 if field.value.len() == 4 => Value::from(u32::from_le_bytes(
                field.value.as_slice().try_into().unwrap(),
            )),
            4 if field.value.len() == 1 => Value::from(field.value[0] != 0),
            6 => Value::from(String::from_utf8_lossy(&field.value).into_owned()),
            _ => continue,
        };
        object.insert(name.into(), value);
    }
    Ok(Value::Object(object))
}

fn next_connection_id() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    next_nonzero(&NEXT)
}

fn next_nonzero(counter: &AtomicU32) -> u32 {
    loop {
        let value = counter.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        if value != 0 {
            return value;
        }
    }
}

fn set_status(inner: &Arc<RootInner>, app: &AppHandle, status: RootStatus) {
    *inner.status.lock().unwrap_or_else(|p| p.into_inner()) = status.clone();
    let _ = app.emit("mesh-status", status);
}

fn set_error(inner: &Arc<RootInner>, app: &AppHandle, phase: &str, error: String) {
    eprintln!("KeeLink {phase}: {error}");
    let mut status = inner.status.lock().unwrap_or_else(|p| p.into_inner());
    status.connected = false;
    status.transport = "none".into();
    status.reconnect_phase = phase.into();
    status.last_error = Some(error);
    let snapshot = status.clone();
    drop(status);
    let _ = app.emit("mesh-status", snapshot);
}

fn set_connecting(
    inner: &Arc<RootInner>,
    app: &AppHandle,
    record: &CredentialRecord,
    address: &str,
    offline: Duration,
) {
    set_status(
        inner,
        app,
        RootStatus {
            connected: false,
            paired: true,
            transport: if offline >= BLE_FALLBACK_DELAY {
                "ble"
            } else {
                "none"
            }
            .into(),
            root_identity: Some(record.root_mac.clone()),
            address: Some(address.into()),
            security: "tls-pinned + token".into(),
            latency_ms: None,
            connection_id: 0,
            reconnect_phase: if offline >= BLE_FALLBACK_DELAY {
                "ble-fallback"
            } else {
                "wss-connecting"
            }
            .into(),
            last_error: None,
        },
    );
}

fn ws_error(error: tokio_tungstenite::tungstenite::Error) -> String {
    format!("KeeLink WSS error: {error}")
}

struct BleSession {
    peripheral: BlePeripheral,
    request: Characteristic,
    response: Characteristic,
    notifications: Pin<Box<dyn Stream<Item = ValueNotification> + Send>>,
}

struct BleFallback {
    runtime: tokio::runtime::Runtime,
    session: Option<BleSession>,
    next_correlation: u32,
}

impl BleFallback {
    fn new() -> Result<Self, String> {
        Ok(Self {
            runtime: tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| format!("BLE runtime failed: {error}"))?,
            session: None,
            next_correlation: 1,
        })
    }

    fn ensure_connected(&mut self, record: &CredentialRecord) -> Result<(), String> {
        if let Some(session) = self.session.as_ref() {
            if self
                .runtime
                .block_on(session.peripheral.is_connected())
                .unwrap_or(false)
            {
                return Ok(());
            }
        }
        self.disconnect();
        self.session = Some(self.runtime.block_on(ble_open(record))?);
        Ok(())
    }

    fn request(
        &mut self,
        record: &CredentialRecord,
        frame: &[u8],
        correlation: u32,
    ) -> Result<Vec<u8>, String> {
        self.ensure_connected(record)?;
        let session = self
            .session
            .as_mut()
            .ok_or("BLE session disappeared after connection")?;
        let result = self
            .runtime
            .block_on(ble_exchange(session, frame, correlation));
        if result.is_err() {
            self.disconnect();
        }
        result
    }

    fn correlation(&mut self) -> u32 {
        let value = self.next_correlation.max(1);
        self.next_correlation = self.next_correlation.wrapping_add(1).max(1);
        value
    }

    fn disconnect(&mut self) {
        if let Some(session) = self.session.take() {
            let _ = self.runtime.block_on(session.peripheral.disconnect());
        }
    }
}

impl Drop for BleFallback {
    fn drop(&mut self) {
        self.disconnect();
    }
}

async fn ble_open(record: &CredentialRecord) -> Result<BleSession, String> {
    let service_uuid = Uuid::parse_str(BLE_SERVICE_UUID).map_err(|e| e.to_string())?;
    let manager = BleManager::new()
        .await
        .map_err(|e| format!("BLE manager failed: {e}"))?;
    let adapter = manager
        .adapters()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .next()
        .ok_or("No Bluetooth adapter is available")?;
    adapter
        .start_scan(ScanFilter {
            services: vec![service_uuid],
        })
        .await
        .map_err(|e| e.to_string())?;
    let mut selected = None;
    let scan_timeout = Duration::from_secs(12);
    let scan_deadline = Instant::now() + scan_timeout;
    while selected.is_none() && Instant::now() < scan_deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
        for peripheral in adapter.peripherals().await.map_err(|e| e.to_string())? {
            let properties = peripheral.properties().await.map_err(|e| e.to_string())?;
            if properties
                .as_ref()
                .and_then(|p| p.local_name.as_deref())
                .is_some_and(|name| name == "KeeMASH root" || name.starts_with("KeeMASH-"))
                || properties
                    .as_ref()
                    .map(|p| p.services.contains(&service_uuid))
                    .unwrap_or(false)
            {
                selected = Some(peripheral);
                break;
            }
        }
    }
    let _ = adapter.stop_scan().await;
    let peripheral = selected.ok_or_else(|| {
        format!(
            "KeeMASH root BLE advertisement was not found within {}s",
            scan_timeout.as_secs()
        )
    })?;
    peripheral
        .connect()
        .await
        .map_err(|e| format!("BLE connect failed: {e}"))?;
    peripheral
        .discover_services()
        .await
        .map_err(|e| format!("BLE discovery failed: {e}"))?;
    let chars = peripheral.characteristics();
    let find = |text: &str| -> Result<Characteristic, String> {
        let uuid = Uuid::parse_str(text).map_err(|e| e.to_string())?;
        chars
            .iter()
            .find(|c| c.uuid == uuid)
            .cloned()
            .ok_or_else(|| format!("Missing BLE characteristic {text}"))
    };
    let challenge_char = find(BLE_CHALLENGE_UUID)?;
    let auth_char = find(BLE_AUTH_UUID)?;
    let request = find(BLE_REQUEST_UUID)?;
    let response = find(BLE_RESPONSE_UUID)?;
    let challenge = peripheral
        .read(&challenge_char)
        .await
        .map_err(|e| e.to_string())?;
    if challenge.len() != 30 {
        let _ = peripheral.disconnect().await;
        return Err("Invalid BLE challenge".into());
    }
    let mut token = BASE64
        .decode(record.token.as_bytes())
        .map_err(|_| "Stored KeeLink token is invalid")?;
    let verifier = Sha256::digest(&token);
    token.zeroize();
    let mut mac = HmacSha256::new_from_slice(&verifier).map_err(|e| e.to_string())?;
    mac.update(&challenge);
    let auth = mac.finalize().into_bytes();
    peripheral
        .write(&auth_char, &auth, WriteType::WithResponse)
        .await
        .map_err(|e| format!("BLE authentication failed: {e}"))?;
    peripheral
        .subscribe(&response)
        .await
        .map_err(|e| e.to_string())?;
    let notifications = peripheral
        .notifications()
        .await
        .map_err(|e| format!("BLE notifications failed: {e}"))?;
    Ok(BleSession {
        peripheral,
        request,
        response,
        notifications,
    })
}

async fn ble_exchange(
    session: &mut BleSession,
    frame: &[u8],
    correlation: u32,
) -> Result<Vec<u8>, String> {
    for (offset, chunk) in frame.chunks(180).enumerate() {
        let byte_offset = offset * 180;
        let mut fragment = Vec::with_capacity(6 + chunk.len());
        fragment.extend_from_slice(&(frame.len() as u16).to_le_bytes());
        fragment.extend_from_slice(&(byte_offset as u16).to_le_bytes());
        fragment.extend_from_slice(&(chunk.len() as u16).to_le_bytes());
        fragment.extend_from_slice(chunk);
        session
            .peripheral
            .write(&session.request, &fragment, WriteType::WithResponse)
            .await
            .map_err(|e| e.to_string())?;
    }
    let deadline = tokio::time::sleep(COMMAND_TIMEOUT);
    tokio::pin!(deadline);
    let mut assembled = Vec::new();
    let mut expected = 0usize;
    loop {
        tokio::select! {
            _ = &mut deadline => {
                return Err("BLE KeeLink request timed out".into());
            },
            item = session.notifications.next() => {
                let item = item.ok_or("BLE notification stream closed")?;
                if item.uuid != session.response.uuid || item.value.len() < 6 { continue; }
                let total = u16::from_le_bytes([item.value[0], item.value[1]]) as usize;
                let offset = u16::from_le_bytes([item.value[2], item.value[3]]) as usize;
                let len = u16::from_le_bytes([item.value[4], item.value[5]]) as usize;
                if total > HEADER_SIZE + keemash_keelink::MAX_PAYLOAD ||
                   len != item.value.len() - 6 || offset != expected || offset + len > total {
                    return Err("Invalid BLE KeeLink fragment".into());
                }
                if offset == 0 { assembled = Vec::with_capacity(total); }
                assembled.extend_from_slice(&item.value[6..]);
                expected += len;
                if expected == total {
                    let header = Header::decode(&assembled)
                        .map_err(|error| format!("Invalid BLE KeeLink frame: {error:?}"))?;
                    if header.correlation_id == correlation {
                        return Ok(assembled);
                    }
                    assembled.clear();
                    expected = 0;
                }
            }
        }
    }
}

fn ble_inventory(fallback: &mut BleFallback, record: &CredentialRecord) -> Result<Value, String> {
    let correlation = fallback.correlation();
    let frame = make_frame(
        Kind::Request,
        CH_INVENTORY,
        correlation,
        correlation,
        |_| Ok(()),
    )?;
    let response = fallback.request(record, &frame, correlation)?;
    let header =
        Header::decode(&response).map_err(|e| format!("Invalid BLE inventory response: {e:?}"))?;
    if header.kind != Kind::Snapshot || header.channel != CH_INVENTORY {
        return Err("BLE root returned an unexpected inventory response".into());
    }
    let fields = read_fields(&response[HEADER_SIZE..])?;
    let json =
        field_bytes(&fields, FIELD_INVENTORY_JSON).ok_or("BLE inventory response has no data")?;
    serde_json::from_slice(json).map_err(|e| format!("Invalid BLE inventory JSON: {e}"))
}

fn ble_command(
    fallback: &mut BleFallback,
    record: &CredentialRecord,
    target_mac: &str,
    command: &str,
) -> Result<MeshCommandResult, String> {
    let correlation = fallback.correlation();
    let frame = make_frame(
        Kind::Request,
        CH_CONTROL,
        correlation,
        correlation,
        |payload| {
            put_utf8(payload, FIELD_TARGET_MAC, target_mac)?;
            put_utf8(payload, FIELD_COMMAND, command)
        },
    )?;
    let response = fallback.request(record, &frame, correlation)?;
    let header =
        Header::decode(&response).map_err(|e| format!("Invalid BLE KeeLink response: {e:?}"))?;
    if !matches!(header.kind, Kind::Response | Kind::Error)
        || header.channel != CH_CONTROL
        || header.correlation_id != correlation
    {
        return Err("BLE root returned an unexpected command response".into());
    }
    let fields = fields_to_json(&response[HEADER_SIZE..])?;
    Ok(MeshCommandResult {
        correlation_id: header.correlation_id,
        status: fields.get("status").and_then(Value::as_u64).unwrap_or(1) as u32,
        text: fields
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        transport: "ble".into(),
    })
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn parse_root_mac(text: &str) -> Result<[u8; 6], String> {
    let bytes = hex::decode(text).map_err(|_| "node0 returned an invalid root MAC")?;
    bytes
        .try_into()
        .map_err(|_| "node0 returned an invalid root MAC".into())
}

fn uart_claim_proof(token: &[u8; 32], nonce: &[u8; 16], root_mac: &[u8; 6]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(token).expect("HMAC accepts a 32-byte key");
    mac.update(UART_CLAIM_CONTEXT);
    mac.update(nonce);
    mac.update(root_mac);
    mac.finalize().into_bytes().into()
}

fn validate_uart_claim_response(
    responses: &[String],
    session: &str,
    nonce: &[u8; 16],
    token: &[u8; 32],
    root_mac: &[u8; 6],
) -> Result<(), String> {
    if responses.len() != 4 || session.len() != 4 {
        return Err("node0 returned an incomplete commissioning response".into());
    }
    let mut parts = [None, None, None, None];
    let prefix = format!("KC1:{session}:P");
    for response in responses {
        let payload = response
            .strip_prefix(&prefix)
            .ok_or("node0 returned an invalid commissioning response")?;
        let (index_text, chunk) = payload
            .split_once(':')
            .ok_or("node0 returned an invalid commissioning response")?;
        let index = index_text
            .parse::<usize>()
            .map_err(|_| "node0 returned an invalid commissioning response")?;
        if index >= parts.len() || chunk.len() != 11 || parts[index].is_some() {
            return Err("node0 returned an invalid commissioning response".into());
        }
        parts[index] = Some(chunk);
    }
    let proof_text = parts
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or("node0 returned an incomplete commissioning response")?
        .concat();
    let mut proof = BASE64
        .decode(proof_text)
        .map_err(|_| "node0 returned an invalid commissioning proof")?;
    let expected = uart_claim_proof(token, nonce, root_mac);
    let difference = proof
        .iter()
        .zip(expected.iter())
        .fold(0_u8, |difference, (actual, expected)| {
            difference | (actual ^ expected)
        });
    if proof.len() != expected.len() || difference != 0 {
        proof.zeroize();
        return Err("node0 commissioning proof verification failed".into());
    }
    proof.zeroize();
    Ok(())
}

#[cfg(windows)]
fn credential_write(record: &CredentialRecord) -> Result<(), String> {
    let mut target = wide(CREDENTIAL_TARGET);
    let mut user = wide("KeeMASH");
    let mut blob = serde_json::to_vec(record).map_err(|error| error.to_string())?;
    let credential = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        Comment: std::ptr::null_mut(),
        LastWritten: FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        },
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: std::ptr::null_mut(),
        UserName: user.as_mut_ptr(),
    };
    let ok = unsafe { CredWriteW(&credential, 0) } != 0;
    blob.zeroize();
    if ok {
        Ok(())
    } else {
        Err(format!(
            "CredWriteW failed: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(windows)]
fn credential_read() -> Result<Option<CredentialRecord>, String> {
    let target = wide(CREDENTIAL_TARGET);
    let mut pointer: *mut CREDENTIALW = std::ptr::null_mut();
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pointer) } == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(1168) {
            return Ok(None);
        }
        return Err(format!("CredReadW failed: {error}"));
    }
    if pointer.is_null() {
        return Ok(None);
    }
    let credential = unsafe { &*pointer };
    let bytes = unsafe {
        std::slice::from_raw_parts(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        )
    };
    let result = serde_json::from_slice(bytes)
        .map(Some)
        .map_err(|error| format!("Stored KeeLink credential is invalid: {error}"));
    unsafe { CredFree(pointer.cast()) };
    result
}

#[cfg(not(windows))]
fn credential_write(_record: &CredentialRecord) -> Result<(), String> {
    Err("Windows Credential Manager is required".into())
}
#[cfg(not(windows))]
fn credential_read() -> Result<Option<CredentialRecord>, String> {
    Ok(None)
}

#[cfg(windows)]
fn credential_delete() -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::CredDeleteW;
    let target = wide(CREDENTIAL_TARGET);
    if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(1168) {
            Ok(())
        } else {
            Err(format!("CredDeleteW failed: {error}"))
        }
    }
}

#[cfg(not(windows))]
fn credential_delete() -> Result<(), String> {
    Ok(())
}

use std::net::ToSocketAddrs;

#[cfg(test)]
mod tests {
    fn fabric_pending(
        root_session: u64,
        started: std::time::Instant,
    ) -> (
        super::PendingCommand,
        std::sync::mpsc::Receiver<Result<super::MeshCommandResult, String>>,
    ) {
        let (result, receiver) = std::sync::mpsc::channel();
        (
            super::PendingCommand {
                result,
                started,
                target_mac: "08a6f765cea0".into(),
                command: "choinka.status".into(),
                read_only: true,
                connection_id: 3,
                root_session,
                operation_id: Some(super::new_operation_id()),
                replay_required: false,
            },
            receiver,
        )
    }

    #[test]
    fn fabric_pending_command_survives_transport_reconnect() {
        let (command, receiver) = fabric_pending(77, std::time::Instant::now());
        let mut pending = std::collections::HashMap::from([(41, command)]);
        let unknown = super::reconcile_pending_root_session(&mut pending, 77, 9);
        assert!(unknown.is_empty());
        assert_eq!(pending.get(&41).unwrap().connection_id, 3);
        assert!(pending.get(&41).unwrap().replay_required);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn fabric_reconnect_replays_same_operation_and_command_once() {
        let (command, _receiver) = fabric_pending(77, std::time::Instant::now());
        let operation_id = command.operation_id.unwrap();
        let mut pending = std::collections::HashMap::from([(41, command)]);
        assert!(super::reconcile_pending_root_session(&mut pending, 77, 9).is_empty());
        let session = super::FabricSession {
            enabled: true,
            controller_id: super::new_operation_id(),
            transport_session: super::new_operation_id(),
            root_session: 77,
            welcomed: true,
            source_gap_reported: false,
        };
        let replays = super::pending_fabric_replays(&pending, &session, "b43a45a7868c").unwrap();
        assert_eq!(replays.len(), 1);
        assert_eq!(replays[0].0, 41);
        assert_eq!(replays[0].1, operation_id);
        let envelope = super::decode_fabric_wire(&replays[0].2).unwrap();
        assert_eq!(envelope.operation_id, Some(operation_id));
        let Some(super::fabric::envelope::Body::ControlRequest(request)) = envelope.body else {
            panic!("expected CONTROL request");
        };
        assert_eq!(request.operation_id, Some(operation_id));
        assert_eq!(request.command, "choinka.status");

        super::mark_pending_replayed(&mut pending, 41, &operation_id, 9);
        assert_eq!(pending.get(&41).unwrap().connection_id, 9);
        assert!(!pending.get(&41).unwrap().replay_required);
        assert!(
            super::pending_fabric_replays(&pending, &session, "b43a45a7868c")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn root_session_reset_reports_unknown_outcome_without_replay() {
        let (command, receiver) = fabric_pending(77, std::time::Instant::now());
        let mut pending = std::collections::HashMap::from([(42, command)]);
        assert_eq!(
            super::reconcile_pending_root_session(&mut pending, 78, 10),
            vec![42]
        );
        assert!(pending.is_empty());
        let error = receiver.recv().unwrap().unwrap_err();
        assert!(error.contains("outcome_unknown"));
        assert!(error.contains("root boot session changed"));
    }

    #[test]
    fn fabric_pending_deadline_reports_unknown_outcome() {
        let started = std::time::Instant::now()
            - super::COMMAND_TIMEOUT
            - std::time::Duration::from_millis(1);
        let (command, receiver) = fabric_pending(77, started);
        let mut pending = std::collections::HashMap::from([(43, command)]);
        assert_eq!(super::expire_pending_commands(&mut pending), vec![43]);
        assert!(pending.is_empty());
        assert!(receiver
            .recv()
            .unwrap()
            .unwrap_err()
            .contains("outcome_unknown"));
    }

    #[test]
    fn fabric_hello_carries_root_session_and_every_class_cursor() {
        let mut live = super::LiveState {
            fabric_root_session: 77,
            ..Default::default()
        };
        for traffic_class in 1..=super::FABRIC_TRAFFIC_CLASS_COUNT {
            live.fabric_cursors[traffic_class] = (traffic_class as u64) * 10;
        }
        let session = super::FabricSession {
            enabled: true,
            controller_id: super::new_operation_id(),
            transport_session: super::new_operation_id(),
            root_session: 0,
            welcomed: false,
            source_gap_reported: false,
        };
        let frame = super::make_fabric_hello(&session, &live);
        let envelope = super::decode_fabric_wire(&frame).unwrap();
        let Some(super::fabric::envelope::Body::Hello(hello)) = envelope.body else {
            panic!("expected Fabric HELLO");
        };
        assert_eq!(hello.known_root_session, 77);
        assert_eq!(hello.cursors.len(), super::FABRIC_TRAFFIC_CLASS_COUNT);
        for cursor in hello.cursors {
            assert_eq!(
                cursor.sequence,
                (cursor.traffic_class as u64) * 10,
                "cursor for class {}",
                cursor.traffic_class
            );
        }
    }

    #[test]
    fn fabric_cursors_dedupe_per_class_without_cross_class_aliasing() {
        let mut live = super::LiveState::default();
        super::fabric_record_cursor(
            &mut live,
            super::fabric::TrafficClass::TrafficSensor as i32,
            9,
        );
        assert!(super::fabric_sequence_consumed(
            &live,
            super::fabric::TrafficClass::TrafficSensor as i32,
            9
        ));
        assert!(!super::fabric_sequence_consumed(
            &live,
            super::fabric::TrafficClass::TrafficGraph as i32,
            9
        ));
        assert!(!super::fabric_sequence_consumed(
            &live,
            super::fabric::TrafficClass::TrafficSensor as i32,
            10
        ));
    }

    #[test]
    fn fabric_source_identity_isolated_by_root_and_route_mac() {
        let root = "b43a45a7868d";
        let heater_mac = "a0dd6c1028bc";
        let choinka_mac = "08a6f765cea0";
        let inventory = std::collections::HashMap::from([
            ("kheater".into(), heater_mac.into()),
            ("choinka".into(), choinka_mac.into()),
        ]);
        let heater_id = super::legacy_node_id(
            super::parse_root_mac(root).unwrap(),
            super::parse_root_mac(heater_mac).unwrap(),
        );
        let unknown_id =
            super::legacy_node_id(super::parse_root_mac(root).unwrap(), [1, 2, 3, 4, 5, 6]);
        assert_eq!(
            super::fabric_source_mac(root, &inventory, Some(&heater_id)).as_deref(),
            Some(heater_mac)
        );
        assert_eq!(
            super::fabric_source_mac(root, &inventory, Some(&unknown_id)),
            None
        );
        assert_eq!(super::fabric_source_mac(root, &inventory, None), None);
    }

    #[test]
    fn fabric_data_requires_the_welcomed_transport_and_root_sessions() {
        let transport = super::new_operation_id();
        let session = super::FabricSession {
            enabled: true,
            controller_id: super::new_operation_id(),
            transport_session: transport,
            root_session: 42,
            welcomed: true,
            source_gap_reported: false,
        };
        let mut envelope = super::fabric::Envelope {
            protocol_version: super::FABRIC_VERSION,
            root_session: 42,
            transport_session: Some(transport),
            ..Default::default()
        };
        assert!(super::fabric_data_session_valid(&envelope, &session));
        envelope.root_session = 43;
        assert!(!super::fabric_data_session_valid(&envelope, &session));
        envelope.root_session = 42;
        envelope.transport_session = Some(super::new_operation_id());
        assert!(!super::fabric_data_session_valid(&envelope, &session));
    }

    #[test]
    fn fabric_sensor_translation_preserves_metric_metadata_and_rejects_text() {
        let sample = super::fabric::TelemetrySample {
            boot_session: 9,
            acquisition_mono_us: 12_345_000,
            validity: super::fabric::Validity::Stale as i32,
            quality_flags: 3,
            value: Some(super::fabric::telemetry_sample::Value::Sint64Value(281)),
            generation: 7,
            request_id: 11,
            metric_id: 2,
            scale10: -1,
            ..Default::default()
        };
        let value = super::fabric_telemetry_data(&sample).unwrap();
        assert_eq!(value["sampleUptimeMs"], 12_345);
        assert_eq!(value["id"], 2);
        assert_eq!(value["status"], 3);
        assert_eq!(value["scale10"], -1);
        assert_eq!(value["value"], 281.0);
        assert_eq!(value["bootSession"], 9);

        let text = super::fabric::TelemetrySample {
            value: Some(super::fabric::telemetry_sample::Value::StringValue(
                "28.1".into(),
            )),
            ..Default::default()
        };
        assert!(super::fabric_telemetry_data(&text).is_err());
    }

    #[test]
    fn offline_nodes_allow_monitoring_but_not_control_routing() {
        let value = serde_json::json!({"nodes": [{"tag": "heater", "mac": "a0dd6c1028bc", "offline": true}]});
        let mut tasks = std::collections::HashMap::new();
        let mut commands = std::collections::HashMap::new();
        super::update_task_inventory(&value, &mut tasks);
        super::update_inventory(&value, &mut commands);
        assert!(commands.is_empty());
        assert!(super::task_monitor_link("192.168.1.50", None, &tasks, "a0dd6c1028bc").is_ok());
    }
    #[test]
    fn task_monitor_links_are_bound_to_root_and_inventory() {
        let inventory = std::collections::HashMap::from([("heater".into(), "a0dd6c1028bc".into())]);
        assert_eq!(
            super::task_monitor_link(
                "192.168.1.50",
                Some("b43a45a7868c"),
                &inventory,
                "A0DD6C1028BC"
            )
            .unwrap(),
            "https://192.168.1.50/#tasks=a0dd6c1028bc"
        );
        assert!(super::task_monitor_link(
            "192.168.1.50",
            Some("b43a45a7868c"),
            &inventory,
            "b43a45a7868c"
        )
        .is_ok());
        assert!(
            super::task_monitor_link("192.168.1.50", None, &inventory, "000000000001").is_err()
        );
        assert!(
            super::task_monitor_link("192.168.1.50", None, &inventory, "a0dd6c1028bc#x").is_err()
        );
        assert!(super::task_monitor_link("host/path", None, &inventory, "a0dd6c1028bc").is_err());
        assert!(
            super::task_monitor_link("user@192.168.1.50", None, &inventory, "a0dd6c1028bc")
                .is_err()
        );
    }
    use super::*;

    fn snapshot_part(id: u32, index: u32, count: u32, bytes: &[u8]) -> Vec<u8> {
        let mut payload = Vec::new();
        put_u32(&mut payload, FIELD_SNAPSHOT_ID, id).unwrap();
        put_u32(&mut payload, FIELD_PART_INDEX, index).unwrap();
        put_u32(&mut payload, FIELD_PART_COUNT, count).unwrap();
        keemash_keelink::put_tlv(&mut payload, FIELD_INVENTORY_JSON, 5, 0, bytes).unwrap();
        payload
    }

    #[test]
    fn embedded_root_certificate_matches_compiled_spki_pin() {
        let pem = std::str::from_utf8(ROOT_CERTIFICATE_PEM).unwrap();
        let encoded = pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>();
        let der = BASE64.decode(encoded).unwrap();
        let (_, certificate) = parse_x509_certificate(&der).unwrap();
        let actual = hex::encode(Sha256::digest(certificate.tbs_certificate.subject_pki.raw));
        assert_eq!(actual, EXPECTED_ROOT_SPKI_SHA256);
    }

    #[test]
    fn wss_request_contains_upgrade_and_authorization_headers() {
        let request = wss_request("192.168.1.50", "test-token").unwrap();
        assert_eq!(request.uri(), "wss://192.168.1.50/keelink/ws");
        assert_eq!(request.headers()["host"], "192.168.1.50");
        assert_eq!(request.headers()["connection"], "Upgrade");
        assert_eq!(request.headers()["upgrade"], "websocket");
        assert_eq!(request.headers()["sec-websocket-version"], "13");
        assert!(!request.headers()["sec-websocket-key"].is_empty());
        assert_eq!(request.headers()["authorization"], "Bearer test-token");
    }

    #[test]
    fn validates_uart_commissioning_proof_and_rejects_tampering() {
        let token = [0x31_u8; 32];
        let nonce = [0x42_u8; 16];
        let root_mac = [0xb4, 0x3a, 0x45, 0xa7, 0x86, 0x8d];
        let proof = uart_claim_proof(&token, &nonce, &root_mac);
        let proof_text = BASE64.encode(proof);
        let session = "a1b2";
        let mut responses = (0..4)
            .map(|index| {
                format!(
                    "KC1:{session}:P{index}:{}",
                    &proof_text[index * 11..(index + 1) * 11]
                )
            })
            .collect::<Vec<_>>();
        validate_uart_claim_response(&responses, session, &nonce, &token, &root_mac).unwrap();

        let last = responses[3].len() - 1;
        responses[3].replace_range(last.., "A");
        assert!(
            validate_uart_claim_response(&responses, session, &nonce, &token, &root_mac).is_err()
        );
    }

    #[test]
    fn snapshot_assembler_reassembles_bounded_inventory() {
        let mut assembler = SnapshotAssembler::default();
        assert!(assembler
            .push(&snapshot_part(7, 0, 2, br#"{"nodes":[{"tag":"cho"#))
            .unwrap()
            .is_none());
        let value = assembler
            .push(&snapshot_part(7, 1, 2, br#"inka","mac":"001122334455"}]}"#))
            .unwrap()
            .unwrap();
        assert_eq!(value["nodes"][0]["tag"], "choinka");
    }

    #[test]
    fn inventory_routes_only_live_tags() {
        let value = serde_json::json!({"nodes": [
            {"tag": "choinka", "mac": "001122334455", "offline": false},
            {"tag": "old", "mac": "aabbccddeeff", "offline": true}
        ]});
        let mut inventory = HashMap::new();
        update_inventory(&value, &mut inventory);
        assert_eq!(
            inventory.get("choinka").map(String::as_str),
            Some("001122334455")
        );
        assert!(!inventory.contains_key("old"));
    }

    fn graph_node(root: [u8; 6], route: [u8; 6], tag: &str) -> fabric::NodeDescriptor {
        fabric::NodeDescriptor {
            node_id: Some(legacy_node_id(root, route)),
            route_mac: route.to_vec(),
            tag: tag.into(),
            online: true,
            ..Default::default()
        }
    }

    #[test]
    fn fabric_graph_reassembles_out_of_order_before_routing() {
        let root = [0xb4, 0x3a, 0x45, 0xa7, 0x86, 0x8c];
        let lamp = [0x28, 0x84, 0x85, 0x51, 0x9e, 0x98];
        let mut assembler = FabricGraphAssembler::default();
        let second = fabric::GraphSnapshot {
            revision: 9,
            page_index: 1,
            page_count: 2,
            nodes: vec![graph_node(root, lamp, "lampk")],
            ..Default::default()
        };
        assert!(assembler.push(second).unwrap().is_none());
        let first = fabric::GraphSnapshot {
            revision: 9,
            page_index: 0,
            page_count: 2,
            nodes: vec![graph_node(root, root, "node0")],
            ..Default::default()
        };
        let snapshot = assembler.push(first).unwrap().unwrap();
        let mut routes = HashMap::new();
        let mut tasks = HashMap::new();
        let event = update_fabric_inventory(
            "b43a45a7868c",
            snapshot.revision,
            &snapshot.nodes,
            &mut routes,
            &mut tasks,
        )
        .unwrap();
        assert_eq!(event["nodeCount"], 2);
        assert_eq!(
            routes.get("lampk").map(String::as_str),
            Some("288485519e98")
        );
        assert!(tasks.contains_key("288485519e98"));
    }

    #[test]
    fn fabric_graph_rejects_forged_identity_and_ambiguous_tags() {
        let root = [0xb4, 0x3a, 0x45, 0xa7, 0x86, 0x8c];
        let mut forged = graph_node(root, [1, 2, 3, 4, 5, 6], "forged");
        forged.node_id = Some(fabric::Id128 { high: 1, low: 2 });
        assert!(update_fabric_inventory(
            "b43a45a7868c",
            1,
            &[forged],
            &mut HashMap::new(),
            &mut HashMap::new(),
        )
        .is_err());

        let nodes = vec![
            graph_node(root, [1, 2, 3, 4, 5, 6], "duplicate"),
            graph_node(root, [6, 5, 4, 3, 2, 1], "duplicate"),
        ];
        let mut routes = HashMap::new();
        let mut tasks = HashMap::new();
        let event =
            update_fabric_inventory("b43a45a7868c", 2, &nodes, &mut routes, &mut tasks).unwrap();
        assert!(!routes.contains_key("duplicate"));
        assert_eq!(tasks.len(), 2);
        assert_eq!(event["nodes"][0]["duplicateTag"], true);
        assert_eq!(event["nodes"][1]["duplicateTag"], true);
    }

    #[test]
    fn latency_queries_exclude_root_intercepts_and_actuation() {
        assert!(!is_latency_query("heater.source?"));
        assert!(!is_latency_query("HR1"));
        assert!(!is_latency_query("lam"));
        assert!(is_latency_query("heater.climate?"));
        assert!(is_latency_query("lamech"));
        assert!(is_latency_query("bedside_echo"));
        assert!(is_latency_query("jajoeh"));
    }

    #[test]
    #[ignore = "requires a paired physical KeeLink root advertising over BLE"]
    fn live_ble_inventory_and_control() {
        let token =
            std::env::var("KEEMASH_LIVE_BLE_TOKEN").expect("KEEMASH_LIVE_BLE_TOKEN is required");
        let root_mac = std::env::var("KEEMASH_LIVE_BLE_ROOT_MAC")
            .expect("KEEMASH_LIVE_BLE_ROOT_MAC is required");
        let record = CredentialRecord {
            token,
            fingerprint: EXPECTED_ROOT_SPKI_SHA256.into(),
            root_mac,
            address: DEFAULT_ROOT.into(),
        };
        let mut fallback = BleFallback::new().expect("BLE runtime must start");
        let inventory = ble_inventory(&mut fallback, &record)
            .expect("BLE challenge/auth/inventory round trip must pass");
        assert!(
            inventory
                .get("nodes")
                .and_then(Value::as_array)
                .is_some_and(|nodes| !nodes.is_empty()),
            "BLE inventory must contain at least the root"
        );
        let choinka_mac = inventory
            .get("nodes")
            .and_then(Value::as_array)
            .and_then(|nodes| {
                nodes.iter().find_map(|node| {
                    (node.get("tag").and_then(Value::as_str) == Some("choinka"))
                        .then(|| node.get("mac").and_then(Value::as_str))
                        .flatten()
                })
            })
            .expect("live BLE inventory must contain choinka");
        let result = ble_command(&mut fallback, &record, choinka_mac, "choinka.status")
            .expect("BLE read-only CONTROL round trip must pass");
        assert_eq!(result.status, 0, "choinka.status must succeed over BLE");
        assert_eq!(result.transport, "ble");
        assert!(
            !result.text.is_empty(),
            "choinka.status must return state text"
        );
    }
}
