use crate::models::{SerialPortInfo, SerialStatus};
use serialport::{SerialPort, SerialPortType};
use std::io::{ErrorKind, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const BAUD_RATE: u32 = 115_200;
const MAX_LINE_BYTES: usize = 16_384;

struct SerialInner {
    port: Option<Box<dyn SerialPort>>,
    path: Option<String>,
    error: Option<String>,
    stop: Option<Arc<AtomicBool>>,
    reader: Option<JoinHandle<()>>,
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

    pub fn open(&self, app: &AppHandle, path: String) -> Result<SerialStatus, String> {
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
        }

        let handle = match thread::Builder::new()
            .name("keemash-serial-rx".into())
            .spawn(move || read_loop(&mut *reader, reader_stop, reader_state, reader_app))
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
        let port = inner.port.as_mut().ok_or("Serial port is not connected")?;
        port.write_all(format!("{command}\n").as_bytes())
            .and_then(|_| port.flush())
            .map_err(|error| format!("Serial write failed: {error}"))
    }
}

fn read_loop(
    port: &mut dyn SerialPort,
    stop: Arc<AtomicBool>,
    state: Arc<Mutex<SerialInner>>,
    app: AppHandle,
) {
    let mut bytes = [0_u8; 512];
    let mut line = Vec::<u8>::with_capacity(512);
    while !stop.load(Ordering::Acquire) {
        match port.read(&mut bytes) {
            Ok(count) => {
                for byte in &bytes[..count] {
                    if *byte == b'\n' {
                        let text = String::from_utf8_lossy(&line)
                            .trim_end_matches('\r')
                            .trim()
                            .to_string();
                        line.clear();
                        if !text.is_empty() {
                            let _ = app.emit("serial-line", text);
                        }
                    } else if line.len() < MAX_LINE_BYTES {
                        line.push(*byte);
                    } else {
                        line.clear();
                        set_reader_error(&state, &app, "Serial receive line exceeded buffer limit");
                    }
                }
            }
            Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {}
            Err(error) => {
                set_reader_error(&state, &app, &format!("Serial read failed: {error}"));
                break;
            }
        }
    }
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
}
