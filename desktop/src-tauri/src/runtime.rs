use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_FILE_V2: &str = "workspace-v2.json";
const STORE_FILE_V1: &str = "workspace-v1.json";
const STORE_KEY: &str = "profile";
const HISTORY_LIMIT: usize = 512;
const HISTORY_BYTES_LIMIT: usize = 512 * 1024;
const HISTORY_PAYLOAD_LIMIT: usize = 16 * 1024;
const UNDO_LIMIT: usize = 12;
const PROFILE_BYTES_LIMIT: usize = 256 * 1024;
const MAX_INSTANCES_PER_WORKSPACE: usize = 64;
const MAX_LAYOUT_ITEMS_PER_BREAKPOINT: usize = 64;
const MAX_PROFILE_STRING_BYTES: usize = 160;
const DEFAULT_TELEMETRY_INTERVAL_MS: u64 = 1_000;
const SENSITIVE_CAPABILITIES: &[&str] = &[
    "hardware.lowlevel",
    "process.control",
    "process.inject",
    "updates.manage",
];

fn default_telemetry_interval_ms() -> u64 {
    DEFAULT_TELEMETRY_INTERVAL_MS
}

fn default_console_auto_scroll() -> bool {
    true
}

pub type WorkspaceLayouts = BTreeMap<String, BTreeMap<String, Vec<LayoutItem>>>;
pub type WorkspaceInstances = BTreeMap<String, Vec<WidgetInstance>>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutItem {
    pub i: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_w: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_h: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_w: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_h: Option<i32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WidgetInstance {
    pub instance_id: String,
    pub widget_id: String,
    pub visible: bool,
    pub keep_alive: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubDock {
    pub edge: String,
    pub offset: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProfileV2 {
    pub schema_version: u8,
    pub revision: u64,
    pub active_workspace: String,
    pub sidebar_mode: String,
    pub sidebar_restore_mode: String,
    pub topbar_visible: bool,
    pub statusbar_visible: bool,
    pub immersive_chrome: bool,
    pub motion_level: String,
    #[serde(default = "default_console_auto_scroll")]
    pub console_auto_scroll: bool,
    #[serde(default = "default_telemetry_interval_ms")]
    pub telemetry_interval_ms: u64,
    #[serde(default)]
    pub master_gpu_luid: Option<String>,
    pub hub_dock: HubDock,
    pub enabled_modules: BTreeMap<String, bool>,
    pub grants: BTreeMap<String, Vec<String>>,
    pub instances: WorkspaceInstances,
    pub layouts: WorkspaceLayouts,
    pub preset: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceProfileV1 {
    active_workspace: Option<String>,
    sidebar_collapsed: Option<bool>,
    enabled_modules: Option<BTreeMap<String, bool>>,
    grants: Option<BTreeMap<String, Vec<String>>>,
    instances: Option<WorkspaceInstances>,
    layouts: Option<WorkspaceLayouts>,
    preset: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleRuntimeState {
    pub module_id: String,
    pub state: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub profile: WorkspaceProfileV2,
    pub module_states: Vec<ModuleRuntimeState>,
    pub can_undo: bool,
    pub last_action: Option<String>,
    pub history_cursor: u64,
    pub started_at: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RuntimeAction {
    SetActiveWorkspace {
        workspace: String,
    },
    SetSidebarMode {
        mode: String,
    },
    SetTopbarVisible {
        visible: bool,
    },
    SetStatusbarVisible {
        visible: bool,
    },
    SetImmersiveChrome {
        enabled: bool,
    },
    SetMotionLevel {
        level: String,
    },
    SetConsoleAutoScroll {
        enabled: bool,
    },
    SetTelemetryInterval {
        interval_ms: u64,
    },
    SetHubDock {
        edge: String,
        offset: f32,
    },
    SetLayout {
        workspace: String,
        layouts: BTreeMap<String, Vec<LayoutItem>>,
    },
    SetWidgetVisible {
        workspace: String,
        instance_id: String,
        visible: bool,
    },
    SetWidgetKeepAlive {
        workspace: String,
        instance_id: String,
        keep_alive: bool,
    },
    AddWidget {
        workspace: String,
        widget_id: String,
    },
    SetModuleEnabled {
        module_id: String,
        enabled: bool,
    },
    SetCapability {
        module_id: String,
        capability: String,
        enabled: bool,
    },
    ApplyPreset {
        preset: String,
    },
    Undo,
}

impl RuntimeAction {
    fn label(&self) -> &'static str {
        match self {
            Self::SetActiveWorkspace { .. } => "workspace changed",
            Self::SetSidebarMode { .. } => "sidebar changed",
            Self::SetTopbarVisible { .. } => "topbar changed",
            Self::SetStatusbarVisible { .. } => "statusbar changed",
            Self::SetImmersiveChrome { .. } => "chrome changed",
            Self::SetMotionLevel { .. } => "motion changed",
            Self::SetConsoleAutoScroll { .. } => "console autoscroll changed",
            Self::SetTelemetryInterval { .. } => "telemetry resolution changed",
            Self::SetHubDock { .. } => "hub moved",
            Self::SetLayout { .. } => "layout changed",
            Self::SetWidgetVisible { visible, .. } => {
                if *visible {
                    "widget shown"
                } else {
                    "widget hidden"
                }
            }
            Self::SetWidgetKeepAlive { .. } => "background state changed",
            Self::AddWidget { .. } => "widget added",
            Self::SetModuleEnabled { .. } => "module changed",
            Self::SetCapability { .. } => "permission changed",
            Self::ApplyPreset { .. } => "preset applied",
            Self::Undo => "change undone",
        }
    }

    fn is_undoable(&self) -> bool {
        !matches!(
            self,
            Self::SetActiveWorkspace { .. }
                | Self::SetMotionLevel { .. }
                | Self::SetConsoleAutoScroll { .. }
                | Self::SetTelemetryInterval { .. }
                | Self::Undo
        )
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDispatchRequest {
    pub operation: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHistoryEntry {
    pub cursor: u64,
    pub timestamp: u64,
    pub kind: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHistoryPage {
    pub entries: Vec<RuntimeHistoryEntry>,
    pub next_cursor: u64,
}

#[derive(Clone)]
struct RuntimeInner {
    profile: WorkspaceProfileV2,
    undo: VecDeque<WorkspaceProfileV2>,
    history: VecDeque<RuntimeHistoryEntry>,
    next_history_cursor: u64,
    last_action: Option<String>,
}

pub struct RuntimeController {
    inner: Mutex<RuntimeInner>,
    started_at: u64,
}

impl Default for RuntimeController {
    fn default() -> Self {
        Self {
            inner: Mutex::new(RuntimeInner {
                profile: default_profile("default"),
                undo: VecDeque::new(),
                history: VecDeque::new(),
                next_history_cursor: 1,
                last_action: None,
            }),
            started_at: now_millis(),
        }
    }
}

impl RuntimeController {
    pub fn load(&self, app: &AppHandle) -> Result<(), String> {
        let v2 = app
            .store(STORE_FILE_V2)
            .map_err(|error| error.to_string())?;
        let stored = v2.get(STORE_KEY).or_else(|| {
            app.store(STORE_FILE_V1)
                .ok()
                .and_then(|legacy| legacy.get(STORE_KEY))
        });
        let profile = stored
            .map(migrate_profile)
            .transpose()?
            .unwrap_or_else(|| default_profile("default"));
        validate_profile_limits(&profile)?;
        persist_profile(app, &profile)?;
        let mut inner = lock(&self.inner);
        inner.profile = profile;
        inner.undo.clear();
        inner.last_action = None;
        Ok(())
    }

    pub fn snapshot(&self) -> RuntimeSnapshot {
        let inner = lock(&self.inner);
        snapshot_from(&inner, self.started_at)
    }

    pub fn apply_action(
        &self,
        app: &AppHandle,
        action: RuntimeAction,
        expected_revision: Option<u64>,
    ) -> Result<RuntimeSnapshot, String> {
        let mut inner = lock(&self.inner);
        validate_expected_revision(inner.profile.revision, expected_revision)?;
        let mut candidate = inner.clone();
        if matches!(action, RuntimeAction::Undo) {
            let previous = candidate.undo.pop_back().ok_or("nothing to undo")?;
            let revision = candidate.profile.revision.saturating_add(1);
            candidate.profile = previous;
            candidate.profile.revision = revision;
        } else {
            if action.is_undoable() {
                let checkpoint = candidate.profile.clone();
                candidate.undo.push_back(checkpoint);
                while candidate.undo.len() > UNDO_LIMIT {
                    candidate.undo.pop_front();
                }
            }
            mutate_profile(&mut candidate.profile, &action)?;
            candidate.profile.revision = candidate.profile.revision.saturating_add(1);
        }
        validate_profile_limits(&candidate.profile)?;
        candidate.last_action = Some(action.label().to_string());
        let revision = candidate.profile.revision;
        push_history_locked(
            &mut candidate,
            "runtime",
            json!({"action": action.label(), "revision": revision}),
        );
        persist_profile(app, &candidate.profile)?;
        *inner = candidate;
        Ok(snapshot_from(&inner, self.started_at))
    }

    pub fn authorize(&self, request: &RuntimeDispatchRequest) -> Result<(), String> {
        let required = operation_capabilities(&request.operation)
            .ok_or_else(|| format!("unknown runtime operation: {}", request.operation))?;
        let owner = operation_owner(&request.operation)
            .ok_or_else(|| format!("unknown runtime operation: {}", request.operation))?;
        let inner = lock(&self.inner);
        if !inner
            .profile
            .enabled_modules
            .get(owner)
            .copied()
            .unwrap_or(false)
        {
            return Err(format!("module {owner} is disabled"));
        }
        let grants = inner.profile.grants.get(owner);
        if let Some(missing) = required.iter().find(|capability| {
            !grants.is_some_and(|items| items.iter().any(|item| item == **capability))
        }) {
            return Err(format!("module {owner} lacks capability {missing}"));
        }
        Ok(())
    }

    pub fn record(&self, kind: &str, payload: Value) {
        let mut inner = lock(&self.inner);
        push_history_locked(&mut inner, kind, payload);
    }

    pub fn history(&self, kind: Option<&str>, cursor: u64, limit: usize) -> RuntimeHistoryPage {
        let inner = lock(&self.inner);
        let limit = limit.clamp(1, 200);
        let entries = inner
            .history
            .iter()
            .filter(|entry| entry.cursor > cursor && kind.is_none_or(|value| entry.kind == value))
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        RuntimeHistoryPage {
            next_cursor: entries.last().map_or(cursor, |entry| entry.cursor),
            entries,
        }
    }

    pub fn module_state(&self, module_id: &str) -> String {
        let inner = lock(&self.inner);
        module_state(&inner.profile, module_id)
    }

    pub fn capability_granted(&self, module_id: &str, capability: &str) -> bool {
        let inner = lock(&self.inner);
        inner
            .profile
            .enabled_modules
            .get(module_id)
            .copied()
            .unwrap_or(false)
            && inner
                .profile
                .grants
                .get(module_id)
                .is_some_and(|items| items.iter().any(|item| item == capability))
    }

    pub fn telemetry_interval_ms(&self) -> u64 {
        lock(&self.inner).profile.telemetry_interval_ms
    }

    pub fn master_gpu_luid(&self) -> Option<String> {
        lock(&self.inner).profile.master_gpu_luid.clone()
    }

    pub fn set_master_gpu(
        &self,
        app: &AppHandle,
        luid: Option<String>,
    ) -> Result<RuntimeSnapshot, String> {
        if luid.as_ref().is_some_and(|value| {
            value.len() > 64
                || !value.chars().all(|character| {
                    character.is_ascii_hexdigit() || matches!(character, 'x' | '_')
                })
        }) {
            return Err("master GPU LUID is invalid".into());
        }
        let mut inner = lock(&self.inner);
        let mut candidate = inner.clone();
        candidate.profile.master_gpu_luid = luid;
        candidate.profile.revision = candidate.profile.revision.saturating_add(1);
        candidate.last_action = Some("master GPU changed".into());
        let revision = candidate.profile.revision;
        push_history_locked(
            &mut candidate,
            "runtime",
            json!({"action": "master GPU changed", "revision": revision}),
        );
        validate_profile_limits(&candidate.profile)?;
        persist_profile(app, &candidate.profile)?;
        *inner = candidate;
        Ok(snapshot_from(&inner, self.started_at))
    }
}

fn persist_profile(app: &AppHandle, profile: &WorkspaceProfileV2) -> Result<(), String> {
    let value = serde_json::to_value(profile).map_err(|error| error.to_string())?;
    let store = app
        .store(STORE_FILE_V2)
        .map_err(|error| error.to_string())?;
    store.set(STORE_KEY, value);
    store.save().map_err(|error| error.to_string())
}

fn snapshot_from(inner: &RuntimeInner, started_at: u64) -> RuntimeSnapshot {
    RuntimeSnapshot {
        profile: inner.profile.clone(),
        module_states: ["main", "monitor", "enjoy"]
            .into_iter()
            .map(|module_id| ModuleRuntimeState {
                module_id: module_id.to_string(),
                state: module_state(&inner.profile, module_id),
            })
            .collect(),
        can_undo: !inner.undo.is_empty(),
        last_action: inner.last_action.clone(),
        history_cursor: inner.next_history_cursor.saturating_sub(1),
        started_at,
    }
}

fn mutate_profile(profile: &mut WorkspaceProfileV2, action: &RuntimeAction) -> Result<(), String> {
    match action {
        RuntimeAction::SetActiveWorkspace { workspace } => {
            validate_workspace(workspace)?;
            if workspace != "home"
                && !profile
                    .enabled_modules
                    .get(workspace)
                    .copied()
                    .unwrap_or(false)
            {
                return Err(format!("workspace module {workspace} is disabled"));
            }
            profile.active_workspace = workspace.clone();
        }
        RuntimeAction::SetSidebarMode { mode } => {
            validate_sidebar_mode(mode)?;
            if mode != "hidden" {
                profile.sidebar_restore_mode = mode.clone();
            }
            profile.sidebar_mode = mode.clone();
        }
        RuntimeAction::SetTopbarVisible { visible } => profile.topbar_visible = *visible,
        RuntimeAction::SetStatusbarVisible { visible } => profile.statusbar_visible = *visible,
        RuntimeAction::SetImmersiveChrome { enabled } => profile.immersive_chrome = *enabled,
        RuntimeAction::SetMotionLevel { level } => {
            if !matches!(level.as_str(), "full" | "calm" | "off") {
                return Err("motion level must be full, calm, or off".into());
            }
            profile.motion_level = level.clone();
        }
        RuntimeAction::SetConsoleAutoScroll { enabled } => {
            profile.console_auto_scroll = *enabled;
        }
        RuntimeAction::SetTelemetryInterval { interval_ms } => {
            if !matches!(*interval_ms, 1_000 | 5_000 | 10_000 | 30_000 | 60_000) {
                return Err(
                    "telemetry interval must be 1000, 5000, 10000, 30000, or 60000 ms".into(),
                );
            }
            profile.telemetry_interval_ms = *interval_ms;
        }
        RuntimeAction::SetHubDock { edge, offset } => {
            if !matches!(edge.as_str(), "left" | "right" | "top" | "bottom") {
                return Err("hub edge must be left, right, top, or bottom".into());
            }
            if !offset.is_finite() {
                return Err("hub offset must be finite".into());
            }
            profile.hub_dock = HubDock {
                edge: edge.clone(),
                offset: offset.clamp(0.08, 0.92),
            };
        }
        RuntimeAction::SetLayout { workspace, layouts } => {
            validate_workspace(workspace)?;
            validate_layouts(layouts)?;
            profile.layouts.insert(workspace.clone(), layouts.clone());
        }
        RuntimeAction::SetWidgetVisible {
            workspace,
            instance_id,
            visible,
        } => mutate_instance(profile, workspace, instance_id, |item| {
            item.visible = *visible
        })?,
        RuntimeAction::SetWidgetKeepAlive {
            workspace,
            instance_id,
            keep_alive,
        } => mutate_instance(profile, workspace, instance_id, |item| {
            item.keep_alive = *keep_alive
        })?,
        RuntimeAction::AddWidget {
            workspace,
            widget_id,
        } => {
            validate_workspace(workspace)?;
            validate_widget(widget_id)?;
            let items = profile
                .instances
                .get_mut(workspace)
                .ok_or_else(|| format!("workspace {workspace} has no instances"))?;
            if let Some(existing) = items.iter_mut().find(|item| item.widget_id == *widget_id) {
                existing.visible = true;
            } else {
                items.push(WidgetInstance {
                    instance_id: format!("{workspace}:{widget_id}:{}", now_millis()),
                    widget_id: widget_id.clone(),
                    visible: true,
                    keep_alive: false,
                });
            }
        }
        RuntimeAction::SetModuleEnabled { module_id, enabled } => {
            validate_module(module_id)?;
            profile.enabled_modules.insert(module_id.clone(), *enabled);
            if !*enabled && profile.active_workspace == *module_id {
                profile.active_workspace = "home".into();
            }
        }
        RuntimeAction::SetCapability {
            module_id,
            capability,
            enabled,
        } => {
            validate_module(module_id)?;
            validate_capability(capability)?;
            if SENSITIVE_CAPABILITIES.contains(&capability.as_str()) {
                return Err(format!(
                    "capability {capability} is managed by the native application manifest"
                ));
            }
            let grants = profile.grants.entry(module_id.clone()).or_default();
            if *enabled && !grants.contains(capability) {
                grants.push(capability.clone());
            } else if !*enabled {
                grants.retain(|item| item != capability);
            }
        }
        RuntimeAction::ApplyPreset { preset } => apply_preset(profile, preset)?,
        RuntimeAction::Undo => {}
    }
    Ok(())
}

fn mutate_instance(
    profile: &mut WorkspaceProfileV2,
    workspace: &str,
    instance_id: &str,
    mutator: impl FnOnce(&mut WidgetInstance),
) -> Result<(), String> {
    validate_workspace(workspace)?;
    let item = profile
        .instances
        .get_mut(workspace)
        .and_then(|items| {
            items
                .iter_mut()
                .find(|item| item.instance_id == instance_id)
        })
        .ok_or_else(|| format!("widget instance {instance_id} was not found"))?;
    mutator(item);
    Ok(())
}

fn apply_preset(profile: &mut WorkspaceProfileV2, preset: &str) -> Result<(), String> {
    if !matches!(preset, "default" | "compact" | "monitoring") {
        return Err("unknown workspace preset".into());
    }
    let fresh = default_profile(preset);
    profile.instances = fresh.instances;
    profile.layouts = fresh.layouts;
    profile.preset = preset.to_string();
    Ok(())
}

fn migrate_profile(value: Value) -> Result<WorkspaceProfileV2, String> {
    match value.get("schemaVersion").and_then(Value::as_u64) {
        Some(2) => {
            let mut profile: WorkspaceProfileV2 =
                serde_json::from_value(value).map_err(|error| error.to_string())?;
            normalize_profile(&mut profile);
            Ok(profile)
        }
        Some(1) => {
            let legacy: WorkspaceProfileV1 =
                serde_json::from_value(value).map_err(|error| error.to_string())?;
            let mut profile = default_profile(
                legacy
                    .preset
                    .as_deref()
                    .filter(|value| matches!(*value, "default" | "compact" | "monitoring"))
                    .unwrap_or("default"),
            );
            if let Some(workspace) = legacy.active_workspace {
                if validate_workspace(&workspace).is_ok() {
                    profile.active_workspace = workspace;
                }
            }
            let collapsed = legacy.sidebar_collapsed.unwrap_or(false);
            profile.sidebar_mode = if collapsed { "rail" } else { "expanded" }.into();
            profile.sidebar_restore_mode = profile.sidebar_mode.clone();
            if let Some(value) = legacy.enabled_modules {
                profile.enabled_modules.extend(value);
            }
            if let Some(value) = legacy.grants {
                profile.grants.extend(value);
            }
            if let Some(value) = legacy.instances {
                for (workspace, items) in value {
                    if validate_workspace(&workspace).is_ok() && !items.is_empty() {
                        profile.instances.insert(workspace, items);
                    }
                }
            }
            if let Some(value) = legacy.layouts {
                for (workspace, layouts) in value {
                    if validate_workspace(&workspace).is_ok() && validate_layouts(&layouts).is_ok()
                    {
                        profile.layouts.insert(workspace, layouts);
                    }
                }
            }
            normalize_profile(&mut profile);
            Ok(profile)
        }
        _ => Ok(default_profile("default")),
    }
}

fn normalize_profile(profile: &mut WorkspaceProfileV2) {
    profile.schema_version = 2;
    if validate_workspace(&profile.active_workspace).is_err() {
        profile.active_workspace = "home".into();
    }
    if validate_sidebar_mode(&profile.sidebar_mode).is_err() {
        profile.sidebar_mode = "expanded".into();
    }
    if validate_sidebar_mode(&profile.sidebar_restore_mode).is_err()
        || profile.sidebar_restore_mode == "hidden"
    {
        profile.sidebar_restore_mode = "expanded".into();
    }
    if !matches!(profile.motion_level.as_str(), "full" | "calm" | "off") {
        profile.motion_level = "full".into();
    }
    if !matches!(
        profile.telemetry_interval_ms,
        1_000 | 5_000 | 10_000 | 30_000 | 60_000
    ) {
        profile.telemetry_interval_ms = DEFAULT_TELEMETRY_INTERVAL_MS;
    }
    if !matches!(
        profile.hub_dock.edge.as_str(),
        "left" | "right" | "top" | "bottom"
    ) {
        profile.hub_dock.edge = "right".into();
    }
    profile.hub_dock.offset = profile.hub_dock.offset.clamp(0.08, 0.92);
    enforce_native_manifest_grants(profile);
    ensure_default_widgets(profile);
}

fn enforce_native_manifest_grants(profile: &mut WorkspaceProfileV2) {
    for (module, capabilities) in [
        (
            "monitor",
            ["hardware.lowlevel", "process.control", "process.inject"].as_slice(),
        ),
        ("enjoy", ["hardware.lowlevel", "updates.manage"].as_slice()),
    ] {
        let grants = profile.grants.entry(module.into()).or_default();
        for capability in capabilities {
            if !grants.iter().any(|item| item == capability) {
                grants.push((*capability).into());
            }
        }
    }
}

fn ensure_default_widgets(profile: &mut WorkspaceProfileV2) {
    for workspace in ["home", "main", "monitor", "enjoy"] {
        let defaults = widget_list(workspace);
        for (index, (widget_id, keep_alive)) in defaults.iter().enumerate() {
            let present = profile
                .instances
                .get(workspace)
                .is_some_and(|items| items.iter().any(|item| item.widget_id == *widget_id));
            if present {
                continue;
            }
            let instance_id = format!("{workspace}:{widget_id}:default-{index}");
            profile
                .instances
                .entry(workspace.to_string())
                .or_default()
                .push(WidgetInstance {
                    instance_id: instance_id.clone(),
                    widget_id: (*widget_id).to_string(),
                    visible: true,
                    keep_alive: *keep_alive,
                });
            let layouts = profile.layouts.entry(workspace.to_string()).or_default();
            for (breakpoint, columns) in [("lg", 12), ("md", 8), ("sm", 4), ("xs", 1)] {
                let items = layouts.entry(breakpoint.to_string()).or_default();
                let y = items.iter().map(|item| item.y + item.h).max().unwrap_or(0);
                let (width, height) = widget_size(widget_id, breakpoint, columns);
                items.push(LayoutItem {
                    i: instance_id.clone(),
                    x: 0,
                    y,
                    w: width.min(columns),
                    h: height,
                    min_w: Some(1),
                    min_h: Some(2),
                    max_w: None,
                    max_h: None,
                });
            }
        }
    }
}

fn module_state(profile: &WorkspaceProfileV2, module_id: &str) -> String {
    if !profile
        .enabled_modules
        .get(module_id)
        .copied()
        .unwrap_or(false)
    {
        return "disabled".into();
    }
    if profile.active_workspace == module_id
        || profile
            .instances
            .get(&profile.active_workspace)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.visible && item.widget_id.starts_with(&format!("{module_id}."))
                })
            })
    {
        return "active".into();
    }
    if profile
        .instances
        .values()
        .flatten()
        .any(|item| item.keep_alive && item.widget_id.starts_with(&format!("{module_id}.")))
    {
        "background".into()
    } else {
        "idle".into()
    }
}

fn push_history_locked(inner: &mut RuntimeInner, kind: &str, payload: Value) {
    let kind = if kind.len() > MAX_PROFILE_STRING_BYTES {
        "runtime-error"
    } else {
        kind
    };
    let payload = bound_history_payload(payload);
    let cursor = inner.next_history_cursor;
    inner.next_history_cursor = inner.next_history_cursor.saturating_add(1);
    inner.history.push_back(RuntimeHistoryEntry {
        cursor,
        timestamp: now_millis(),
        kind: kind.to_string(),
        payload,
    });
    while inner.history.len() > HISTORY_LIMIT {
        inner.history.pop_front();
    }
    while history_bytes(&inner.history) > HISTORY_BYTES_LIMIT {
        if inner.history.pop_front().is_none() {
            break;
        }
    }
}

fn bound_history_payload(payload: Value) -> Value {
    match serde_json::to_vec(&payload) {
        Ok(bytes) if bytes.len() <= HISTORY_PAYLOAD_LIMIT => payload,
        Ok(bytes) => json!({
            "truncated": true,
            "originalBytes": bytes.len(),
            "reason": "history payload exceeded limit"
        }),
        Err(_) => json!({"truncated": true, "reason": "history payload was not serializable"}),
    }
}

fn history_bytes(history: &VecDeque<RuntimeHistoryEntry>) -> usize {
    history
        .iter()
        .map(|entry| serde_json::to_vec(entry).map_or(0, |bytes| bytes.len()))
        .sum()
}

fn operation_owner(operation: &str) -> Option<&'static str> {
    Some(match operation {
        "serial.list" | "serial.status" | "serial.open" | "serial.close" | "serial.send"
        | "weather.refresh" => "main",
        "kenultra.load" | "updates.check" | "updates.install" => "enjoy",
        "resources.sample"
        | "gpu.residency.snapshot"
        | "gpu.residency.setProcessPolicy"
        | "gpu.residency.undoProcessPolicy"
        | "gpu.residency.removeRule"
        | "gpu.residency.attachAgent"
        | "gpu.residency.detachAgent"
        | "gpu.residency.applyResourcePolicy"
        | "gpu.residency.forceEvict"
        | "gpu.residency.makeResident"
        | "process.close"
        | "process.terminate"
        | "process.terminateTree"
        | "memory.test.status"
        | "memory.test.start"
        | "memory.test.stop"
        | "memory.diagnostic.open"
        | "ccc.status"
        | "ccc.start"
        | "ccc.stop"
        | "ccc.restart"
        | "system.rebootToFirmware"
        | "system.restart"
        | "system.shutdown"
        | "system.cancelPower" => "monitor",
        _ => return None,
    })
}

fn operation_capabilities(operation: &str) -> Option<&'static [&'static str]> {
    Some(match operation {
        "serial.list" | "serial.status" | "serial.open" | "serial.close" => &["serial.read"],
        "serial.send" => &["serial.command"],
        "resources.sample" | "gpu.residency.snapshot" | "memory.test.status" | "ccc.status" => {
            &["resources.read"]
        }
        "gpu.residency.setProcessPolicy"
        | "gpu.residency.undoProcessPolicy"
        | "gpu.residency.removeRule"
        | "process.close"
        | "process.terminate"
        | "process.terminateTree" => &["process.control"],
        "gpu.residency.attachAgent"
        | "gpu.residency.detachAgent"
        | "gpu.residency.applyResourcePolicy"
        | "gpu.residency.forceEvict"
        | "gpu.residency.makeResident" => &["process.inject"],
        "memory.test.start"
        | "memory.test.stop"
        | "memory.diagnostic.open"
        | "system.rebootToFirmware"
        | "system.restart"
        | "system.shutdown"
        | "system.cancelPower" => &["hardware.lowlevel"],
        "ccc.start" | "ccc.stop" | "ccc.restart" => &["hardware.lowlevel"],
        "weather.refresh" => &["weather.read", "network.external"],
        "kenultra.load" => &["knowledge.read"],
        "updates.check" | "updates.install" => &["updates.manage"],
        _ => return None,
    })
}

fn validate_workspace(value: &str) -> Result<(), String> {
    if matches!(value, "home" | "main" | "monitor" | "enjoy") {
        Ok(())
    } else {
        Err(format!("unknown workspace: {value}"))
    }
}

fn validate_module(value: &str) -> Result<(), String> {
    if matches!(value, "main" | "monitor" | "enjoy") {
        Ok(())
    } else {
        Err(format!("unknown module: {value}"))
    }
}

fn validate_sidebar_mode(value: &str) -> Result<(), String> {
    if matches!(value, "expanded" | "rail" | "hidden") {
        Ok(())
    } else {
        Err(format!("unknown sidebar mode: {value}"))
    }
}

fn validate_capability(value: &str) -> Result<(), String> {
    if matches!(
        value,
        "serial.read"
            | "serial.command"
            | "resources.read"
            | "weather.read"
            | "knowledge.read"
            | "network.external"
            | "hardware.lowlevel"
            | "firmware.manage"
            | "updates.manage"
            | "background.run"
            | "process.control"
            | "process.inject"
    ) {
        Ok(())
    } else {
        Err(format!("unknown capability: {value}"))
    }
}

fn validate_widget(value: &str) -> Result<(), String> {
    if value.starts_with("main.") || value.starts_with("monitor.") || value.starts_with("enjoy.") {
        Ok(())
    } else {
        Err(format!("unknown widget namespace: {value}"))
    }
}

fn validate_layouts(layouts: &BTreeMap<String, Vec<LayoutItem>>) -> Result<(), String> {
    if layouts.len() != 4 {
        return Err("layout must contain exactly four breakpoints".into());
    }
    for breakpoint in ["lg", "md", "sm", "xs"] {
        let items = layouts
            .get(breakpoint)
            .ok_or_else(|| format!("layout is missing breakpoint {breakpoint}"))?;
        if items.len() > MAX_LAYOUT_ITEMS_PER_BREAKPOINT {
            return Err(format!("layout {breakpoint} contains too many items"));
        }
        let mut ids = BTreeSet::new();
        if items.iter().any(|item| {
            item.i.len() > MAX_PROFILE_STRING_BYTES
                || !ids.insert(item.i.as_str())
                || item.w < 1
                || item.h < 1
                || item.w > 12
                || item.h > 128
                || item.x < 0
                || item.x > 12
                || item.y < 0
                || item.y > 100_000
        }) {
            return Err(format!("layout {breakpoint} contains invalid geometry"));
        }
    }
    Ok(())
}

fn validate_profile_limits(profile: &WorkspaceProfileV2) -> Result<(), String> {
    let serialized = serde_json::to_vec(profile).map_err(|error| error.to_string())?;
    if serialized.len() > PROFILE_BYTES_LIMIT {
        return Err(format!(
            "workspace profile exceeds {PROFILE_BYTES_LIMIT} bytes"
        ));
    }
    if profile.instances.len() != 4 || profile.layouts.len() != 4 {
        return Err("workspace profile must contain exactly four workspaces".into());
    }
    for workspace in ["home", "main", "monitor", "enjoy"] {
        let instances = profile
            .instances
            .get(workspace)
            .ok_or_else(|| format!("workspace {workspace} has no instances"))?;
        if instances.len() > MAX_INSTANCES_PER_WORKSPACE {
            return Err(format!("workspace {workspace} contains too many widgets"));
        }
        let mut ids = BTreeSet::new();
        for item in instances {
            if item.instance_id.is_empty()
                || item.widget_id.is_empty()
                || item.instance_id.len() > MAX_PROFILE_STRING_BYTES
                || item.widget_id.len() > MAX_PROFILE_STRING_BYTES
                || !ids.insert(item.instance_id.as_str())
            {
                return Err(format!("workspace {workspace} contains an invalid widget"));
            }
            validate_widget(&item.widget_id)?;
        }
        let layouts = profile
            .layouts
            .get(workspace)
            .ok_or_else(|| format!("workspace {workspace} has no layouts"))?;
        validate_layouts(layouts)?;
    }
    if profile.enabled_modules.len() != 3 || profile.grants.len() != 3 {
        return Err("workspace profile contains an invalid module map".into());
    }
    for (module, grants) in &profile.grants {
        validate_module(module)?;
        if grants.len() > 16 {
            return Err(format!("module {module} has too many capabilities"));
        }
        let mut unique = BTreeSet::new();
        for capability in grants {
            if capability.len() > MAX_PROFILE_STRING_BYTES || !unique.insert(capability.as_str()) {
                return Err(format!("module {module} contains invalid capabilities"));
            }
            validate_capability(capability)?;
        }
    }
    Ok(())
}

fn validate_expected_revision(current: u64, expected: Option<u64>) -> Result<(), String> {
    if expected.is_some_and(|revision| revision != current) {
        Err(format!(
            "stale runtime revision: expected {}, current {}",
            expected.unwrap_or_default(),
            current
        ))
    } else {
        Ok(())
    }
}

fn default_profile(preset: &str) -> WorkspaceProfileV2 {
    let mut instances = WorkspaceInstances::new();
    let mut layouts = WorkspaceLayouts::new();
    for workspace in ["home", "main", "monitor", "enjoy"] {
        let definitions = widget_list(workspace);
        let items = definitions
            .iter()
            .enumerate()
            .map(|(index, (widget_id, keep_alive))| WidgetInstance {
                instance_id: format!("{workspace}:{widget_id}:{index}"),
                widget_id: (*widget_id).to_string(),
                visible: true,
                keep_alive: *keep_alive,
            })
            .collect::<Vec<_>>();
        instances.insert(workspace.into(), items);
        layouts.insert(workspace.into(), default_layouts(workspace, &definitions));
    }
    if preset == "compact" {
        if let Some(home) = instances.get_mut("home") {
            for item in home {
                if matches!(item.widget_id.as_str(), "main.console" | "monitor.pcie") {
                    item.visible = false;
                }
            }
        }
    } else if preset == "monitoring" {
        let definitions = widget_list("monitor");
        instances.insert(
            "home".into(),
            definitions
                .iter()
                .enumerate()
                .map(|(index, (widget_id, _))| WidgetInstance {
                    instance_id: format!("home:{widget_id}:{index}"),
                    widget_id: (*widget_id).to_string(),
                    visible: true,
                    keep_alive: true,
                })
                .collect(),
        );
        layouts.insert("home".into(), default_layouts("home", &definitions));
    }

    WorkspaceProfileV2 {
        schema_version: 2,
        revision: 0,
        active_workspace: "home".into(),
        sidebar_mode: "expanded".into(),
        sidebar_restore_mode: "expanded".into(),
        topbar_visible: true,
        statusbar_visible: true,
        immersive_chrome: false,
        motion_level: "full".into(),
        console_auto_scroll: true,
        telemetry_interval_ms: DEFAULT_TELEMETRY_INTERVAL_MS,
        master_gpu_luid: None,
        hub_dock: HubDock {
            edge: "right".into(),
            offset: 0.7,
        },
        enabled_modules: BTreeMap::from([
            ("main".into(), true),
            ("monitor".into(), true),
            ("enjoy".into(), true),
        ]),
        grants: BTreeMap::from([
            (
                "main".into(),
                strings(&[
                    "serial.read",
                    "serial.command",
                    "weather.read",
                    "network.external",
                    "background.run",
                ]),
            ),
            (
                "monitor".into(),
                strings(&[
                    "resources.read",
                    "hardware.lowlevel",
                    "background.run",
                    "process.control",
                    "process.inject",
                ]),
            ),
            (
                "enjoy".into(),
                strings(&[
                    "serial.read",
                    "serial.command",
                    "resources.read",
                    "weather.read",
                    "knowledge.read",
                    "network.external",
                    "hardware.lowlevel",
                    "firmware.manage",
                    "updates.manage",
                    "background.run",
                ]),
            ),
        ]),
        instances,
        layouts,
        preset: preset.to_string(),
    }
}

fn widget_list(workspace: &str) -> Vec<(&'static str, bool)> {
    match workspace {
        "home" => vec![
            ("main.connection", false),
            ("monitor.summary", false),
            ("main.weather", false),
            ("monitor.pcie", false),
            ("main.console", true),
        ],
        "main" => vec![
            ("main.connection", false),
            ("main.weather", false),
            ("main.sensors", false),
            ("main.lighting", false),
            ("main.climate", false),
            ("main.console", true),
        ],
        "monitor" => vec![
            ("monitor.summary", false),
            ("monitor.thermals", false),
            ("monitor.pcie", true),
            ("monitor.vram", true),
            ("monitor.residency", true),
            ("monitor.compute", true),
            ("monitor.details", false),
            ("monitor.ccc", true),
        ],
        "enjoy" => vec![
            ("enjoy.search", false),
            ("enjoy.graph", false),
            ("enjoy.inspector", false),
        ],
        _ => Vec::new(),
    }
}

fn default_layouts(workspace: &str, widgets: &[(&str, bool)]) -> BTreeMap<String, Vec<LayoutItem>> {
    BTreeMap::from([
        ("lg".into(), make_layout(workspace, widgets, "lg", 12)),
        ("md".into(), make_layout(workspace, widgets, "md", 8)),
        ("sm".into(), make_layout(workspace, widgets, "sm", 4)),
        ("xs".into(), make_layout(workspace, widgets, "xs", 1)),
    ])
}

fn make_layout(
    workspace: &str,
    widgets: &[(&str, bool)],
    breakpoint: &str,
    columns: i32,
) -> Vec<LayoutItem> {
    let mut x = 0;
    let mut y = 0;
    let mut row_height = 0;
    widgets
        .iter()
        .enumerate()
        .map(|(index, (widget_id, _))| {
            let (raw_w, h) = widget_size(widget_id, breakpoint, columns);
            let w = raw_w.min(columns);
            if x + w > columns {
                x = 0;
                y += row_height;
                row_height = 0;
            }
            let item = LayoutItem {
                i: format!("{workspace}:{widget_id}:{index}"),
                x,
                y,
                w,
                h,
                min_w: Some(1),
                min_h: Some(2),
                max_w: None,
                max_h: None,
            };
            x += w;
            row_height = row_height.max(h);
            item
        })
        .collect()
}

fn widget_size(widget: &str, breakpoint: &str, columns: i32) -> (i32, i32) {
    let heights = match widget {
        "main.connection" => [2, 3, 4, 5],
        "main.weather" => [3, 3, 4, 5],
        "main.sensors" => [2, 3, 4, 6],
        "main.lighting" => [5, 6, 6, 8],
        "main.climate" => [6, 7, 7, 10],
        "main.console" => [6, 6, 6, 8],
        "monitor.summary" => [3, 4, 6, 9],
        "monitor.thermals" => [5, 6, 8, 12],
        "monitor.vram" => [7, 8, 10, 14],
        "monitor.residency" => [9, 10, 12, 16],
        "monitor.pcie" => [5, 6, 7, 9],
        "monitor.compute" => [5, 5, 6, 8],
        "monitor.details" => [5, 5, 6, 8],
        "monitor.ccc" => [5, 6, 8, 10],
        "enjoy.search" => [9, 9, 6, 8],
        "enjoy.graph" => [9, 9, 8, 10],
        "enjoy.inspector" => [9, 7, 7, 10],
        _ => [4, 4, 4, 4],
    };
    let index = match breakpoint {
        "lg" => 0,
        "md" => 1,
        "sm" => 2,
        _ => 3,
    };
    let width = match (widget, breakpoint) {
        ("main.lighting", "lg") | ("main.climate", "lg") | ("main.console", "lg") => 6,
        ("main.lighting", "md") | ("main.climate", "md") => 4,
        ("monitor.compute", "lg") | ("monitor.details", "lg") => columns,
        ("enjoy.search", "lg") | ("enjoy.inspector", "lg") => 3,
        ("enjoy.graph", "lg") => 6,
        ("enjoy.search", "md") => 3,
        ("enjoy.graph", "md") => 5,
        _ => columns,
    };
    (width.min(columns), heights[index])
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_v1_without_losing_widgets() {
        let legacy = json!({
            "schemaVersion": 1,
            "activeWorkspace": "monitor",
            "sidebarCollapsed": true,
            "instances": {"home": [{"instanceId":"home:custom:1","widgetId":"main.console","visible":true,"keepAlive":true}]}
        });
        let migrated = migrate_profile(legacy).unwrap();
        assert_eq!(migrated.schema_version, 2);
        assert_eq!(migrated.active_workspace, "monitor");
        assert_eq!(migrated.sidebar_mode, "rail");
        assert_eq!(migrated.instances["home"][0].instance_id, "home:custom:1");
    }

    #[test]
    fn denies_missing_capabilities() {
        let runtime = RuntimeController::default();
        let mut inner = lock(&runtime.inner);
        inner
            .profile
            .grants
            .get_mut("main")
            .unwrap()
            .retain(|item| item != "serial.command");
        drop(inner);
        let request = RuntimeDispatchRequest {
            operation: "serial.send".into(),
            payload: Value::Null,
        };
        assert!(runtime.authorize(&request).is_err());
    }

    #[test]
    fn computes_background_lifecycle_from_keep_alive() {
        let runtime = RuntimeController::default();
        let mut inner = lock(&runtime.inner);
        inner.profile.active_workspace = "main".into();
        assert_eq!(module_state(&inner.profile, "monitor"), "background");
        inner
            .profile
            .enabled_modules
            .insert("monitor".into(), false);
        assert_eq!(module_state(&inner.profile, "monitor"), "disabled");
    }

    #[test]
    fn bounds_runtime_history() {
        let runtime = RuntimeController::default();
        for index in 0..(HISTORY_LIMIT + 30) {
            runtime.record("test", json!({"index": index}));
        }
        let inner = lock(&runtime.inner);
        assert_eq!(inner.history.len(), HISTORY_LIMIT);
        assert!(inner.history.front().unwrap().cursor > 1);
    }

    #[test]
    fn detects_stale_revisions() {
        assert!(validate_expected_revision(4, Some(4)).is_ok());
        assert!(validate_expected_revision(4, None).is_ok());
        assert!(validate_expected_revision(4, Some(3)).is_err());
    }

    #[test]
    fn hub_is_clamped_and_profiles_are_complete() {
        let mut profile = default_profile("default");
        mutate_profile(
            &mut profile,
            &RuntimeAction::SetHubDock {
                edge: "top".into(),
                offset: 4.0,
            },
        )
        .unwrap();
        assert_eq!(profile.hub_dock.edge, "top");
        assert_eq!(profile.hub_dock.offset, 0.92);
        assert_eq!(profile.layouts.len(), 4);
    }

    #[test]
    fn validates_telemetry_resolution_and_migrates_old_v2_profiles() {
        let mut profile = default_profile("default");
        mutate_profile(
            &mut profile,
            &RuntimeAction::SetTelemetryInterval {
                interval_ms: 30_000,
            },
        )
        .unwrap();
        assert_eq!(profile.telemetry_interval_ms, 30_000);
        assert!(mutate_profile(
            &mut profile,
            &RuntimeAction::SetTelemetryInterval { interval_ms: 7_000 },
        )
        .is_err());

        let mut serialized = serde_json::to_value(default_profile("default")).unwrap();
        serialized
            .as_object_mut()
            .unwrap()
            .remove("telemetryIntervalMs");
        assert_eq!(
            migrate_profile(serialized).unwrap().telemetry_interval_ms,
            DEFAULT_TELEMETRY_INTERVAL_MS
        );
    }

    #[test]
    fn persists_console_autoscroll_and_defaults_old_profiles_on() {
        let mut profile = default_profile("default");
        mutate_profile(
            &mut profile,
            &RuntimeAction::SetConsoleAutoScroll { enabled: false },
        )
        .unwrap();
        assert!(!profile.console_auto_scroll);

        let mut serialized = serde_json::to_value(default_profile("default")).unwrap();
        serialized
            .as_object_mut()
            .unwrap()
            .remove("consoleAutoScroll");
        assert!(migrate_profile(serialized).unwrap().console_auto_scroll);
    }

    #[test]
    fn defaults_old_profiles_to_windows_gpu_selection() {
        let mut serialized = serde_json::to_value(default_profile("default")).unwrap();
        serialized.as_object_mut().unwrap().remove("masterGpuLuid");
        assert_eq!(migrate_profile(serialized).unwrap().master_gpu_luid, None);
    }

    #[test]
    fn adds_new_default_widgets_once_without_replacing_existing_layout() {
        let mut profile = default_profile("default");
        profile
            .instances
            .get_mut("monitor")
            .unwrap()
            .retain(|item| {
                item.widget_id != "monitor.vram"
                    && item.widget_id != "monitor.ccc"
                    && item.widget_id != "monitor.residency"
            });
        for items in profile.layouts.get_mut("monitor").unwrap().values_mut() {
            items.retain(|item| {
                !item.i.contains("monitor.vram")
                    && !item.i.contains("monitor.ccc")
                    && !item.i.contains("monitor.residency")
            });
            items[0].x = 1;
            items[0].y = 7;
        }

        normalize_profile(&mut profile);
        let count = profile.instances["monitor"].len();
        normalize_profile(&mut profile);
        assert_eq!(profile.instances["monitor"].len(), count);
        assert_eq!(
            profile.instances["monitor"]
                .iter()
                .filter(|item| item.widget_id == "monitor.vram")
                .count(),
            1
        );
        assert_eq!(
            profile.instances["monitor"]
                .iter()
                .filter(|item| item.widget_id == "monitor.ccc")
                .count(),
            1
        );
        assert_eq!(
            profile.instances["monitor"]
                .iter()
                .filter(|item| item.widget_id == "monitor.residency")
                .count(),
            1
        );
        assert_eq!(profile.layouts["monitor"]["lg"][0].x, 1);
        assert_eq!(profile.layouts["monitor"]["lg"][0].y, 7);
    }

    #[test]
    fn residency_operations_require_explicit_capabilities() {
        let runtime = RuntimeController::default();
        let snapshot = RuntimeDispatchRequest {
            operation: "gpu.residency.snapshot".into(),
            payload: Value::Null,
        };
        let policy = RuntimeDispatchRequest {
            operation: "gpu.residency.setProcessPolicy".into(),
            payload: Value::Null,
        };
        let agent = RuntimeDispatchRequest {
            operation: "gpu.residency.attachAgent".into(),
            payload: Value::Null,
        };
        assert!(runtime.authorize(&snapshot).is_ok());
        assert!(runtime.authorize(&policy).is_ok());
        assert!(runtime.authorize(&agent).is_ok());

        let mut inner = lock(&runtime.inner);
        inner.profile.grants.get_mut("monitor").unwrap().clear();
        drop(inner);
        assert!(runtime.authorize(&snapshot).is_err());
        assert!(runtime.authorize(&policy).is_err());
        assert!(runtime.authorize(&agent).is_err());
    }

    #[test]
    fn firmware_restart_requires_low_level_capability() {
        let runtime = RuntimeController::default();
        let request = RuntimeDispatchRequest {
            operation: "system.rebootToFirmware".into(),
            payload: Value::Null,
        };
        assert!(runtime.authorize(&request).is_ok());
        lock(&runtime.inner)
            .profile
            .grants
            .get_mut("monitor")
            .unwrap()
            .retain(|item| item != "hardware.lowlevel");
        assert!(runtime.authorize(&request).is_err());
    }

    #[test]
    fn dispatch_owner_is_derived_by_the_backend() {
        assert_eq!(operation_owner("serial.send"), Some("main"));
        assert_eq!(operation_owner("updates.install"), Some("enjoy"));
        assert_eq!(operation_owner("process.terminate"), Some("monitor"));
        assert_eq!(operation_owner("unknown.operation"), None);
    }

    #[test]
    fn renderer_cannot_change_sensitive_capabilities() {
        let mut profile = default_profile("default");
        let action = RuntimeAction::SetCapability {
            module_id: "monitor".into(),
            capability: "process.control".into(),
            enabled: false,
        };
        assert!(mutate_profile(&mut profile, &action).is_err());
        assert!(profile.grants["monitor"].contains(&"process.control".to_string()));
    }

    #[test]
    fn rejects_oversized_profiles_and_history_payloads() {
        let mut profile = default_profile("default");
        profile
            .instances
            .get_mut("home")
            .unwrap()
            .extend(
                (0..MAX_INSTANCES_PER_WORKSPACE).map(|index| WidgetInstance {
                    instance_id: format!("home:main.console:extra-{index}"),
                    widget_id: "main.console".into(),
                    visible: true,
                    keep_alive: false,
                }),
            );
        assert!(validate_profile_limits(&profile).is_err());

        let bounded = bound_history_payload(json!({"data": "x".repeat(HISTORY_PAYLOAD_LIMIT)}));
        assert_eq!(
            bounded.get("truncated").and_then(Value::as_bool),
            Some(true)
        );
    }
}
