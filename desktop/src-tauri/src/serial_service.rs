use crate::models::{SerialPortInfo, SerialStatus};
use crate::runtime::RuntimeController;
use serde_json::json;
use serialport::{SerialPort, SerialPortType};
use std::io::{ErrorKind, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use zeroize::Zeroize;

const BAUD_RATE: u32 = 115_200;
const MAX_LINE_BYTES: usize = 16_384;
const KEELINK_CLAIM_ACK_TIMEOUT: Duration = Duration::from_millis(750);
const KEELINK_CLAIM_MAX_ATTEMPTS: usize = 4;

struct SerialInner {
    port: Option<Box<dyn SerialPort>>,
    path: Option<String>,
    error: Option<String>,
    stop: Option<Arc<AtomicBool>>,
    reader: Option<JoinHandle<()>>,
    app: Option<AppHandle>,
    claim_waiter: Option<Sender<String>>,
}

#[derive(Clone)]
pub struct SerialService {
    inner: Arc<Mutex<SerialInner>>,
}

impl Default for SerialService {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(SerialInner {
                port: None,
                path: None,
                error: None,
                stop: None,
                reader: None,
                app: None,
                claim_waiter: None,
            })),
        }
    }
}

impl SerialService {
    pub fn list(&self) -> Result<Vec<SerialPortInfo>, String> {
        let mut ports = serialport::available_ports()
            .map_err(|error| format!("Unable to enumerate serial ports: {error}"))?
            .into_iter()
            .map(|port| {
                let (manufacturer, serial_number, vendor_id, product_id) = match port.port_type {
                    SerialPortType::UsbPort(info) => (
                        info.manufacturer,
                        info.serial_number,
                        Some(format!("{:04X}", info.vid)),
                        Some(format!("{:04X}", info.pid)),
                    ),
                    SerialPortType::BluetoothPort => {
                        (Some("Bluetooth serial".into()), None, None, None)
                    }
                    _ => (None, None, None, None),
                };
                SerialPortInfo {
                    path: port.port_name,
                    manufacturer,
                    serial_number,
                    vendor_id,
                    product_id,
                }
            })
            .collect::<Vec<_>>();
        ports.sort_by(|left, right| {
            natural_port_key(&left.path).cmp(&natural_port_key(&right.path))
        });
        Ok(ports)
    }

    pub fn status(&self) -> SerialStatus {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        status_from_inner(&inner)
    }

    pub fn open(
        &self,
        app: &AppHandle,
        path: String,
        runtime: Arc<RuntimeController>,
    ) -> Result<SerialStatus, String> {
        let path = path.trim().to_string();
        if path.is_empty() || path.len() > 128 || path.contains(['\r', '\n']) {
            return Err("Invalid serial port path".into());
        }
        self.close(app)?;

        let writer = serialport::new(&path, BAUD_RATE)
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(|error| format!("Unable to open {path}: {error}"))?;
        let mut reader = writer
            .try_clone()
            .map_err(|error| format!("Unable to start serial reader: {error}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let reader_stop = Arc::clone(&stop);
        let reader_state = Arc::clone(&self.inner);
        let reader_app = app.clone();

        {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner.port = Some(writer);
            inner.path = Some(path);
            inner.error = None;
            inner.stop = Some(Arc::clone(&stop));
            inner.app = Some(app.clone());
        }

        let handle = match thread::Builder::new()
            .name("keemash-serial-rx".into())
            .spawn(move || read_loop(&mut *reader, reader_stop, reader_state, reader_app, runtime))
        {
            Ok(handle) => handle,
            Err(error) => {
                stop.store(true, Ordering::Release);
                let mut inner = self
                    .inner
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                inner.port = None;
                inner.path = None;
                inner.stop = None;
                inner.app = None;
                return Err(format!("Unable to spawn serial reader: {error}"));
            }
        };

        let status = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner.reader = Some(handle);
            status_from_inner(&inner)
        };
        let _ = app.emit("serial-status", status.clone());
        Ok(status)
    }

    pub fn close(&self, app: &AppHandle) -> Result<SerialStatus, String> {
        let reader = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(stop) = inner.stop.take() {
                stop.store(true, Ordering::Release);
            }
            inner.port.take();
            inner.path = None;
            inner.app = None;
            inner.claim_waiter = None;
            inner.reader.take()
        };
        if let Some(reader) = reader {
            reader
                .join()
                .map_err(|_| "Serial reader thread panicked".to_string())?;
        }
        let status = self.status();
        let _ = app.emit("serial-status", status.clone());
        Ok(status)
    }

    pub fn send(&self, message: String) -> Result<(), String> {
        let command = message.trim();
        if command.is_empty() {
            return Ok(());
        }
        if command.len() > 256 || command.contains(['\r', '\n']) {
            return Err("Only one command up to 256 bytes may be sent at a time".into());
        }

        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if inner.claim_waiter.is_some() {
            return Err("KeeLink commissioning is active".into());
        }
        let port = inner.port.as_mut().ok_or("Serial port is not connected")?;
        let result = port
            .write_all(format!("{command}\n").as_bytes())
            .and_then(|_| port.flush());
        if let Err(error) = result {
            let message = format!("Serial write failed: {error}");
            if let Some(stop) = &inner.stop {
                stop.store(true, Ordering::Release);
            }
            inner.error = Some(message.clone());
            inner.port = None;
            inner.path = None;
            let app = inner.app.clone();
            let status = status_from_inner(&inner);
            drop(inner);
            if let Some(app) = app {
                let _ = app.emit("serial-status", status);
            }
            return Err(message);
        }
        Ok(())
    }

    pub fn claim_keelink(
        &self,
        mut requests: Vec<String>,
        timeout: Duration,
    ) -> Result<Vec<String>, String> {
        if requests.len() != 6
            || requests.iter().any(|request| {
                !request.starts_with("KC1:") || request.len() > 31 || request.contains(['\r', '\n'])
            })
        {
            requests.iter_mut().for_each(Zeroize::zeroize);
            return Err("Invalid KeeLink commissioning request".into());
        }

        let (reply_tx, reply_rx) = mpsc::channel();
        {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inner.claim_waiter.is_some() {
                requests.iter_mut().for_each(Zeroize::zeroize);
                return Err("KeeLink commissioning is already active".into());
            }
            if inner.port.is_none() {
                requests.iter_mut().for_each(Zeroize::zeroize);
                return Err("Connect the trusted node0 serial link to commission KeeLink".into());
            }
            inner.claim_waiter = Some(reply_tx);
        }

        let deadline = Instant::now() + timeout;
        let mut responses = Vec::with_capacity(4);
        let mut result = Ok(());
        'request: for request in &requests {
            let ack = format!("KC1:{}:A:{}", &request[4..8], &request[9..11]);
            for _ in 0..KEELINK_CLAIM_MAX_ATTEMPTS {
                let write_result = {
                    let mut inner = self
                        .inner
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    let Some(port) = inner.port.as_mut() else {
                        result = Err("KeeLink commissioning serial link disconnected".into());
                        break 'request;
                    };
                    port.write_all(request.as_bytes())
                        .and_then(|_| port.write_all(b"\n"))
                        .and_then(|_| port.flush())
                };
                if let Err(error) = write_result {
                    result = Err(format!("KeeLink commissioning write failed: {error}"));
                    break 'request;
                }

                let attempt_deadline = Instant::now() + KEELINK_CLAIM_ACK_TIMEOUT;
                loop {
                    let Some(global_remaining) = deadline.checked_duration_since(Instant::now())
                    else {
                        result = Err("KeeLink commissioning response timed out".into());
                        break 'request;
                    };
                    let Some(attempt_remaining) =
                        attempt_deadline.checked_duration_since(Instant::now())
                    else {
                        break;
                    };
                    let remaining = global_remaining.min(attempt_remaining);
                    match reply_rx.recv_timeout(remaining) {
                        Ok(response) if response == ack => continue 'request,
                        Ok(response)
                            if response.contains(":E:")
                                || response.starts_with("keelink.claim.err.v1:") =>
                        {
                            result = Err("node0 rejected trusted serial commissioning".into());
                            break 'request;
                        }
                        Ok(response) if response.contains(":P") => responses.push(response),
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            }
            result = Err(format!(
                "KeeLink commissioning did not acknowledge {}",
                &request[9..11]
            ));
            break;
        }

        if result.is_ok() {
            while responses.len() < 4 {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    result = Err("KeeLink commissioning proof timed out".into());
                    break;
                };
                match reply_rx.recv_timeout(remaining) {
                    Ok(response) if response.contains(":P") => responses.push(response),
                    Ok(response) if response.contains(":E:") => {
                        result = Err("node0 rejected trusted serial commissioning".into());
                        break;
                    }
                    Ok(_) => {}
                    Err(_) => {
                        result = Err("KeeLink commissioning proof timed out".into());
                        break;
                    }
                }
            }
        }
        requests.iter_mut().for_each(Zeroize::zeroize);
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.claim_waiter = None;
        result.map(|_| responses)
    }
}

fn read_loop(
    port: &mut dyn SerialPort,
    stop: Arc<AtomicBool>,
    state: Arc<Mutex<SerialInner>>,
    app: AppHandle,
    runtime: Arc<RuntimeController>,
) {
    let mut bytes = [0_u8; 512];
    let mut line = Vec::<u8>::with_capacity(512);
    let mut discarding_oversized_line = false;
    while !stop.load(Ordering::Acquire) {
        match port.read(&mut bytes) {
            Ok(count) => {
                for byte in &bytes[..count] {
                    if *byte == b'\n' {
                        if discarding_oversized_line {
                            discarding_oversized_line = false;
                            line.clear();
                            continue;
                        }
                        let text = String::from_utf8_lossy(&line)
                            .trim_end_matches('\r')
                            .trim()
                            .to_string();
                        line.clear();
                        if !text.is_empty() {
                            if dispatch_keelink_claim_response(&state, &text) {
                                continue;
                            }
                            runtime.record("log", json!({"direction": "rx", "text": &text}));
                            let _ = app.emit("serial-line", text);
                        }
                    } else if discarding_oversized_line {
                        continue;
                    } else if line.len() < MAX_LINE_BYTES {
                        line.push(*byte);
                    } else {
                        line.clear();
                        discarding_oversized_line = true;
                        report_protocol_error(
                            &state,
                            &app,
                            "Serial receive line exceeded buffer limit",
                        );
                    }
                }
            }
            Err(error) if is_transient_read_error(&error) => {
                // Windows Bluetooth SPP can report ERROR_SEM_TIMEOUT while idle.
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                eprintln!("KeeMASH serial reader stopped: {error}");
                runtime.record(
                    "runtime-error",
                    json!({"source": "serial-reader", "error": error.to_string()}),
                );
                set_reader_error(&state, &app, &format!("Serial read failed: {error}"));
                break;
            }
        }
    }
}

fn dispatch_keelink_claim_response(state: &Arc<Mutex<SerialInner>>, text: &str) -> bool {
    if !text.starts_with("KC1:")
        && !text.starts_with("keelink.claim.ok.v1:")
        && !text.starts_with("keelink.claim.err.v1:")
    {
        return false;
    }
    let waiter = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .claim_waiter
        .clone();
    if let Some(waiter) = waiter {
        let _ = waiter.send(text.to_string());
    }
    true
}

fn is_transient_read_error(error: &std::io::Error) -> bool {
    matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock)
        || cfg!(windows)
            && matches!(
                error.raw_os_error(),
                Some(121 | 995 | 1460) // semaphore timeout, aborted overlapped I/O, timeout
            )
}

fn set_reader_error(state: &Arc<Mutex<SerialInner>>, app: &AppHandle, message: &str) {
    let status = {
        let mut inner = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.error = Some(message.to_string());
        inner.port = None;
        inner.path = None;
        status_from_inner(&inner)
    };
    let _ = app.emit("serial-status", status);
}

fn report_protocol_error(state: &Arc<Mutex<SerialInner>>, app: &AppHandle, message: &str) {
    let status = {
        let mut inner = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.error = Some(message.to_string());
        status_from_inner(&inner)
    };
    let _ = app.emit("serial-status", status);
}

fn status_from_inner(inner: &SerialInner) -> SerialStatus {
    SerialStatus {
        connected: inner.port.is_some(),
        path: inner.path.clone(),
        baud_rate: BAUD_RATE,
        error: inner.error.clone(),
    }
}

fn natural_port_key(path: &str) -> (String, u32) {
    let split_at = path
        .find(|character: char| character.is_ascii_digit())
        .unwrap_or(path.len());
    let (prefix, suffix) = path.split_at(split_at);
    (
        prefix.to_ascii_uppercase(),
        suffix.parse().unwrap_or(u32::MAX),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serial_ports_sort_naturally() {
        let mut ports = ["COM10", "COM4", "COM2"];
        ports.sort_by_key(|path| natural_port_key(path));
        assert_eq!(ports, ["COM2", "COM4", "COM10"]);
    }

    #[test]
    fn treats_windows_bluetooth_semaphore_timeout_as_transient() {
        for code in [121, 995, 1460] {
            assert!(is_transient_read_error(&std::io::Error::from_raw_os_error(
                code
            )));
        }
        assert!(is_transient_read_error(&std::io::Error::new(
            ErrorKind::TimedOut,
            "timeout"
        )));
        assert!(!is_transient_read_error(&std::io::Error::new(
            ErrorKind::BrokenPipe,
            "disconnected"
        )));
    }
}
