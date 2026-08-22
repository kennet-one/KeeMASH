use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use btleplug::api::{
    Central, Characteristic, Manager as _, Peripheral as _, ScanFilter, ValueNotification,
    WriteType,
};
use btleplug::platform::{Manager as BleManager, Peripheral as BlePeripheral};
use futures_util::{Stream, StreamExt};
use hmac::{Hmac, Mac};
use keemash_keelink::{put_u32, put_utf8, Header, Kind, TlvIter, HEADER_SIZE};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use native_tls::{TlsConnector, TlsStream};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tungstenite::client;
use tungstenite::http::Request;
use tungstenite::{Message, WebSocket};
use uuid::Uuid;
use x509_parser::parse_x509_certificate;
use zeroize::Zeroize;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{ERROR_CANCELLED, ERROR_SUCCESS, FILETIME};
#[cfg(windows)]
use windows_sys::Win32::Security::Credentials::{
    CredFree, CredReadW, CredUIPromptForCredentialsW, CredWriteW, CREDENTIALW,
    CREDUI_FLAGS_ALWAYS_SHOW_UI, CREDUI_FLAGS_DO_NOT_PERSIST, CREDUI_FLAGS_GENERIC_CREDENTIALS,
    CREDUI_FLAGS_KEEP_USERNAME, CREDUI_FLAGS_PASSWORD_ONLY_OK, CREDUI_INFOW,
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

const DEFAULT_ROOT: &str = "192.168.1.50";
const HTTPS_PORT: u16 = 443;
const CREDENTIAL_TARGET: &str = "KeeMASH/KeeLink/root";
const EXPECTED_ROOT_SPKI_SHA256: &str =
    "46247faf04cd4d6d98ad00f94c2ab28cb358f32ce4294c2af77039a7f63fbd1c";
const ROOT_CERTIFICATE_PEM: &[u8] = include_bytes!("node0_https_servercert.pem");
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const BLE_FALLBACK_DELAY: Duration = Duration::from_secs(3);
const IO_TIMEOUT: Duration = Duration::from_millis(250);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);

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

const BLE_SERVICE_UUID: &str = "8e8b7d00-2d2c-4f6e-9b15-4b65654c696e";
const BLE_CHALLENGE_UUID: &str = "8e8b7d00-2d2c-4f6e-9b15-4b65654c0001";
const BLE_AUTH_UUID: &str = "8e8b7d00-2d2c-4f6e-9b15-4b65654c0002";
const BLE_REQUEST_UUID: &str = "8e8b7d00-2d2c-4f6e-9b15-4b65654c0003";
const BLE_RESPONSE_UUID: &str = "8e8b7d00-2d2c-4f6e-9b15-4b65654c0004";

type HmacSha256 = Hmac<Sha256>;
type KeeSocket = WebSocket<TlsStream<TcpStream>>;

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
}

#[derive(Debug, Deserialize)]
struct PairResponse {
    ok: bool,
    token: String,
}

struct CommandRequest {
    owner: String,
    command: String,
    result: Sender<Result<MeshCommandResult, String>>,
}

struct PendingCommand {
    result: Sender<Result<MeshCommandResult, String>>,
    started: Instant,
}

#[derive(Default)]
struct LiveState {
    last_event: u32,
    inventory: HashMap<String, String>,
}

enum WorkerCommand {
    Wake,
    Send(CommandRequest),
    Stop,
}

struct RootInner {
    status: Mutex<RootStatus>,
    tx: Mutex<Option<Sender<WorkerCommand>>>,
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
    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        let mut worker = self.inner.worker.lock().unwrap_or_else(|p| p.into_inner());
        if worker.is_some() {
            return Ok(());
        }
        self.inner.stop.store(false, Ordering::Release);
        let (tx, rx) = mpsc::channel();
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

    pub fn pair_native(&self) -> Result<RootStatus, String> {
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
        let mut pin = prompt_admin_pin()?;
        let response = client
            .post(format!("https://{address}/keelink/pair"))
            .header("X-OTA-PIN", pin.trim())
            .send();
        pin.zeroize();
        let pair: PairResponse = response
            .map_err(|error| format!("KeeLink pairing failed: {error}"))?
            .error_for_status()
            .map_err(|error| format!("KeeLink pairing rejected: {error}"))?
            .json()
            .map_err(|error| format!("Invalid KeeLink pairing response: {error}"))?;
        if !pair.ok
            || BASE64
                .decode(pair.token.as_bytes())
                .map(|v| v.len())
                .unwrap_or(0)
                != 32
        {
            return Err("node0 returned an invalid KeeLink token".into());
        }
        let record = CredentialRecord {
            token: pair.token,
            fingerprint,
            root_mac: info.root_mac,
            address,
        };
        credential_write(&record)?;
        if let Some(tx) = self
            .inner
            .tx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            let _ = tx.send(WorkerCommand::Wake);
        }
        Ok(self.status())
    }

    pub fn revoke(&self) -> Result<(), String> {
        if let Some(record) = credential_read()? {
            let address = discover_root().unwrap_or_else(|| record.address.clone());
            let fingerprint = probe_tls_fingerprint(&address)?;
            if !fingerprint.eq_ignore_ascii_case(&record.fingerprint)
                || !fingerprint.eq_ignore_ascii_case(EXPECTED_ROOT_SPKI_SHA256)
            {
                return Err("node0 TLS public key changed; token was not revoked".into());
            }
            let mut pin = prompt_admin_pin()?;
            let response = pinned_https_client()?
                .post(format!("https://{address}/keelink/revoke"))
                .header("X-OTA-PIN", pin.trim())
                .send();
            pin.zeroize();
            response
                .map_err(|error| format!("KeeLink revoke failed: {error}"))?
                .error_for_status()
                .map_err(|error| format!("KeeLink revoke rejected: {error}"))?;
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

fn worker_main(inner: Arc<RootInner>, app: AppHandle, rx: Receiver<WorkerCommand>) {
    let mut live = LiveState::default();
    let mut ble: Option<BleFallback> = None;
    let mut offline_since = Instant::now();
    while !inner.stop.load(Ordering::Acquire) {
        let record = match credential_read() {
            Ok(Some(record)) => record,
            Ok(None) => {
                set_status(
                    &inner,
                    &app,
                    RootStatus {
                        paired: false,
                        reconnect_phase: "pairing-required".into(),
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
        match connect_wss(&record, &address) {
            Ok(mut socket) => {
                if let Some(fallback) = ble.as_mut() {
                    fallback.disconnect();
                }
                offline_since = Instant::now();
                if let Err(error) =
                    run_wss(&inner, &app, &rx, &record, &address, &mut socket, &mut live)
                {
                    set_error(&inner, &app, "reconnecting", error);
                }
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
        thread::sleep(RECONNECT_DELAY);
    }
}

fn run_wss(
    inner: &Arc<RootInner>,
    app: &AppHandle,
    rx: &Receiver<WorkerCommand>,
    record: &CredentialRecord,
    address: &str,
    socket: &mut KeeSocket,
    live: &mut LiveState,
) -> Result<(), String> {
    static CORRELATION: AtomicU32 = AtomicU32::new(1);
    let hello = make_frame(Kind::Hello, CH_SYSTEM, 1, 0, |payload| {
        put_u32(payload, FIELD_PROTOCOL_VERSION, 1)?;
        put_u32(payload, FIELD_LAST_EVENT, live.last_event)
    })?;
    socket
        .send(Message::Binary(hello.into()))
        .map_err(ws_error)?;
    let inventory_request = make_frame(Kind::Request, CH_INVENTORY, 2, 2, |_| Ok(()))?;
    socket
        .send(Message::Binary(inventory_request.into()))
        .map_err(ws_error)?;
    let log_subscription = make_frame(Kind::Request, CH_LOG, 3, 3, |payload| {
        keemash_keelink::put_bool(payload, FIELD_LOG_SUBSCRIBED, true)
    })?;
    socket
        .send(Message::Binary(log_subscription.into()))
        .map_err(ws_error)?;
    let connected_at = Instant::now();
    let mut last_rx = Instant::now();
    let mut snapshots = SnapshotAssembler::default();
    let mut pending = HashMap::<u32, PendingCommand>::new();
    set_status(
        inner,
        app,
        RootStatus {
            connected: true,
            paired: true,
            transport: "wss".into(),
            root_identity: Some(record.root_mac.clone()),
            address: Some(address.into()),
            security: "tls-pinned + token".into(),
            latency_ms: None,
            reconnect_phase: "handshake".into(),
            last_error: None,
        },
    );

    loop {
        while let Ok(command) = rx.try_recv() {
            match command {
                WorkerCommand::Stop => return Ok(()),
                WorkerCommand::Wake => return Err("connection refresh requested".into()),
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
                    let frame = make_frame(
                        Kind::Request,
                        CH_CONTROL,
                        correlation,
                        correlation,
                        |payload| {
                            put_utf8(payload, FIELD_TARGET_MAC, mac)?;
                            put_utf8(payload, FIELD_COMMAND, &request.command)
                        },
                    )?;
                    match socket.send(Message::Binary(frame.into())) {
                        Ok(()) => {
                            pending.insert(
                                correlation,
                                PendingCommand {
                                    result: request.result,
                                    started: Instant::now(),
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

        match socket.read() {
            Ok(Message::Binary(frame)) => {
                last_rx = Instant::now();
                let response_latency = handle_frame(
                    app,
                    &frame,
                    &mut live.last_event,
                    &mut live.inventory,
                    &mut snapshots,
                    &mut pending,
                )?;
                let mut status = inner.status.lock().unwrap_or_else(|p| p.into_inner());
                status.reconnect_phase = "live".into();
                if let Some(latency) = response_latency {
                    status.latency_ms = Some(latency);
                } else if status.latency_ms.is_none() {
                    status.latency_ms =
                        Some(connected_at.elapsed().as_millis().min(u32::MAX as u128) as u32);
                }
                status.last_error = None;
                let snapshot = status.clone();
                drop(status);
                let _ = app.emit("mesh-status", snapshot);
            }
            Ok(Message::Ping(value)) => {
                socket.send(Message::Pong(value)).map_err(ws_error)?;
            }
            Ok(Message::Close(_)) => return Err("WSS closed by node0".into()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(error) => return Err(ws_error(error)),
        }
        if last_rx.elapsed() > HEARTBEAT_TIMEOUT {
            return Err("KeeLink heartbeat timed out".into());
        }
        let expired: Vec<u32> = pending
            .iter()
            .filter_map(|(id, item)| (item.started.elapsed() >= COMMAND_TIMEOUT).then_some(*id))
            .collect();
        for id in expired {
            if let Some(item) = pending.remove(&id) {
                let _ = item.result.send(Err("KeeLink command timed out".into()));
            }
        }
    }
}

fn handle_frame(
    app: &AppHandle,
    frame: &[u8],
    last_event: &mut u32,
    inventory: &mut HashMap<String, String>,
    snapshots: &mut SnapshotAssembler,
    pending: &mut HashMap<u32, PendingCommand>,
) -> Result<Option<u32>, String> {
    let mut response_latency = None;
    let header =
        Header::decode(frame).map_err(|error| format!("Invalid KeeLink frame: {error:?}"))?;
    if header.message_id != 0 {
        *last_event = (*last_event).max(header.message_id);
    }
    let payload = &frame[HEADER_SIZE..];
    match (header.kind, header.channel) {
        (Kind::Welcome, CH_SYSTEM) | (Kind::Heartbeat, CH_SYSTEM) => {}
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
            if let Some(value) = snapshots.push(payload)? {
                update_inventory(&value, inventory);
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
            if let Some(waiter) = pending.remove(&header.correlation_id) {
                response_latency =
                    Some(waiter.started.elapsed().as_millis().min(u32::MAX as u128) as u32);
                let _ = waiter.result.send(Ok(result.clone()));
            }
            if !result.text.is_empty() {
                let _ = app.emit("mesh-line", result.text.clone());
            }
            let _ = app.emit("mesh-command-result", result);
        }
        _ => {}
    }
    Ok(response_latency)
}

fn service_offline_commands(
    inner: &Arc<RootInner>,
    app: &AppHandle,
    rx: &Receiver<WorkerCommand>,
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
            let started = Instant::now();
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
                        latency_ms: Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32),
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
                let _ = app.emit("mesh-command-result", value.clone());
            }
            match &result {
                Ok(_) => {
                    let mut status = inner.status.lock().unwrap_or_else(|p| p.into_inner());
                    status.connected = true;
                    status.transport = "ble".into();
                    status.reconnect_phase = "ble-fallback".into();
                    status.security = "ble-hmac".into();
                    status.latency_ms =
                        Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32);
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
        Ok(WorkerCommand::Stop | WorkerCommand::Wake) | Err(_) => {}
    }
}

fn reject_until_wake(inner: &Arc<RootInner>, rx: &Receiver<WorkerCommand>, reason: &str) {
    match rx.recv_timeout(Duration::from_secs(1)) {
        Ok(WorkerCommand::Send(request)) => {
            let _ = request.result.send(Err(reason.into()));
        }
        Ok(WorkerCommand::Stop) => inner.stop.store(true, Ordering::Release),
        Ok(WorkerCommand::Wake) | Err(_) => {}
    }
}

fn connect_wss(record: &CredentialRecord, address: &str) -> Result<KeeSocket, String> {
    let tcp = connect_tcp(address)?;
    let connector = insecure_tls_connector()?;
    let tls = connector
        .connect("keemash-root", tcp)
        .map_err(|error| format!("node0 TLS handshake failed: {error}"))?;
    verify_peer_fingerprint(&tls, &record.fingerprint)?;
    let request = Request::builder()
        .uri(format!("wss://{address}/keelink/ws"))
        .header("Host", address)
        .header("Authorization", format!("Bearer {}", record.token))
        .body(())
        .map_err(|error| format!("Invalid WSS request: {error}"))?;
    let (mut socket, _) =
        client(request, tls).map_err(|error| format!("KeeLink WSS handshake failed: {error}"))?;
    socket
        .get_mut()
        .get_mut()
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("Unable to configure KeeLink read timeout: {error}"))?;
    Ok(socket)
}

fn connect_tcp(address: &str) -> Result<TcpStream, String> {
    let socket = format!("{address}:{HTTPS_PORT}")
        .parse::<SocketAddr>()
        .or_else(|_| {
            (address, HTTPS_PORT)
                .to_socket_addrs()
                .and_then(|mut a| a.next().ok_or(std::io::ErrorKind::NotFound.into()))
        })
        .map_err(|error| format!("Invalid node0 address: {error}"))?;
    let tcp = TcpStream::connect_timeout(&socket, Duration::from_secs(2))
        .map_err(|error| format!("node0 connection failed: {error}"))?;
    tcp.set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    Ok(tcp)
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
    let (_, cert) = parse_x509_certificate(&der)
        .map_err(|error| format!("Unable to parse node0 certificate: {error}"))?;
    Ok(hex::encode(Sha256::digest(
        cert.tbs_certificate.subject_pki.raw,
    )))
}

fn verify_peer_fingerprint(tls: &TlsStream<TcpStream>, expected: &str) -> Result<(), String> {
    let actual = peer_fingerprint(tls)?;
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

#[derive(Default)]
struct SnapshotAssembler {
    id: u32,
    parts: Vec<Option<Vec<u8>>>,
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

fn ws_error(error: tungstenite::Error) -> String {
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
    tokio::time::sleep(Duration::from_millis(900)).await;
    let mut selected = None;
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
    let peripheral = selected.ok_or("KeeMASH root BLE advertisement was not found")?;
    let _ = adapter.stop_scan().await;
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

#[cfg(windows)]
fn prompt_admin_pin() -> Result<String, String> {
    let target = wide("KeeMASH node0 admin PIN");
    let caption = wide("Pair KeeMASH with node0");
    let message = wide("Enter the current node0 OTA/admin PIN. It will not be saved.");
    let mut username = wide("KeeMASH");
    username.resize(64, 0);
    let mut password = vec![0u16; 128];
    let info = CREDUI_INFOW {
        cbSize: std::mem::size_of::<CREDUI_INFOW>() as u32,
        hwndParent: std::ptr::null_mut(),
        pszMessageText: message.as_ptr(),
        pszCaptionText: caption.as_ptr(),
        hbmBanner: std::ptr::null_mut(),
    };
    let result = unsafe {
        CredUIPromptForCredentialsW(
            &info,
            target.as_ptr(),
            std::ptr::null(),
            0,
            username.as_mut_ptr(),
            username.len() as u32,
            password.as_mut_ptr(),
            password.len() as u32,
            std::ptr::null_mut(),
            CREDUI_FLAGS_GENERIC_CREDENTIALS
                | CREDUI_FLAGS_ALWAYS_SHOW_UI
                | CREDUI_FLAGS_DO_NOT_PERSIST
                | CREDUI_FLAGS_KEEP_USERNAME
                | CREDUI_FLAGS_PASSWORD_ONLY_OK,
        )
    };
    if result == ERROR_CANCELLED {
        password.zeroize();
        return Err("Pairing cancelled".into());
    }
    if result != ERROR_SUCCESS {
        password.zeroize();
        return Err(format!("Windows credential prompt failed: {result}"));
    }
    let end = password
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(password.len());
    let value =
        String::from_utf16(&password[..end]).map_err(|_| "Admin PIN is not valid UTF-16")?;
    password.zeroize();
    Ok(value)
}

#[cfg(not(windows))]
fn prompt_admin_pin() -> Result<String, String> {
    Err("Native KeeLink pairing is currently implemented for Windows only".into())
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
}
