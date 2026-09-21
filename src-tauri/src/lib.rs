use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use chrono::Timelike;
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

mod phone_feed;

// Every outbound HTTP call in this file shares one client instead of
// constructing a fresh reqwest::Client per call. A new Client means an empty
// connection pool — even two calls to the same host back-to-back (GitHub,
// the Hermes gateway, Open-Meteo) would each pay a full TCP+TLS handshake
// instead of reusing a kept-alive connection. OnceLock keeps this to a
// single lazy init with no extra dependency.
static HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn http_client() -> &'static reqwest::Client {
  HTTP_CLIENT.get_or_init(reqwest::Client::new)
}

// --- Audit log ---------------------------------------------------------
// Append-only, plain JSON Lines, human-readable without any tooling. Every
// tool call, every confirmation outcome, and every time a request actually
// goes to a cloud model gets a line here — this is what makes "trust me"
// unnecessary; you can just read the file.
fn audit_log_path(app: &tauri::AppHandle) -> PathBuf {
  app
    .path()
    .app_data_dir()
    .unwrap_or_else(|_| PathBuf::from("."))
    .join("audit_log.jsonl")
}

fn append_audit_log(app: &tauri::AppHandle, request_id: u64, event: &str, detail: &str) {
  let path = audit_log_path(app);
  let Some(parent) = path.parent() else { return };
  let _ = fs::create_dir_all(parent);

  let line = serde_json::json!({
    "timestamp": chrono::Local::now().to_rfc3339(),
    "request_id": request_id,
    "event": event,
    "detail": detail,
  });

  if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
    let _ = writeln!(file, "{line}");
  }
}

#[tauri::command]
fn read_audit_log(app: tauri::AppHandle, max_lines: usize) -> Result<String, String> {
  let content = fs::read_to_string(audit_log_path(&app)).unwrap_or_default();
  let lines: Vec<&str> = content.lines().collect();
  let start = lines.len().saturating_sub(max_lines);
  Ok(lines[start..].join("\n"))
}

#[derive(Debug, Deserialize, Serialize)]
struct OllamaModel {
  id: String,
}

#[derive(Debug, Deserialize)]
struct OllamaModelsResponse {
  data: Vec<OllamaModel>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
struct OllamaToolCallFunction {
  name: String,
  // Ollama sends this as a real JSON object, not a stringified blob.
  #[serde(default)]
  arguments: serde_json::Value,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
struct OllamaToolCall {
  #[serde(default)]
  function: OllamaToolCallFunction,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
struct OllamaMessage {
  role: String,
  #[serde(default)]
  content: String,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  tool_calls: Vec<OllamaToolCall>,
  // Only set on role: "tool" messages.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  tool_name: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct OllamaChatResponse {
  #[serde(default)]
  message: Option<OllamaMessage>,
  #[serde(default)]
  done_reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ChatRequest {
  model: String,
  messages: Vec<OllamaMessage>,
  think: bool,
  request_id: u64,
  temperature: Option<f64>,
  num_predict: Option<i32>,
  #[serde(default)]
  knowledge_paths: Vec<String>,
  // Defaults to true (deny-by-default, same philosophy as the tool
  // confirmation gate): an old frontend build or a missing field must never
  // silently permit a cloud call.
  #[serde(default = "default_true")]
  privacy_mode: bool,
  // Knowledge paths the user has marked Secret. Enforced independently of
  // privacy_mode: even with Privacy Mode off (cloud allowed generally), a
  // Secret folder must stay invisible and untouchable to a cloud model — the
  // model never gets to decide something is safe to declassify.
  #[serde(default)]
  secret_paths: Vec<String>,
}

fn default_true() -> bool {
  true
}

// The "-cloud" suffix is applied by this app when merging cloud models into
// the picker (see get_ollama_models) — verified directly against the live
// API that ollama.com/v1/models does NOT send this suffix back itself, so it
// cannot be trusted as something Ollama guarantees on model names in
// general. It's reliable here only because this codebase is the sole place
// that adds it, consistently, for every cloud-sourced model.
fn is_cloud_model(model: &str) -> bool {
  model.to_lowercase().ends_with("-cloud")
}

fn strip_cloud_suffix(model: &str) -> String {
  model.strip_suffix("-cloud").map(str::to_string).unwrap_or_else(|| model.to_string())
}

// A second Ollama instance the user owns and controls on their own hardware
// (e.g. a home server reachable only over their private Tailscale network),
// not a third party — so unlike "-cloud", this is never blocked by Privacy
// Mode. Same synthetic-suffix trick: never part of a real model name,
// applied only when listing remote models, stripped before the name is sent
// back to that server's own API.
fn is_remote_model(model: &str) -> bool {
  model.to_lowercase().ends_with("-remote")
}

fn strip_remote_suffix(model: &str) -> String {
  model.strip_suffix("-remote").map(str::to_string).unwrap_or_else(|| model.to_string())
}

const OLLAMA_CLOUD_API_BASE: &str = "https://ollama.com";

fn ollama_cloud_key_path(app: &tauri::AppHandle) -> PathBuf {
  app
    .path()
    .app_data_dir()
    .unwrap_or_else(|_| PathBuf::from("."))
    .join("ollama_cloud_key.txt")
}

// Deliberately stored in a local file the frontend can never read back, not
// localStorage — an API key is a real secret, not app state.
#[tauri::command]
fn set_ollama_cloud_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
  // The phone's only brain is horus over Tailscale: it can never be given a cloud key.
  #[cfg(target_os = "android")]
  {
    let _ = (&app, &key);
    return Err("The phone doesn't use cloud models: it only talks to horus over Tailscale.".to_string());
  }
  #[cfg(not(target_os = "android"))]
  {
    let path = ollama_cloud_key_path(&app);
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, key.trim()).map_err(|error| error.to_string())
  }
}

#[tauri::command]
fn has_ollama_cloud_key(app: tauri::AppHandle) -> bool {
  read_ollama_cloud_key(&app).is_some()
}

#[tauri::command]
fn clear_ollama_cloud_key(app: tauri::AppHandle) -> Result<(), String> {
  let path = ollama_cloud_key_path(&app);
  if path.exists() {
    fs::remove_file(&path).map_err(|error| error.to_string())?;
  }
  Ok(())
}

fn read_ollama_cloud_key(app: &tauri::AppHandle) -> Option<String> {
  // Even a stray key file can't switch cloud models on for the phone.
  #[cfg(target_os = "android")]
  {
    let _ = app;
    return None;
  }
  #[cfg(not(target_os = "android"))]
  {
    fs::read_to_string(ollama_cloud_key_path(app))
      .ok()
      .map(|content| content.trim().to_string())
      .filter(|key| !key.is_empty())
  }
}

// --- Remote Ollama (own hardware, e.g. a home server over Tailscale) -----
// No API key stored or sent — the security boundary is the private network
// itself (Tailscale), the same trust basis local Ollama on this machine has
// always had. Same read/has/clear/set pattern as every other credential
// store in this file.
#[derive(Debug, Serialize, Deserialize, Clone)]
struct RemoteOllamaConfig {
  label: String,
  base_url: String,
}

fn remote_ollama_config_path(app: &tauri::AppHandle) -> PathBuf {
  app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("remote_ollama.json")
}

// The phone's one server (Iris's Android brief): horus, Dominus's own machine, reached over
// Tailscale. It is there from the first launch, and nothing outside Tailscale is accepted.
#[cfg(target_os = "android")]
const ANDROID_DEFAULT_REMOTE_LABEL: &str = "horus";
#[cfg(target_os = "android")]
const ANDROID_DEFAULT_REMOTE_URL: &str = "http://100.94.158.103:11434";

// True for an address on the user's own Tailscale network: an IPv4 in 100.64.0.0/10 or a
// *.ts.net name. Anything else (a cloud host, a look-alike such as
// "100.94.158.103.evil.com", a link with credentials in front of the host) is not.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn is_tailscale_url(url: &str) -> bool {
  let lower = url.trim().to_ascii_lowercase();
  let rest = match lower.strip_prefix("http://").or_else(|| lower.strip_prefix("https://")) {
    Some(rest) => rest,
    None => return false,
  };
  let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
  if authority.contains('@') || authority.is_empty() {
    return false;
  }
  let host = authority.rsplit_once(':').filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit())).map(|(host, _)| host).unwrap_or(authority);
  if host.ends_with(".ts.net") && host.len() > ".ts.net".len() && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
    return true;
  }
  match host.parse::<std::net::Ipv4Addr>() {
    Ok(address) => address.octets()[0] == 100 && (64..=127).contains(&address.octets()[1]),
    Err(_) => false,
  }
}

// Where the phone may send Iris's gateway traffic: her Tailscale network, and nothing else. A
// debug build (never a release one) also accepts 10.0.2.2, the emulator's name for the computer
// it runs on, so the sync can be tried end to end against a local stand-in for the gateway.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn phone_address_allowed(url: &str) -> bool {
  is_tailscale_url(url) || (cfg!(debug_assertions) && url.trim().to_ascii_lowercase().starts_with("http://10.0.2.2:"))
}

#[tauri::command]
fn set_remote_ollama_config(app: tauri::AppHandle, label: String, base_url: String) -> Result<(), String> {
  #[cfg(target_os = "android")]
  if !is_tailscale_url(&base_url) {
    return Err("On the phone the server has to be on your Tailscale network: an address like http://100.x.x.x:11434 or a name ending in .ts.net.".to_string());
  }
  let path = remote_ollama_config_path(&app);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let config = RemoteOllamaConfig { label: label.trim().to_string(), base_url: base_url.trim().trim_end_matches('/').to_string() };
  let serialized = serde_json::to_string(&config).map_err(|error| error.to_string())?;
  fs::write(&path, serialized).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_remote_ollama_config(app: tauri::AppHandle) -> Option<RemoteOllamaConfig> {
  read_remote_ollama_config(&app)
}

#[tauri::command]
fn clear_remote_ollama_config(app: tauri::AppHandle) -> Result<(), String> {
  let path = remote_ollama_config_path(&app);
  if path.exists() {
    fs::remove_file(&path).map_err(|error| error.to_string())?;
  }
  Ok(())
}

fn read_remote_ollama_config(app: &tauri::AppHandle) -> Option<RemoteOllamaConfig> {
  let saved = fs::read_to_string(remote_ollama_config_path(app))
    .ok()
    .and_then(|raw| serde_json::from_str::<RemoteOllamaConfig>(&raw).ok())
    .filter(|config| !config.base_url.is_empty());
  #[cfg(target_os = "android")]
  {
    // Whatever was saved must still be a Tailscale address; otherwise horus.
    return match saved {
      Some(config) if is_tailscale_url(&config.base_url) => Some(config),
      _ => Some(RemoteOllamaConfig { label: ANDROID_DEFAULT_REMOTE_LABEL.to_string(), base_url: ANDROID_DEFAULT_REMOTE_URL.to_string() }),
    };
  }
  #[cfg(not(target_os = "android"))]
  {
    saved
  }
}

#[derive(Debug, Serialize, Clone)]
struct OllamaStreamChunk {
  request_id: u64,
  delta: String,
}

#[derive(Debug, Serialize, Clone)]
struct OllamaToolStatusEvent {
  request_id: u64,
  tool: String,
  status: String,
}

// Models known to carry a tool-aware chat template. Deliberately an allowlist,
// not a denylist: an unrecognized model must default to NOT supporting tools,
// so a newly-pulled plain-chat model falls back to the old always-inject
// knowledge behavior instead of silently getting a `tools` array it was never
// trained for. Keep in sync with `modelSupportsTools` in App.tsx.
fn model_supports_tool_calling(model: &str) -> bool {
  let lower = model.to_lowercase();
  lower.contains("hermes3") || lower.contains("hermes-3") || lower.contains("qwen2.5")
}

#[tauri::command]
fn model_supports_tools(model: String) -> bool {
  model_supports_tool_calling(&model)
}

#[tauri::command]
async fn get_ollama_models(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
  let client = http_client();
  let mut models: Vec<String> = Vec::new();
  // Why the list came back empty, if it did.
  let mut problem: Option<String> = None;

  // Ollama on this machine. A phone has none, and a PC that isn't running it shouldn't
  // lose the models it can still reach on the server.
  #[cfg(not(target_os = "android"))]
  match client.get("http://localhost:11434/v1/models").send().await {
    Ok(response) if response.status().is_success() => match response.json::<OllamaModelsResponse>().await {
      Ok(data) => models.extend(data.data.into_iter().map(|model| model.id).filter(|model| !model.to_lowercase().contains("embed"))),
      Err(error) => problem = Some(error.to_string()),
    },
    Ok(response) => problem = Some(format!("Unable to load local models: {}", response.status())),
    Err(error) => problem = Some(error.to_string()),
  }

  // Only ever attempted when a key is actually configured — no key means no
  // outbound call to Ollama's cloud endpoint at all, not even to list models.
  if let Some(key) = read_ollama_cloud_key(&app_handle) {
    let cloud_response = client
      .get(format!("{OLLAMA_CLOUD_API_BASE}/v1/models"))
      .bearer_auth(&key)
      .send()
      .await;

    if let Ok(cloud_response) = cloud_response {
      if cloud_response.status().is_success() {
        if let Ok(cloud_data) = cloud_response.json::<OllamaModelsResponse>().await {
          // Verified directly against the live API: ollama.com/v1/models
          // returns bare names ("gpt-oss:20b", not "gpt-oss:20b-cloud") — the
          // "-cloud" suffix isn't something Ollama's cloud endpoint actually
          // sends back here, so it has to be applied on this end to be a
          // reliable signal. This is the one place that tag gets added; every
          // downstream is_cloud_model() check depends on it being added here
          // and nowhere else, and being stripped again before the model name
          // is sent back to Ollama's API (see strip_cloud_suffix).
          for model in cloud_data.data {
            let tagged = format!("{}-cloud", model.id);
            if !models.contains(&tagged) {
              models.push(tagged);
            }
          }
        }
      }
    }
  }

  // Only attempted when a remote server is actually configured, same
  // pattern as cloud above — a private home server, not a third party, so
  // this fetch never touches anything Privacy Mode is meant to gate.
  if let Some(remote) = read_remote_ollama_config(&app_handle) {
    // A short wait: with Tailscale off the connection just hangs, and the picker
    // should say so in seconds rather than after the network's own long timeout.
    let listed = async {
      let response = client
        .get(format!("{}/v1/models", remote.base_url))
        .timeout(std::time::Duration::from_secs(6))
        .send()
        .await
        .map_err(|_| format!("Can't reach {} at {}. Is Tailscale on?", remote.label, remote.base_url))?;
      if !response.status().is_success() {
        return Err(format!("{} answered with an error ({}).", remote.label, response.status()));
      }
      response.json::<OllamaModelsResponse>().await.map_err(|error| format!("{} sent something unreadable: {error}", remote.label))
    }
    .await;
    match listed {
      Ok(remote_data) => {
        for model in remote_data.data {
          let tagged = format!("{}-remote", model.id);
          if !models.contains(&tagged) {
            models.push(tagged);
          }
        }
      }
      Err(message) => problem = Some(message),
    }
  }

  if models.is_empty() {
    if let Some(message) = problem {
      return Err(message);
    }
  }
  Ok(models)
}

// One AbortHandle per in-flight chat request, keyed by request_id, so the Stop
// button can end a run that's slow or heading the wrong way. Aborting drops the
// conversation future at its next await point: the streaming HTTP connection
// closes (Ollama stops generating once the client hangs up) and no further tool
// call is ever started. Work already handed to a blocking subprocess (a Hermes
// run, a knowledge-base query) is not killed — the same accepted limit
// HERMES_DEFAULT_TIMEOUT_SECS documents for its own timeout.
struct ChatCancelState {
  handles: Mutex<HashMap<u64, futures_util::future::AbortHandle>>,
}

#[tauri::command]
async fn chat_with_ollama(app_handle: tauri::AppHandle, request: ChatRequest) -> Result<String, String> {
  let request_id = request.request_id;
  let (abort_handle, abort_registration) = futures_util::future::AbortHandle::new_pair();
  if let Ok(mut handles) = app_handle.state::<ChatCancelState>().handles.lock() {
    handles.insert(request_id, abort_handle);
  }

  let conversation = run_ollama_conversation(
    app_handle.clone(),
    request.model,
    request.messages,
    request_id,
    request.knowledge_paths,
    request.think,
    request.temperature,
    request.num_predict,
    request.privacy_mode,
    request.secret_paths,
  );
  let outcome = futures_util::future::Abortable::new(conversation, abort_registration).await;

  if let Ok(mut handles) = app_handle.state::<ChatCancelState>().handles.lock() {
    handles.remove(&request_id);
  }

  match outcome {
    Ok(result) => result,
    Err(_) => {
      append_audit_log(&app_handle, request_id, "request_cancelled", "stopped by user");
      Err("Request cancelled.".to_string())
    }
  }
}

// Returns whether a running request was actually found — false just means it
// already finished, which is not an error from the user's point of view.
#[tauri::command]
fn cancel_chat(app: tauri::AppHandle, request_id: u64) -> bool {
  let handle = {
    let state = app.state::<ChatCancelState>();
    let mut handles = match state.handles.lock() {
      Ok(handles) => handles,
      Err(_) => return false,
    };
    handles.remove(&request_id)
  };
  match handle {
    Some(handle) => {
      handle.abort();
      true
    }
    None => false,
  }
}

// The actual conversation + tool-calling loop, shared by the live chat
// command above (emits streaming events a listening frontend request picks
// up) and the scheduled-task runner below (same events, just with request_id
// 0 and nothing listening — Tauri events with no listener are a harmless
// no-op, so this needs no special-casing for the unattended case).
async fn run_ollama_conversation(
  app_handle: tauri::AppHandle,
  model: String,
  messages: Vec<OllamaMessage>,
  request_id: u64,
  knowledge_paths: Vec<String>,
  think: bool,
  temperature: Option<f64>,
  num_predict: Option<i32>,
  privacy_mode: bool,
  secret_paths: Vec<String>,
) -> Result<String, String> {
  let is_cloud = is_cloud_model(&model);
  let is_remote = is_remote_model(&model);

  // The authoritative gate — enforced here, not just hidden from the model
  // picker in the UI, so there is no code path (including a future one) that
  // can reach a cloud model while Privacy Mode is on. Checked before any
  // network call is made, not after. Remote is deliberately NOT gated here —
  // it's the user's own hardware on their own private network, not a third
  // party, so it's held to the same trust level as local, not cloud.
  if privacy_mode && is_cloud {
    return Err("Privacy Mode is on — cloud models are disabled. Turn off Privacy Mode to use this model.".to_string());
  }
  // The phone never uses a cloud model, in or out of Privacy Mode, even as a fallback.
  #[cfg(target_os = "android")]
  if is_cloud {
    return Err("Cloud models are turned off on the phone: it only uses horus over Tailscale.".to_string());
  }

  let cloud_key = if is_cloud { read_ollama_cloud_key(&app_handle) } else { None };
  if is_cloud && cloud_key.is_none() {
    return Err("No Ollama Cloud API key is configured yet — add one in Settings to use cloud models.".to_string());
  }

  let remote_config = if is_remote { read_remote_ollama_config(&app_handle) } else { None };
  if is_remote && remote_config.is_none() {
    return Err("No remote Ollama server is configured yet — add one in Settings to use it.".to_string());
  }

  if is_cloud {
    append_audit_log(&app_handle, request_id, "cloud_request", &format!("model={model}"));
  }
  if is_remote {
    append_audit_log(&app_handle, request_id, "remote_request", &format!("model={model}"));
  }

  let client = http_client();
  let mut request_messages = messages;

  // Personalization context, always injected (not tool-gated) so "learn more
  // about me over time" actually shows up without the model needing to think
  // to ask for it — bounded in size via USER_MEMORY_MAX_LINES.
  let user_memory = read_user_memory(&app_handle);
  if !user_memory.is_empty() {
    request_messages.insert(
      0,
      OllamaMessage {
        role: "system".to_string(),
        content: format!("What you already know about the user from earlier conversations (use naturally, don't recite this list):\n{user_memory}"),
        tool_calls: vec![],
        tool_name: None,
      },
    );
  }

  let mut final_content = String::new();
  let tool_capable = model_supports_tool_calling(&model);

  // Two independent, bounded counters rather than one shared budget — a
  // chatty tool round shouldn't eat into truncation-continuation budget or
  // vice versa. MAX_TOTAL_PASSES is a hard backstop on the outer loop so
  // termination is guaranteed regardless of how the two interleave.
  const MAX_TRUNCATION_PASSES: u8 = 2;
  const MAX_TOOL_ROUNDS: u8 = 4;
  const MAX_TOTAL_PASSES: u8 = MAX_TRUNCATION_PASSES + MAX_TOOL_ROUNDS + 1;
  let mut truncation_passes_used: u8 = 0;
  let mut tool_rounds_used: u8 = 0;

  for _ in 0..MAX_TOTAL_PASSES {
    let attach_tools = tool_capable && tool_rounds_used < MAX_TOOL_ROUNDS;

    let mut body = if is_cloud {
      // Cloud-hosted models run on Ollama's own infrastructure, which
      // schedules its own threading/context/GPU allocation server-side — the
      // local hardware tuning below is meaningless (or possibly rejected)
      // there, so only the genuinely universal generation options go along.
      serde_json::json!({
        // Ollama's cloud API expects the bare name (confirmed against the
        // live API) — the "-cloud" suffix is purely this app's own internal
        // marker and must never actually be sent to Ollama.
        "model": strip_cloud_suffix(&model),
        "messages": request_messages,
        "think": think,
        "stream": true,
        "options": {
          "temperature": temperature.unwrap_or(0.7),
          "num_predict": num_predict.unwrap_or(1536),
        }
      })
    } else if is_remote {
      // Same universal-options-only reasoning as cloud, for a different
      // reason: num_thread/num_gpu below are tuned specifically for this
      // laptop's own CPU (see comments there) and would be meaningless — or
      // actively wrong — on whatever hardware the remote server actually
      // has. Let its own Ollama installation auto-tune for itself.
      serde_json::json!({
        "model": strip_remote_suffix(&model),
        "messages": request_messages,
        "think": think,
        "stream": true,
        "keep_alive": "4h",
        "options": {
          "temperature": temperature.unwrap_or(0.7),
          "num_predict": num_predict.unwrap_or(1536),
        }
      })
    } else {
      serde_json::json!({
        "model": model,
        "messages": request_messages,
        "think": think,
        "stream": true,
        // Ollama's default unloads an idle model after 5 minutes, so any gap in
        // the day (lunch, a meeting) pays the full ~15-40s reload cost measured
        // on this machine. Keep it resident for a normal work session instead.
        "keep_alive": "4h",
        "options": {
          "temperature": temperature.unwrap_or(0.7),
          "num_predict": num_predict.unwrap_or(1536),
          // num_gpu deliberately omitted (not forced to 0): that earlier "no
          // working Iris Xe backend" finding was accurate at the time, but for
          // a different reason than it looked like — Ollama's Vulkan iGPU path
          // was being silently dropped server-side regardless of num_gpu,
          // unless OLLAMA_IGPU_ENABLE=1 is set on the Ollama process itself
          // (confirmed via server.log: "dropping integrated GPU; to enable,
          // set OLLAMA_IGPU_ENABLE=1"). With that env var set, the same
          // Iris Xe iGPU is detected as a real inference device and the whole
          // 7B model offloads to it automatically — measured ~2x faster
          // generation (2.9 -> 5.8 tok/s) than forcing CPU-only. Forcing
          // num_gpu:0 here would have silently overridden that regardless of
          // the server-side env var, so leave it unset and let Ollama's own
          // VRAM-based scheduler decide.
          // Empirically fastest on this i9-13900H (measured, not assumed — using
          // all 20 logical threads or restricting to 6 P-cores only were both
          // slower than this in repeated tests).
          "num_thread": 12,
          // Ollama defaults this model to a 32768-token context, which alone
          // roughly doubles its resident RAM footprint (measured 7.5GB -> 5.3GB
          // dropping to 4096) for a chat app that never approaches that length.
          "num_ctx": 4096,
        }
      })
    };

    if attach_tools {
      if let Some(object) = body.as_object_mut() {
        object.insert("tools".to_string(), serde_json::Value::Array(tools_as_ollama_json()));
      }
    }

    let request_url = if is_cloud {
      format!("{OLLAMA_CLOUD_API_BASE}/api/chat")
    } else if is_remote {
      format!("{}/api/chat", remote_config.as_ref().map(|config| config.base_url.as_str()).unwrap_or_default())
    } else {
      "http://localhost:11434/api/chat".to_string()
    };
    let mut request_builder = client.post(&request_url).json(&body);
    if is_cloud {
      // cloud_key is guaranteed Some here — checked before the loop started.
      request_builder = request_builder.bearer_auth(cloud_key.as_deref().unwrap_or_default());
    }

    let response = request_builder.send().await.map_err(|error| error.to_string())?;

    if !response.status().is_success() {
      let status = response.status();
      let body_text = response.text().await.unwrap_or_default();
      return Err(if body_text.is_empty() {
        format!("Local AI request failed with status {}", status)
      } else {
        body_text
      });
    }

    let mut byte_stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut pass_content = String::new();
    let mut pass_tool_calls: Vec<OllamaToolCall> = Vec::new();
    let mut done_reason: Option<String> = None;

    while let Some(chunk_result) = byte_stream.next().await {
      let bytes = chunk_result.map_err(|error| error.to_string())?;
      buffer.extend_from_slice(&bytes);

      while let Some(newline_index) = buffer.iter().position(|&byte| byte == b'\n') {
        let line_bytes: Vec<u8> = buffer.drain(..=newline_index).collect();
        let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len().saturating_sub(1)]);
        let line = line.trim();
        if line.is_empty() {
          continue;
        }

        let parsed: OllamaChatResponse = match serde_json::from_str(line) {
          Ok(value) => value,
          Err(_) => continue,
        };

        if let Some(message) = parsed.message {
          if !message.content.is_empty() {
            pass_content.push_str(&message.content);
            let _ = app_handle.emit(
              "ollama-chunk",
              OllamaStreamChunk {
                request_id,
                delta: message.content,
              },
            );
          }
          // Defensive accumulation: NDJSON framing makes it unlikely a single
          // tool_calls array spans multiple lines, but accumulating across the
          // whole pass (rather than trusting the first sighting) handles that
          // case for free if it ever happens.
          if !message.tool_calls.is_empty() {
            pass_tool_calls.extend(message.tool_calls);
          }
        }

        if parsed.done_reason.is_some() {
          done_reason = parsed.done_reason;
        }
      }
    }

    if !pass_content.is_empty() || !pass_tool_calls.is_empty() {
      if !pass_content.is_empty() {
        if !final_content.is_empty() {
          final_content.push('\n');
        }
        final_content.push_str(&pass_content);
      }
      // Push even when pass_content is empty but a tool was called — Ollama
      // expects tool_calls to live on an assistant-role history message.
      request_messages.push(OllamaMessage {
        role: "assistant".to_string(),
        content: pass_content,
        tool_calls: pass_tool_calls.clone(),
        tool_name: None,
      });
    }

    // Guarding on attach_tools (not just pass_tool_calls) means once the tool
    // budget is exhausted this branch is structurally unreachable even if a
    // model hallucinates a call it was never offered the "tools" field for —
    // termination within MAX_TOTAL_PASSES is guaranteed either way.
    if attach_tools && !pass_tool_calls.is_empty() {
      for tool_call in &pass_tool_calls {
        let tool_name = tool_call.function.name.clone();
        let _ = app_handle.emit(
          "ollama-tool-status",
          OllamaToolStatusEvent { request_id, tool: tool_name.clone(), status: "running".to_string() },
        );
        let result = execute_tool_call(&app_handle, request_id, tool_call, &knowledge_paths, is_cloud, &secret_paths).await;
        append_audit_log(&app_handle, request_id, "tool_call", &format!("tool={tool_name} cloud={is_cloud}"));
        let _ = app_handle.emit(
          "ollama-tool-status",
          OllamaToolStatusEvent { request_id, tool: tool_name.clone(), status: "done".to_string() },
        );
        request_messages.push(OllamaMessage {
          role: "tool".to_string(),
          content: result,
          tool_calls: vec![],
          tool_name: Some(tool_name),
        });
      }
      tool_rounds_used += 1;
      continue;
    }

    if matches!(done_reason.as_deref(), Some("length")) && truncation_passes_used + 1 < MAX_TRUNCATION_PASSES {
      truncation_passes_used += 1;
      request_messages.push(OllamaMessage {
        role: "user".to_string(),
        content: "Continue exactly where you left off. Do not repeat previous text.".to_string(),
        tool_calls: vec![],
        tool_name: None,
      });
      continue;
    }

    break;
  }

  Ok(final_content)
}

fn supported_document(path: &Path) -> bool {
  matches!(
    path.extension()
      .and_then(|extension| extension.to_str())
      .map(|extension| extension.to_lowercase())
      .as_deref(),
    Some("md")
      | Some("markdown")
      | Some("txt")
      | Some("json")
      | Some("csv")
      | Some("yaml")
      | Some("yml")
      | Some("toml")
      | Some("html")
      | Some("htm")
      | Some("log")
      | Some("rst")
      | Some("pdf")
  )
}

const MAX_DOCUMENT_BYTES: u64 = 25 * 1024 * 1024;

fn collect_documents(folder: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
  if !folder.exists() {
    return Ok(());
  }

  for entry in fs::read_dir(folder).map_err(|error| error.to_string())? {
    let entry = entry.map_err(|error| error.to_string())?;
    let path = entry.path();

    // Skip dotfolders (.obsidian, .smart-env, .git, ...) — plugin/config data,
    // not vault content, and indexing it just pollutes search results.
    let is_hidden = path
      .file_name()
      .and_then(|name| name.to_str())
      .map(|name| name.starts_with('.'))
      .unwrap_or(false);
    if is_hidden {
      continue;
    }

    if path.is_dir() {
      collect_documents(&path, output)?;
    } else if supported_document(&path) {
      output.push(path);
    }
  }

  Ok(())
}

// A deterministic (non-randomized) hash, used only to name on-disk cache files —
// Rust's default HashMap hasher is seeded per-process, so it can't be used here;
// cache filenames must be stable across app restarts to find themselves again.
fn stable_hash(input: &str) -> String {
  let mut hash: u64 = 0xcbf29ce484222325;
  for byte in input.as_bytes() {
    hash ^= *byte as u64;
    hash = hash.wrapping_mul(0x100000001b3);
  }
  format!("{:016x}", hash)
}

const FILE_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

// OneDrive (and other Files-On-Demand cloud sync) marks a not-yet-downloaded
// file with these attributes. Reading one triggers slow on-demand hydration
// — exactly the "read that never returns promptly" case read_content_with_
// timeout below already bounds to FILE_READ_TIMEOUT. Detecting it up front
// means a whole run of cloud-only files costs a metadata check each
// (microseconds) instead of the full 30s timeout each — observed directly
// on this library: a cluster of these files made a scan look frozen for
// several minutes even though it was working correctly the whole time.
// Skipped files just get picked up on the next periodic rescan once OneDrive
// hydrates them in the background on its own.
#[cfg(windows)]
fn is_cloud_placeholder(metadata: &fs::Metadata) -> bool {
  use std::os::windows::fs::MetadataExt;
  const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
  const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
  let attributes = metadata.file_attributes();
  attributes & FILE_ATTRIBUTE_OFFLINE != 0 || attributes & FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS != 0
}

#[cfg(not(windows))]
fn is_cloud_placeholder(_metadata: &fs::Metadata) -> bool {
  false
}

fn extract_document_text(path: &Path) -> Option<String> {
  let metadata = fs::metadata(path).ok()?;
  if metadata.len() > MAX_DOCUMENT_BYTES {
    return None;
  }
  if is_cloud_placeholder(&metadata) {
    return None;
  }

  let is_pdf = path
    .extension()
    .and_then(|extension| extension.to_str())
    .map(|extension| extension.eq_ignore_ascii_case("pdf"))
    .unwrap_or(false);

  read_content_with_timeout(path, is_pdf)
}

// Two real, independent failure modes observed on this library, neither of
// which surfaces as an Err or a panic: a pathological PDF that pdf-extract
// just grinds on forever, and — since this library lives under OneDrive — a
// plain text/markdown file that's a cloud-only placeholder, where a normal
// fs::read_to_string blocks on Windows silently hydrating it from the cloud
// over a slow connection. Both look identical from the caller's side (a read
// that never returns), so both need the same fix: run the read on its own
// thread and bound the wait. One bad file out of thousands then costs at most
// FILE_READ_TIMEOUT instead of stalling the entire background scan
// indefinitely. The worker thread is abandoned (not killed — Rust has no safe
// way to do that) on timeout; it keeps running invisibly until it finishes or
// the app exits, but indexing itself moves on immediately.
fn read_content_with_timeout(path: &Path, is_pdf: bool) -> Option<String> {
  let (sender, receiver) = std::sync::mpsc::channel();
  let owned_path = path.to_path_buf();

  std::thread::spawn(move || {
    let result = std::panic::catch_unwind(move || {
      if is_pdf {
        pdf_extract::extract_text(&owned_path).ok()
      } else {
        fs::read_to_string(&owned_path).ok()
      }
    })
    .ok()
    .flatten();

    let _ = sender.send(result);
  });

  receiver.recv_timeout(FILE_READ_TIMEOUT).ok().flatten()
}

fn normalize_whitespace(text: &str) -> String {
  text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clamp_char_boundary(text: &str, mut index: usize) -> usize {
  if index > text.len() {
    index = text.len();
  }

  while index > 0 && !text.is_char_boundary(index) {
    index -= 1;
  }

  index
}

fn unique_tokens(text: &str) -> HashSet<String> {
  text
    .split(|character: char| !character.is_alphanumeric())
    .filter(|token| token.len() > 2)
    .map(|token| token.to_lowercase())
    .collect()
}

fn build_excerpt(content: &str, query_tokens: &HashSet<String>) -> String {
  if query_tokens.is_empty() {
    return normalize_whitespace(&content.chars().take(1200).collect::<String>());
  }

  let lower_content = content.to_lowercase();
  let mut hit_index: Option<usize> = None;

  for token in query_tokens {
    if let Some(index) = lower_content.find(token) {
      hit_index = Some(match hit_index {
        Some(current) => current.min(index),
        None => index,
      });
    }
  }

  let start = hit_index.map(|index| index.saturating_sub(350)).unwrap_or(0);
  let end = hit_index.map(|index| index.saturating_add(850)).unwrap_or(1200);
  let start = clamp_char_boundary(content, start);
  let end = clamp_char_boundary(content, end);

  if start >= end {
    normalize_whitespace(&content.chars().take(1200).collect::<String>())
  } else {
    normalize_whitespace(content.get(start..end).unwrap_or(content))
  }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct KnowledgeDocument {
  path: PathBuf,
  modified_unix: u64,
  cache_file: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct KnowledgeManifest {
  documents: Vec<KnowledgeDocument>,
  known_paths: Vec<PathBuf>,
}

#[derive(Default)]
struct KnowledgeIndex {
  manifest: KnowledgeManifest,
  postings: HashMap<String, Vec<usize>>,
  indexing: bool,
}

struct KnowledgeState {
  index: Mutex<KnowledgeIndex>,
  dir: PathBuf,
}

impl KnowledgeState {
  fn cache_dir(&self) -> PathBuf {
    self.dir.join("cache")
  }

  fn manifest_path(&self) -> PathBuf {
    self.dir.join("manifest.json")
  }

  fn load(dir: PathBuf) -> Self {
    let state = KnowledgeState { index: Mutex::new(KnowledgeIndex::default()), dir };

    if let Ok(raw) = fs::read_to_string(state.manifest_path()) {
      if let Ok(manifest) = serde_json::from_str::<KnowledgeManifest>(&raw) {
        let postings = build_postings(&manifest, &state.cache_dir());
        if let Ok(mut index) = state.index.lock() {
          index.manifest = manifest;
          index.postings = postings;
        }
      }
    }

    state
  }

  fn save_manifest(&self) {
    let serialized = match self.index.lock() {
      Ok(index) => serde_json::to_string(&index.manifest).ok(),
      Err(_) => None,
    };
    if let Some(serialized) = serialized {
      self.write_manifest_to_disk(&serialized);
    }
  }

  fn write_manifest_to_disk(&self, serialized: &str) {
    let _ = fs::create_dir_all(&self.dir);
    let _ = fs::write(self.manifest_path(), serialized);
  }
}

// Rebuilding postings from each document's already-cached plain-text file (a
// fast local read + tokenize) rather than persisting the postings map itself —
// simpler, and the one genuinely expensive step (PDF/HTML extraction from the
// original source file) is still fully skipped for anything already cached.
fn build_postings(manifest: &KnowledgeManifest, cache_dir: &Path) -> HashMap<String, Vec<usize>> {
  let mut postings: HashMap<String, Vec<usize>> = HashMap::new();
  for (doc_id, document) in manifest.documents.iter().enumerate() {
    let Ok(text) = fs::read_to_string(cache_dir.join(&document.cache_file)) else {
      continue;
    };
    for token in unique_tokens(&text) {
      postings.entry(token).or_default().push(doc_id);
    }
  }
  postings
}

fn run_indexing_pass(state: &KnowledgeState, app: &tauri::AppHandle, paths: &[PathBuf]) {
  let mut discovered = Vec::new();
  for root in paths {
    let _ = collect_documents(root, &mut discovered);
  }

  let cache_dir = state.cache_dir();
  let _ = fs::create_dir_all(&cache_dir);

  let existing: HashMap<PathBuf, KnowledgeDocument> = state
    .index
    .lock()
    .map(|index| {
      index
        .manifest
        .documents
        .iter()
        .cloned()
        .map(|document| (document.path.clone(), document))
        .collect()
    })
    .unwrap_or_default();

  let total = discovered.len();
  let _ = app.emit("knowledge-index-progress", serde_json::json!({ "done": 0, "total": total, "complete": false }));

  let mut updated_documents = Vec::with_capacity(total);

  for (processed, path) in discovered.into_iter().enumerate() {
    let modified_unix = fs::metadata(&path)
      .and_then(|metadata| metadata.modified())
      .ok()
      .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
      .map(|duration| duration.as_secs())
      .unwrap_or(0);

    let reused = existing.get(&path).filter(|document| document.modified_unix == modified_unix).cloned();

    let document = if let Some(document) = reused {
      Some(document)
    } else {
      eprintln!("Indexing {}", path.display());
      extract_document_text(&path).and_then(|text| {
        let cache_file = format!("{}.txt", stable_hash(&path.to_string_lossy()));
        fs::write(cache_dir.join(&cache_file), &text)
          .ok()
          .map(|_| KnowledgeDocument { path: path.clone(), modified_unix, cache_file })
      })
    };

    if let Some(document) = document {
      updated_documents.push(document);
    }

    if processed % 5 == 0 || processed + 1 == total {
      let _ = app.emit(
        "knowledge-index-progress",
        serde_json::json!({ "done": processed + 1, "total": total, "complete": false }),
      );
    }

    // Checkpoint to disk periodically. A library this size can take minutes to
    // fully extract (PDFs especially) — without this, killing the app mid-scan
    // would discard every extraction completed so far and force starting over
    // from zero on next launch instead of resuming.
    if processed > 0 && processed % 200 == 0 {
      let checkpoint = KnowledgeManifest { documents: updated_documents.clone(), known_paths: paths.to_vec() };
      if let Ok(serialized) = serde_json::to_string(&checkpoint) {
        state.write_manifest_to_disk(&serialized);
      }
    }
  }

  let manifest = KnowledgeManifest { documents: updated_documents, known_paths: paths.to_vec() };
  let postings = build_postings(&manifest, &cache_dir);

  if let Ok(mut index) = state.index.lock() {
    index.manifest = manifest;
    index.postings = postings;
    index.indexing = false;
  }

  state.save_manifest();
  let _ = app.emit("knowledge-index-progress", serde_json::json!({ "done": total, "total": total, "complete": true }));
}

fn spawn_knowledge_index(app: tauri::AppHandle, paths: Vec<PathBuf>) {
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<KnowledgeState>();

    // Check-and-set must be one atomic lock acquisition, not two — the mount-time
    // call from the frontend and get_knowledge_context's own auto-trigger can fire
    // within moments of each other, and a check followed by a separate set left a
    // window where both could see "not indexing" and run a full scan concurrently,
    // doubling CPU load on 546 PDFs for no reason.
    let acquired = state
      .index
      .lock()
      .map(|mut index| {
        if index.indexing {
          false
        } else {
          index.indexing = true;
          true
        }
      })
      .unwrap_or(false);

    if !acquired {
      return;
    }

    run_indexing_pass(&state, &app, &paths);
  });
}

#[tauri::command]
async fn index_knowledge_base(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
  let normalized_paths: Vec<PathBuf> = paths
    .iter()
    .map(|path| path.trim())
    .filter(|path| !path.is_empty())
    .map(PathBuf::from)
    .collect();

  if !normalized_paths.is_empty() {
    spawn_knowledge_index(app, normalized_paths);
  }

  Ok(())
}

// The actual logic, callable both from the direct Tauri command below and
// from the search_knowledge_base tool — one implementation, two entry points.
// Canonicalizes each configured secret path once, so document paths can be
// checked against them with a plain starts_with — same approach as
// resolve_within_knowledge_paths, kept separate since this filters a whole
// candidate list rather than validating one path.
fn canonical_secret_roots(secret_paths: &[String]) -> Vec<PathBuf> {
  secret_paths.iter().filter_map(|path| fs::canonicalize(path).ok()).collect()
}

fn is_under_secret_root(path: &Path, secret_roots: &[PathBuf]) -> bool {
  fs::canonicalize(path).map(|canonical| secret_roots.iter().any(|root| canonical.starts_with(root))).unwrap_or(false)
}

fn get_knowledge_context_impl(
  app: &tauri::AppHandle,
  query: String,
  paths: Vec<String>,
  is_cloud: bool,
  secret_paths: &[String],
) -> Result<String, String> {
  let normalized_paths: Vec<PathBuf> = paths
    .iter()
    .map(|path| path.trim())
    .filter(|path| !path.is_empty())
    .map(PathBuf::from)
    .collect();

  if normalized_paths.is_empty() {
    return Ok(String::new());
  }

  let state = app.state::<KnowledgeState>();

  let needs_first_scan = state
    .index
    .lock()
    .map(|index| index.manifest.known_paths != normalized_paths && !index.indexing)
    .unwrap_or(false);
  if needs_first_scan {
    spawn_knowledge_index(app.clone(), normalized_paths.clone());
  }

  let query_tokens = unique_tokens(&query);
  let cache_dir = state.cache_dir();
  // Only computed (and only costs anything) when actually talking to a cloud
  // model — a purely local conversation never pays for this check at all.
  let secret_roots = if is_cloud { canonical_secret_roots(secret_paths) } else { Vec::new() };

  let (top_doc_ids, documents_snapshot): (Vec<usize>, Vec<KnowledgeDocument>) = {
    let index = state.index.lock().map_err(|_| "Knowledge index unavailable".to_string())?;

    let excluded_doc_ids: HashSet<usize> = if secret_roots.is_empty() {
      HashSet::new()
    } else {
      index
        .manifest
        .documents
        .iter()
        .enumerate()
        .filter(|(_, document)| is_under_secret_root(&document.path, &secret_roots))
        .map(|(doc_id, _)| doc_id)
        .collect()
    };

    let mut scores: HashMap<usize, usize> = HashMap::new();
    if query_tokens.is_empty() {
      for doc_id in 0..index.manifest.documents.len() {
        if !excluded_doc_ids.contains(&doc_id) {
          scores.insert(doc_id, 0);
        }
      }
    } else {
      for token in &query_tokens {
        if let Some(doc_ids) = index.postings.get(token) {
          for &doc_id in doc_ids {
            if !excluded_doc_ids.contains(&doc_id) {
              *scores.entry(doc_id).or_insert(0) += 1;
            }
          }
        }
      }
    }

    let mut ranked: Vec<(usize, usize)> = scores.into_iter().collect();
    ranked.sort_by(|left, right| right.1.cmp(&left.1));

    let top_doc_ids = ranked
      .into_iter()
      .filter(|&(_, score)| score > 0 || query_tokens.is_empty())
      .take(4)
      .map(|(doc_id, _)| doc_id)
      .collect();

    (top_doc_ids, index.manifest.documents.clone())
  };

  let mut context_sections = Vec::new();
  for doc_id in top_doc_ids {
    let Some(document) = documents_snapshot.get(doc_id) else { continue };
    let Ok(content) = fs::read_to_string(cache_dir.join(&document.cache_file)) else { continue };
    let excerpt = build_excerpt(&content, &query_tokens);
    if !excerpt.is_empty() {
      context_sections.push(format!("Source: {}\n{}", document.path.display(), excerpt));
    }
  }

  Ok(context_sections.join("\n\n---\n\n"))
}

#[tauri::command]
fn get_knowledge_context(app: tauri::AppHandle, query: String, paths: Vec<String>, model: String, secret_paths: Vec<String>) -> Result<String, String> {
  get_knowledge_context_impl(&app, query, paths, is_cloud_model(&model), &secret_paths)
}

// --- Scheduled tasks ---------------------------------------------------------
// A task is "run this prompt every day at HH:MM". The scheduler loop (started
// in run(), see SCHEDULED_TASK_CHECK_INTERVAL_SECS) wakes up periodically,
// and for any task whose local hour/minute matches now and that hasn't
// already run today, executes it via run_ollama_conversation (request_id 0,
// nothing listening) and writes the result into the vault via save_note_impl
// — "write results into the vault" per the user's choice, no new
// notification plugin needed for this.
const SCHEDULED_TASK_MODEL: &str = "hermes3:8b";

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ScheduledTask {
  id: String,
  title: String,
  prompt: String,
  hour: u32,
  minute: u32,
  #[serde(default)]
  last_run_date: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct ScheduledTasksFile {
  tasks: Vec<ScheduledTask>,
}

struct TaskSchedulerState {
  tasks: Mutex<Vec<ScheduledTask>>,
  path: PathBuf,
}

impl TaskSchedulerState {
  fn load(path: PathBuf) -> Self {
    let tasks = fs::read_to_string(&path)
      .ok()
      .and_then(|raw| serde_json::from_str::<ScheduledTasksFile>(&raw).ok())
      .map(|file| file.tasks)
      .unwrap_or_default();
    TaskSchedulerState { tasks: Mutex::new(tasks), path }
  }

  fn save(&self) {
    let serialized = match self.tasks.lock() {
      Ok(tasks) => serde_json::to_string(&ScheduledTasksFile { tasks: tasks.clone() }).ok(),
      Err(_) => None,
    };
    if let Some(serialized) = serialized {
      if let Some(parent) = self.path.parent() {
        let _ = fs::create_dir_all(parent);
      }
      let _ = fs::write(&self.path, serialized);
    }
  }
}

fn schedule_daily_task_impl(state: &TaskSchedulerState, title: &str, prompt: &str, hour: u32, minute: u32) -> Result<String, String> {
  if hour > 23 || minute > 59 {
    return Err("hour must be 0-23 and minute must be 0-59.".to_string());
  }

  let task = ScheduledTask {
    id: format!("task-{}", chrono::Local::now().timestamp_millis()),
    title: title.to_string(),
    prompt: prompt.to_string(),
    hour,
    minute,
    last_run_date: None,
  };

  {
    let mut tasks = state.tasks.lock().map_err(|_| "Task scheduler unavailable".to_string())?;
    tasks.push(task);
  }
  state.save();

  Ok(format!("Scheduled \"{title}\" to run daily at {hour:02}:{minute:02}."))
}

fn list_scheduled_tasks_impl(state: &TaskSchedulerState) -> String {
  let tasks = match state.tasks.lock() {
    Ok(tasks) => tasks.clone(),
    Err(_) => return "Could not read scheduled tasks.".to_string(),
  };

  if tasks.is_empty() {
    return "No tasks are currently scheduled.".to_string();
  }

  tasks
    .iter()
    .map(|task| format!("- \"{}\" daily at {:02}:{:02} — {}", task.title, task.hour, task.minute, task.prompt))
    .collect::<Vec<_>>()
    .join("\n")
}

// Matched by title wording, the same way the to-do list's complete/remove
// tools match by label — the model doesn't see task ids, and there was
// previously no way at all to cancel a scheduled task once created, via
// chat or otherwise, short of hand-editing scheduled_tasks.json on disk.
fn cancel_scheduled_task_impl(state: &TaskSchedulerState, query: &str) -> String {
  let query_lower = query.trim().to_lowercase();
  if query_lower.is_empty() {
    return "Error: a task title is required.".to_string();
  }

  let removed_title = {
    let mut tasks = match state.tasks.lock() {
      Ok(tasks) => tasks,
      Err(_) => return "Could not access scheduled tasks.".to_string(),
    };
    let index = tasks
      .iter()
      .position(|task| task.title.to_lowercase() == query_lower)
      .or_else(|| tasks.iter().position(|task| task.title.to_lowercase().contains(&query_lower)));
    index.map(|index| tasks.remove(index).title)
  };

  match removed_title {
    Some(title) => {
      state.save();
      format!("Cancelled the scheduled task \"{title}\".")
    }
    None => format!("No scheduled task matching \"{query}\" was found."),
  }
}

// Direct, structured-data commands for the Daily tab's "Scheduled" card —
// until now, scheduled tasks were only visible/manageable by asking in chat,
// which is real friction for something meant to be seen at a glance.
#[tauri::command]
fn list_scheduled_tasks_direct(state: tauri::State<TaskSchedulerState>) -> Vec<ScheduledTask> {
  state.tasks.lock().map(|tasks| tasks.clone()).unwrap_or_default()
}

#[tauri::command]
fn cancel_scheduled_task_by_id(state: tauri::State<TaskSchedulerState>, id: String) -> Result<(), String> {
  let removed = {
    let mut tasks = state.tasks.lock().map_err(|_| "Could not access scheduled tasks.".to_string())?;
    let original_len = tasks.len();
    tasks.retain(|task| task.id != id);
    tasks.len() != original_len
  };
  if !removed {
    return Err("Scheduled task not found.".to_string());
  }
  state.save();
  Ok(())
}

// --- To-do list -----------------------------------------------------------
// Distinct from ScheduledTask above: this is a plain, persistent checklist
// (the Daily tab's "Tasks" card) that the user manages directly or by asking
// in chat — not a recurring prompt that gets run through the model.
#[derive(Debug, Serialize, Deserialize, Clone)]
struct TodoItem {
  id: String,
  label: String,
  done: bool,
  // Where a task came from ("Iris", "Goals", ...; empty = typed in directly)
  // and an optional detail line. Both default so task files saved before
  // these existed still load.
  #[serde(default)]
  source: String,
  #[serde(default)]
  note: String,
  // When it is for: "YYYY-MM-DD" for a day, "YYYY-MM-DDTHH:MM" (local time) for a
  // time on that day, None for a task with no day. Old files have none.
  #[serde(default)]
  when: Option<String>,
  // Part of town and cost, kept from the suggestion the task was made from.
  #[serde(default)]
  area: Option<String>,
  #[serde(default)]
  cost: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct TodoListFile {
  items: Vec<TodoItem>,
}

struct TodoState {
  items: Mutex<Vec<TodoItem>>,
  path: PathBuf,
}

impl TodoState {
  fn load(path: PathBuf) -> Self {
    let items = fs::read_to_string(&path)
      .ok()
      .and_then(|raw| serde_json::from_str::<TodoListFile>(&raw).ok())
      .map(|file| file.items)
      .unwrap_or_default();
    TodoState { items: Mutex::new(items), path }
  }

  fn save(&self) {
    let serialized = match self.items.lock() {
      Ok(items) => serde_json::to_string(&TodoListFile { items: items.clone() }).ok(),
      Err(_) => None,
    };
    if let Some(serialized) = serialized {
      if let Some(parent) = self.path.parent() {
        let _ = fs::create_dir_all(parent);
      }
      let _ = fs::write(&self.path, serialized);
    }
  }
}

fn add_todo_impl(state: &TodoState, label: &str) -> TodoItem {
  add_todo_with_details_impl(state, label, "", "")
}

// A day ("2026-09-22") or a local time on a day ("2026-09-22T14:00"), as the
// task form sends it, or a full timestamp; anything else is dropped rather than
// stored, so a bad value can't make a task vanish from the agenda.
fn clean_when(raw: &str) -> Option<String> {
  let text = raw.trim();
  let valid = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok()
    || chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M").is_ok()
    || chrono::DateTime::parse_from_rfc3339(text).is_ok();
  if valid {
    Some(text.to_string())
  } else {
    None
  }
}

fn add_todo_with_details_impl(state: &TodoState, label: &str, source: &str, note: &str) -> TodoItem {
  add_todo_full_impl(state, label, source, note, None, None, None)
}

// A short piece of text worth keeping, or nothing.
fn clean_place_or_cost(value: Option<&str>) -> Option<String> {
  value.map(str::trim).filter(|text| !text.is_empty()).map(|text| text.chars().take(60).collect())
}

fn add_todo_full_impl(state: &TodoState, label: &str, source: &str, note: &str, when: Option<&str>, area: Option<&str>, cost: Option<&str>) -> TodoItem {
  let item = TodoItem {
    id: format!("todo-{}", chrono::Local::now().timestamp_millis()),
    label: label.to_string(),
    done: false,
    source: source.trim().to_string(),
    note: note.trim().to_string(),
    when: when.and_then(clean_when),
    area: clean_place_or_cost(area),
    cost: clean_place_or_cost(cost),
  };
  {
    if let Ok(mut items) = state.items.lock() {
      items.push(item.clone());
    }
  }
  state.save();
  item
}

// The model doesn't know task ids, so tool-driven completion/removal matches
// by wording instead: an exact (case-insensitive) label match first, then
// falling back to the first substring match.
fn find_todo_index(items: &[TodoItem], query: &str) -> Option<usize> {
  let query_lower = query.trim().to_lowercase();
  if query_lower.is_empty() {
    return None;
  }
  items
    .iter()
    .position(|item| item.label.to_lowercase() == query_lower)
    .or_else(|| items.iter().position(|item| item.label.to_lowercase().contains(&query_lower)))
}

fn complete_todo_by_label_impl(state: &TodoState, query: &str, done: bool) -> String {
  let matched_label = {
    let mut items = match state.items.lock() {
      Ok(items) => items,
      Err(_) => return "Could not access the task list.".to_string(),
    };
    match find_todo_index(&items, query) {
      Some(index) => {
        items[index].done = done;
        Some(items[index].label.clone())
      }
      None => None,
    }
  };

  match matched_label {
    Some(label) => {
      state.save();
      if done { format!("Marked \"{label}\" as done.") } else { format!("Marked \"{label}\" as not done.") }
    }
    None => format!("No task matching \"{query}\" was found."),
  }
}

fn remove_todo_by_label_impl(state: &TodoState, query: &str) -> String {
  let removed_label = {
    let mut items = match state.items.lock() {
      Ok(items) => items,
      Err(_) => return "Could not access the task list.".to_string(),
    };
    match find_todo_index(&items, query) {
      Some(index) => Some(items.remove(index).label),
      None => None,
    }
  };

  match removed_label {
    Some(label) => {
      state.save();
      format!("Removed \"{label}\" from your tasks.")
    }
    None => format!("No task matching \"{query}\" was found."),
  }
}

fn list_todos_impl(state: &TodoState) -> String {
  let items = match state.items.lock() {
    Ok(items) => items.clone(),
    Err(_) => return "Could not access the task list.".to_string(),
  };
  if items.is_empty() {
    return "The task list is empty.".to_string();
  }
  items
    .iter()
    .map(|item| match &item.when {
      Some(when) => format!("- [{}] {} ({})", if item.done { "x" } else { " " }, item.label, when.replace('T', " ")),
      None => format!("- [{}] {}", if item.done { "x" } else { " " }, item.label),
    })
    .collect::<Vec<_>>()
    .join("\n")
}

#[tauri::command]
fn list_todos(app: tauri::AppHandle) -> Vec<TodoItem> {
  let state = app.state::<TodoState>();
  state.items.lock().map(|items| items.clone()).unwrap_or_default()
}

#[tauri::command]
fn add_todo(app: tauri::AppHandle, label: String, source: Option<String>, note: Option<String>, when: Option<String>, area: Option<String>, cost: Option<String>) -> TodoItem {
  let state = app.state::<TodoState>();
  add_todo_full_impl(&state, &label, source.as_deref().unwrap_or(""), note.as_deref().unwrap_or(""), when.as_deref(), area.as_deref(), cost.as_deref())
}

#[tauri::command]
fn set_todo_done(app: tauri::AppHandle, id: String, done: bool) -> Result<(), String> {
  let state = app.state::<TodoState>();
  let found = {
    let mut items = state.items.lock().map_err(|_| "Could not access the task list.".to_string())?;
    match items.iter_mut().find(|item| item.id == id) {
      Some(item) => {
        item.done = done;
        true
      }
      None => false,
    }
  };
  if !found {
    return Err("Task not found.".to_string());
  }
  state.save();
  Ok(())
}

#[tauri::command]
fn remove_todo(app: tauri::AppHandle, id: String) -> Result<(), String> {
  let state = app.state::<TodoState>();
  let removed = {
    let mut items = state.items.lock().map_err(|_| "Could not access the task list.".to_string())?;
    let original_len = items.len();
    items.retain(|item| item.id != id);
    items.len() != original_len
  };
  if !removed {
    return Err("Task not found.".to_string());
  }
  state.save();
  Ok(())
}

// --- Persistent user memory -------------------------------------------
// A small, append-only "what Artemis knows about you" file that grows as
// facts come up in conversation — the mechanism behind "learn more about me
// as time goes on". Capped to the most recent entries so it can't quietly
// balloon into a huge, ever-larger chunk of every request's context.
const USER_MEMORY_MAX_LINES: usize = 60;

fn user_memory_path(app: &tauri::AppHandle) -> PathBuf {
  app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("user_memory.md")
}

fn append_user_memory(app: &tauri::AppHandle, fact: &str) {
  let path = user_memory_path(app);
  if let Some(parent) = path.parent() {
    let _ = fs::create_dir_all(parent);
  }
  let line = format!("- [{}] {}\n", chrono::Local::now().format("%Y-%m-%d"), fact);
  if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
    let _ = file.write_all(line.as_bytes());
  }
}

fn read_user_memory(app: &tauri::AppHandle) -> String {
  let path = user_memory_path(app);
  let Ok(contents) = fs::read_to_string(&path) else { return String::new() };
  let lines: Vec<&str> = contents.lines().collect();
  let start = lines.len().saturating_sub(USER_MEMORY_MAX_LINES);
  lines[start..].join("\n")
}

#[tauri::command]
fn get_user_memory(app: tauri::AppHandle) -> String {
  read_user_memory(&app)
}

// --- Goals dashboard (Goals.md) -------------------------------------------
// The source file is a freeform personal sketchbook, not a clean checklist:
// repeated year headers (e.g. two separate "# 2032" blocks), sections with
// no bullets at all (e.g. "# Rhetoric / Writing" is bare paragraph lines),
// and one existing ~~strikethrough~~ marking a completed item. A parser that
// only recognized "- " bullets would silently drop the non-bulleted
// sections entirely — this one treats every non-header, non-empty line as
// an item, bullet or not, so nothing in the file goes missing from the view.
//
// Completion is tracked entirely in Artemis's own local storage, never by
// rewriting Goals.md — the vault's own standing rule is "ask before
// altering," and silently adding strikethrough markers to someone's
// personal sketchbook on every checkbox click would violate that.
const GOALS_DOC_PATH: &str = r"C:\Users\dccar\OneDrive\Documents\Ma'at\I. Sketchbook\Goals.md";

#[derive(Debug, Serialize, Clone)]
struct GoalItem {
  id: String,
  text: String,
  done: bool,
  sub_steps: Vec<GoalSubStep>,
}

#[derive(Debug, Serialize, Clone)]
struct GoalSection {
  title: String,
  level: u8,
  // Title of the nearest enclosing top-level ("# ") header — a year like
  // "2026", or a topic like "Arts". Kept separately because a year header
  // with no bullets of its own is dropped from the section list, yet its
  // sub-sections still belong to it.
  group: String,
  items: Vec<GoalItem>,
}

// A big, multi-year, or otherwise vague goal ("Law School", "10 Moth
// Stories") isn't meaningfully trackable as one yes/no checkbox — this is
// the concrete decomposition into smaller steps, generated on demand by the
// local model and cached so it's a one-time cost per goal, not regenerated
// on every view.
#[derive(Debug, Serialize, Deserialize, Clone)]
struct GoalSubStep {
  id: String,
  text: String,
  done: bool,
}

fn goals_completion_path(app: &tauri::AppHandle) -> PathBuf {
  app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("goals_completion.json")
}

fn goals_breakdowns_path(app: &tauri::AppHandle) -> PathBuf {
  app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("goals_breakdowns.json")
}

fn read_goals_breakdowns(app: &tauri::AppHandle) -> HashMap<String, Vec<GoalSubStep>> {
  fs::read_to_string(goals_breakdowns_path(app))
    .ok()
    .and_then(|raw| serde_json::from_str(&raw).ok())
    .unwrap_or_default()
}

fn write_goals_breakdowns(app: &tauri::AppHandle, breakdowns: &HashMap<String, Vec<GoalSubStep>>) -> Result<(), String> {
  let path = goals_breakdowns_path(app);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let serialized = serde_json::to_string(breakdowns).map_err(|error| error.to_string())?;
  fs::write(&path, serialized).map_err(|error| error.to_string())
}

fn read_goals_completion(app: &tauri::AppHandle) -> HashMap<String, bool> {
  fs::read_to_string(goals_completion_path(app))
    .ok()
    .and_then(|raw| serde_json::from_str::<HashMap<String, bool>>(&raw).ok())
    .unwrap_or_default()
}

#[tauri::command]
fn toggle_goal_item(app: tauri::AppHandle, id: String, done: bool) -> Result<(), String> {
  let mut completion = read_goals_completion(&app);
  completion.insert(id, done);
  let path = goals_completion_path(&app);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let serialized = serde_json::to_string(&completion).map_err(|error| error.to_string())?;
  fs::write(&path, serialized).map_err(|error| error.to_string())
}

fn strip_strikethrough(text: &str) -> (String, bool) {
  let trimmed = text.trim();
  if let Some(inner) = trimmed.strip_prefix("~~").and_then(|rest| rest.strip_suffix("~~")) {
    if !inner.is_empty() {
      return (inner.to_string(), true);
    }
  }
  (trimmed.to_string(), false)
}

fn clean_heading(text: &str) -> String {
  text.trim_matches(|character: char| character == '*' || character == '_').trim().to_string()
}

#[tauri::command]
fn get_goals(app: tauri::AppHandle) -> Result<Vec<GoalSection>, String> {
  #[cfg(target_os = "android")]
  {
    let _ = &app;
    return Err("Your goals live on your PC for now; they aren't synced to the phone yet.".to_string());
  }
  #[allow(unreachable_code)]
  let content = fs::read_to_string(GOALS_DOC_PATH).map_err(|error| format!("Could not read Goals.md: {error}"))?;
  let completion = read_goals_completion(&app);
  let breakdowns = read_goals_breakdowns(&app);

  let mut sections: Vec<GoalSection> = Vec::new();
  let mut current: Option<GoalSection> = None;
  let mut current_group = String::new();

  let push_item = |section: &mut GoalSection, raw: &str, completion: &HashMap<String, bool>, breakdowns: &HashMap<String, Vec<GoalSubStep>>| {
    let without_bullet = raw.strip_prefix("- ").unwrap_or(raw);
    let (text, originally_done) = strip_strikethrough(without_bullet);
    if text.is_empty() {
      return;
    }
    let id = stable_hash(&format!("{}\u{1}{}", section.title, text));
    let done = *completion.get(&id).unwrap_or(&originally_done);
    let sub_steps = breakdowns.get(&id).cloned().unwrap_or_default();
    section.items.push(GoalItem { id, text, done, sub_steps });
  };

  // Content before the first header — in this file, that's opening quotes
  // and philosophical notes, not goals at all (confirmed directly: they're
  // not actionable, don't belong in a checklist, and were explicitly wrong
  // to show as checkable items). Simply not collected into any section.
  for line in content.lines() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }

    let header = ["#### ", "### ", "## ", "# "].iter().enumerate().find_map(|(index, prefix)| {
      trimmed.strip_prefix(prefix).map(|rest| (4 - index as u8, rest))
    });

    if let Some((level, rest)) = header {
      if let Some(section) = current.take() {
        if !section.items.is_empty() {
          sections.push(section);
        }
      }
      let title = clean_heading(rest);
      if level == 1 {
        current_group = title.clone();
      }
      current = Some(GoalSection { title, level, group: current_group.clone(), items: Vec::new() });
    } else if let Some(section) = current.as_mut() {
      push_item(section, trimmed, &completion, &breakdowns);
    }
  }
  if let Some(section) = current.take() {
    if !section.items.is_empty() {
      sections.push(section);
    }
  }

  // The file opens with the big undated, ten-year projects ("Rhetoric /
  // Writing": 100 speeches, 10 epic poems, ...). Those aren't what a working
  // list is for, so this year's goals lead and the long-horizon topics go last.
  // The sort is stable and only ranks whole groups, so the file's own order is
  // kept everywhere else, including inside each group.
  let current_year = {
    use chrono::Datelike;
    chrono::Local::now().year()
  };
  sections.sort_by_key(|section| goal_group_rank(&section.group, current_year));

  Ok(sections)
}

// 0 = this year, 1 = any other dated year, 2 = an undated long-horizon topic.
// A year group is one whose title starts with four digits ("2026", "2035 (50)").
fn goal_group_rank(group: &str, current_year: i32) -> u8 {
  let digits: String = group.chars().take_while(|character| character.is_ascii_digit()).collect();
  match digits.parse::<i32>() {
    Ok(year) if digits.len() == 4 => {
      if year == current_year {
        0
      } else {
        1
      }
    }
    _ => 2,
  }
}

// A big, vague, multi-year goal ("Law School", "10 Moth Stories") isn't
// meaningfully trackable as a single checkbox — this generates a concrete
// breakdown via the local model, on demand and cached, rather than trying
// to algorithmically guess which goals are "big" up front.
async fn generate_goal_breakdown(goal_text: &str) -> Result<Vec<String>, String> {
  let prompt = format!(
    "Break this long-term personal goal into 3 to 6 concrete, ordered, actionable steps a person could actually start on. Goal: \"{goal_text}\"\n\nRespond with ONLY a JSON array of short strings, nothing else — no markdown, no explanation. Example: [\"Research options\", \"Make a shortlist\", \"Take the first concrete step\"]"
  );
  let body = serde_json::json!({
    "model": SCHEDULED_TASK_MODEL,
    "messages": [{ "role": "user", "content": prompt }],
    "stream": false,
    "options": { "temperature": 0.4, "num_predict": 400 }
  });

  let client = http_client();
  let response = client
    .post("http://localhost:11434/api/chat")
    .json(&body)
    .send()
    .await
    .map_err(|error| format!("Could not reach the local model: {error}"))?;
  if !response.status().is_success() {
    return Err(format!("Local model returned HTTP {}.", response.status()));
  }
  let parsed: OllamaChatResponse = response.json().await.map_err(|error| format!("Could not parse the model's response: {error}"))?;
  let content = parsed.message.map(|message| message.content).unwrap_or_default();
  let content = content.trim();

  // Defensive, tiered parsing — local uncensored models aren't reliably
  // fine-tuned for strict JSON output, so this doesn't just trust the first
  // attempt to succeed.
  if let Ok(steps) = serde_json::from_str::<Vec<String>>(content) {
    if !steps.is_empty() {
      return Ok(steps);
    }
  }
  if let (Some(start), Some(end)) = (content.find('['), content.rfind(']')) {
    if end > start {
      if let Ok(steps) = serde_json::from_str::<Vec<String>>(&content[start..=end]) {
        if !steps.is_empty() {
          return Ok(steps);
        }
      }
    }
  }
  // Last resort: treat non-empty lines as steps, stripping common list
  // markers, rather than failing outright on a model that ignored the
  // JSON-only instruction.
  let fallback: Vec<String> = content
    .lines()
    .map(|line| line.trim().trim_start_matches(|c: char| c == '-' || c == '*' || c.is_ascii_digit() || c == '.' || c == ')').trim())
    .filter(|line| !line.is_empty())
    .take(8)
    .map(str::to_string)
    .collect();
  if fallback.is_empty() {
    Err("The model didn't return a usable breakdown.".to_string())
  } else {
    Ok(fallback)
  }
}

#[tauri::command]
async fn break_down_goal(app: tauri::AppHandle, section_title: String, item_id: String, item_text: String) -> Result<Vec<GoalSubStep>, String> {
  let mut breakdowns = read_goals_breakdowns(&app);
  if let Some(existing) = breakdowns.get(&item_id) {
    if !existing.is_empty() {
      return Ok(existing.clone());
    }
  }

  let steps = generate_goal_breakdown(&item_text).await?;
  let sub_steps: Vec<GoalSubStep> = steps
    .into_iter()
    .map(|text| GoalSubStep { id: stable_hash(&format!("{section_title}\u{1}{item_id}\u{1}{text}")), text, done: false })
    .collect();

  breakdowns.insert(item_id, sub_steps.clone());
  write_goals_breakdowns(&app, &breakdowns)?;
  Ok(sub_steps)
}

#[tauri::command]
fn toggle_goal_substep(app: tauri::AppHandle, item_id: String, sub_step_id: String, done: bool) -> Result<(), String> {
  let mut breakdowns = read_goals_breakdowns(&app);
  let Some(sub_steps) = breakdowns.get_mut(&item_id) else {
    return Err("No breakdown found for this goal.".to_string());
  };
  let Some(step) = sub_steps.iter_mut().find(|step| step.id == sub_step_id) else {
    return Err("Sub-step not found.".to_string());
  };
  step.done = done;
  write_goals_breakdowns(&app, &breakdowns)
}

// --- Website/server health check ---------------------------------------
// A plain reachability + latency check — deliberately not extended to SSL
// certificate expiry or disk space in this pass, since those need lower-level
// TLS APIs or local-machine-specific checks that are a separate, bigger
// piece of work. This alone is already enough to unlock "check my site every
// morning and tell me if it's down" via the existing schedule_daily_task
// tool — no separate scheduling system needed for that.
async fn check_website_health_impl(url: &str) -> String {
  let normalized = if url.starts_with("http://") || url.starts_with("https://") {
    url.to_string()
  } else {
    format!("https://{url}")
  };

  let client = http_client();
  let start = std::time::Instant::now();
  match client.get(&normalized).send().await {
    Ok(response) => {
      let elapsed_ms = start.elapsed().as_millis();
      let status = response.status();
      if status.is_success() {
        format!("{normalized} is up — HTTP {} in {elapsed_ms}ms.", status.as_u16())
      } else {
        format!("{normalized} responded with HTTP {} in {elapsed_ms}ms — may need attention.", status.as_u16())
      }
    }
    Err(error) => format!("{normalized} is unreachable: {error}"),
  }
}

// --- Hermes Agent delegation ----------------------------------------------
// Hermes Agent is a separate, already-installed local agent framework with
// its own tools and live plugins (WhatsApp, Mattermost, iMessage, Home
// Assistant, browser, shell) and its own permission model — confirmed
// empirically (not assumed) that its one-shot mode (`hermes -z`) executes
// shell commands autonomously with no interactive prompt and no channel for
// Artemis to intercept or answer a mid-run approval request. Delegating to
// it is therefore a fundamentally different trust boundary than any other
// tool in this file, not just "one more integration" — every call goes
// through the same confirmation gate as other high-trust actions, and the
// confirmation text says plainly what's being crossed into.
// This installed version has no --timeout flag at all (confirmed against its
// real --help output, not assumed from the integration brief that described
// it — that flag simply doesn't exist 216 commits back). So this bounds only
// how long Artemis waits, via the outer tokio::time::timeout below; if
// Hermes itself doesn't finish in time, the underlying process may keep
// running detached rather than being force-killed — an accepted, disclosed
// trade-off rather than a silent one.
const HERMES_DEFAULT_TIMEOUT_SECS: u64 = 120;

fn hermes_home_dir() -> PathBuf {
  std::env::var("LOCALAPPDATA")
    .map(|local_app_data| PathBuf::from(local_app_data).join("hermes"))
    .unwrap_or_else(|_| PathBuf::from(r"C:\hermes"))
}

fn hermes_exe_path() -> PathBuf {
  hermes_home_dir().join("bin").join("hermes.exe")
}

// Never pass Artemis's full environment through to the child process — it
// may carry unrelated secrets (cloud API keys, other apps' tokens) Hermes
// has no reason to see. Pass only what a Windows console app needs to
// resolve paths and find its own home directory, read from Artemis's own
// environment at call time rather than hardcoded, so this isn't tied to one
// specific username.
// Builds a hermes.exe invocation with a fully cleared, explicitly
// allowlisted environment — shared by every hermes subprocess call in this
// file so the isolation logic exists exactly once.
fn hermes_command() -> std::process::Command {
  let home_dir = hermes_home_dir();
  let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
  let user_profile = std::env::var("USERPROFILE").unwrap_or_default();
  let app_data = std::env::var("APPDATA").unwrap_or_default();
  let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
  let temp = std::env::var("TEMP").unwrap_or_else(|_| format!("{system_root}\\Temp"));
  let path_value = format!("{}\\bin;{system_root}\\system32;{system_root}", home_dir.display());

  let mut command = std::process::Command::new(hermes_exe_path());
  command
    .env_clear()
    .env("PATH", path_value)
    .env("HERMES_HOME", &home_dir)
    .env("USERPROFILE", user_profile)
    .env("APPDATA", app_data)
    .env("LOCALAPPDATA", local_app_data)
    .env("TEMP", &temp)
    .env("TMP", temp)
    .env("SystemRoot", &system_root)
    .env("ComSpec", format!("{system_root}\\system32\\cmd.exe"))
    .stdin(std::process::Stdio::null());
  command
}

async fn call_hermes_agent_impl(prompt: &str, toolsets: &str) -> String {
  if !hermes_exe_path().exists() {
    return "Hermes Agent isn't installed on this machine.".to_string();
  }

  let prompt = prompt.to_string();
  let toolsets = toolsets.trim().to_string();

  let output_future = tauri::async_runtime::spawn_blocking(move || {
    let mut command = hermes_command();
    command.arg("-z").arg(&prompt);
    if !toolsets.is_empty() {
      command.arg("-t").arg(&toolsets);
    }
    command.output()
  });

  match tokio::time::timeout(std::time::Duration::from_secs(HERMES_DEFAULT_TIMEOUT_SECS + 15), output_future).await {
    Ok(Ok(Ok(output))) if output.status.success() => String::from_utf8_lossy(&output.stdout).trim().to_string(),
    Ok(Ok(Ok(output))) => format!("Hermes Agent exited with an error: {}", String::from_utf8_lossy(&output.stderr).trim()),
    Ok(Ok(Err(error))) => format!("Could not run Hermes Agent: {error}"),
    Ok(Err(_)) => "Hermes Agent task failed unexpectedly.".to_string(),
    Err(_) => format!("Hermes Agent did not finish within {HERMES_DEFAULT_TIMEOUT_SECS}s and was abandoned."),
  }
}

// --- Iris Knowledge Base (Hermes' local, read-only SQLite FTS5 index) ----
// Contract: IRIS_SERVER_ACCESS.md (repo root). Iris (Hermes) owns indexing —
// this only ever spawns the stable kb_search.py CLI with plain argv (never a
// shell, so no arg here can be interpreted as shell syntax regardless of what
// the model puts in a query string) and reads its JSON stdout. No credentials
// exist on this path for Claude or Artemis to hold: the CLI needs none. Never
// write to library.db from here — Iris's own build_index.py/build_notes.py/
// build_code.py are the only writers.
const KB_PYTHON: &str = r"C:\Users\dccar\HermesKB\venv\Scripts\python.exe";
const KB_SCRIPT: &str = r"C:\Users\dccar\HermesKB\kb_search.py";
const KB_TIMEOUT_SECS: u64 = 20;

fn kb_available() -> bool {
  Path::new(KB_PYTHON).exists() && Path::new(KB_SCRIPT).exists()
}

// Same env-clear-then-allowlist isolation as hermes_command() above, for the
// same reason: don't hand this child process Artemis's full environment (it
// may carry unrelated secrets), just what a venv python.exe needs on Windows
// to resolve its own DLLs and temp/user paths.
fn kb_command() -> std::process::Command {
  let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
  let user_profile = std::env::var("USERPROFILE").unwrap_or_default();
  let app_data = std::env::var("APPDATA").unwrap_or_default();
  let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
  let temp = std::env::var("TEMP").unwrap_or_else(|_| format!("{system_root}\\Temp"));
  let path_value = format!("{system_root}\\system32;{system_root}");

  let mut command = std::process::Command::new(KB_PYTHON);
  command
    .arg(KB_SCRIPT)
    .env_clear()
    .env("PATH", path_value)
    .env("USERPROFILE", user_profile)
    .env("APPDATA", app_data)
    .env("LOCALAPPDATA", local_app_data)
    .env("TEMP", &temp)
    .env("TMP", temp)
    .env("SystemRoot", &system_root)
    .env("ComSpec", format!("{system_root}\\system32\\cmd.exe"))
    .stdin(std::process::Stdio::null());
  command
}

async fn run_kb_command(args: Vec<String>) -> Result<String, String> {
  if !kb_available() {
    return Err("Iris's knowledge base isn't available on this machine.".to_string());
  }

  let output_future = tauri::async_runtime::spawn_blocking(move || {
    let mut command = kb_command();
    command.args(&args);
    command.output()
  });

  match tokio::time::timeout(std::time::Duration::from_secs(KB_TIMEOUT_SECS), output_future).await {
    Ok(Ok(Ok(output))) if output.status.success() => Ok(String::from_utf8_lossy(&output.stdout).trim().to_string()),
    Ok(Ok(Ok(output))) => Err(format!("Knowledge base query failed: {}", String::from_utf8_lossy(&output.stderr).trim())),
    Ok(Ok(Err(error))) => Err(format!("Could not run the knowledge base query: {error}")),
    Ok(Err(_)) => Err("Knowledge base query task failed unexpectedly.".to_string()),
    Err(_) => Err(format!("Knowledge base query did not finish within {KB_TIMEOUT_SECS}s and was abandoned.")),
  }
}

// query_iris_knowledge's results carry a "path" per hit (the contract's
// documented JSON shape). When a cloud model is answering, drop any hit whose
// path falls under a user-configured Secret folder before it ever reaches the
// conversation — the same guarantee get_knowledge_context_impl already
// enforces for Artemis's own local index, extended to this second path into
// the same Obsidian vault. Local models never had this restriction and still
// don't. Fails open only if a hit's path can no longer be canonicalized (e.g.
// the file moved) — identical failure mode to is_under_secret_root's existing
// callers, not a new weaker guarantee introduced here.
fn filter_kb_search_json(raw: &str, is_cloud: bool, secret_paths: &[String]) -> String {
  if !is_cloud || secret_paths.is_empty() {
    return raw.to_string();
  }
  let Ok(mut value) = serde_json::from_str::<serde_json::Value>(raw) else {
    return raw.to_string();
  };
  let secret_roots = canonical_secret_roots(secret_paths);
  if secret_roots.is_empty() {
    return raw.to_string();
  }
  if let Some(results) = value.get_mut("results").and_then(|results| results.as_array_mut()) {
    results.retain(|result| {
      result
        .get("path")
        .and_then(|path| path.as_str())
        .map(|path| !is_under_secret_root(Path::new(path), &secret_roots))
        .unwrap_or(true)
    });
  }
  serde_json::to_string(&value).unwrap_or_else(|_| raw.to_string())
}

async fn query_iris_knowledge_impl(query: &str, corpus: &str, n: u32, is_cloud: bool, secret_paths: &[String]) -> String {
  if query.trim().is_empty() {
    return "Error: a search query is required.".to_string();
  }
  let mut args = vec!["search".to_string(), query.trim().to_string()];
  let corpus_lower = corpus.trim().to_lowercase();
  if corpus_lower == "books" || corpus_lower == "notes" {
    args.push("--corpus".to_string());
    args.push(corpus_lower);
  }
  let n = if n == 0 { 5 } else { n.min(20) };
  args.push("--n".to_string());
  args.push(n.to_string());

  match run_kb_command(args).await {
    Ok(raw) if raw.is_empty() => "No results found in Iris's knowledge base.".to_string(),
    Ok(raw) => filter_kb_search_json(&raw, is_cloud, secret_paths),
    Err(error) => error,
  }
}

async fn get_iris_book_page_impl(doc_id: &str, page: u32) -> String {
  if doc_id.trim().is_empty() {
    return "Error: a doc_id is required (from a prior query_iris_knowledge search result).".to_string();
  }
  match run_kb_command(vec!["get".to_string(), doc_id.trim().to_string(), page.to_string()]).await {
    Ok(raw) if raw.is_empty() => "No page content returned.".to_string(),
    Ok(raw) => raw,
    Err(error) => error,
  }
}

async fn search_iris_code_impl(query: &str, project: &str) -> String {
  if query.trim().is_empty() {
    return "Error: a search query is required.".to_string();
  }
  let mut args = vec!["code".to_string(), query.trim().to_string()];
  if !project.trim().is_empty() {
    args.push("--proj".to_string());
    args.push(project.trim().to_string());
  }
  match run_kb_command(args).await {
    Ok(raw) if raw.is_empty() => "No matching source files found.".to_string(),
    Ok(raw) => raw,
    Err(error) => error,
  }
}

async fn get_iris_note_impl(name: &str) -> String {
  if name.trim().is_empty() {
    return "Error: a note name or substring is required.".to_string();
  }
  match run_kb_command(vec!["note".to_string(), name.trim().to_string()]).await {
    Ok(raw) if raw.is_empty() => "No matching note found.".to_string(),
    Ok(raw) => raw,
    Err(error) => error,
  }
}

// --- Iris Feed (Iris/Hermes -> Artemis one-way content channel) ----------
// Deliberately the simplest possible integration: Iris (the user's Hermes
// Agent) writes markdown + a JSON index to this folder on its own schedule;
// Artemis only ever reads it. No network call, no auth, no coupling to
// whether Hermes is even running — matches iris-feed/README.md's contract
// exactly. Artemis never writes or deletes anything in this folder; Iris
// owns its own rotation.
const IRIS_FEED_DIR: &str = r"C:\Users\dccar\OneDrive\Desktop\Projects\Artemis\iris-feed";

// Debug builds can point at a scratch folder (ARTEMIS_IRIS_FEED_DIR) so the
// panel can be exercised against sample cards without touching Iris's real
// latest.json. Release builds always read the real folder.
fn iris_feed_dir() -> PathBuf {
  // The phone has no such folder: its copy of Iris's files (kept by phone_feed.rs) lives in
  // the app's own storage, set once at startup.
  #[cfg(target_os = "android")]
  if let Some(dir) = ANDROID_FEED_DIR.get() {
    return dir.clone();
  }
  #[cfg(debug_assertions)]
  if let Ok(dir) = std::env::var("ARTEMIS_IRIS_FEED_DIR") {
    if !dir.trim().is_empty() {
      return PathBuf::from(dir);
    }
  }
  PathBuf::from(IRIS_FEED_DIR)
}

#[cfg(target_os = "android")]
static ANDROID_FEED_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

// Phone only: brings Iris's feed over the gateway (Tailscale) into the phone's copy, and
// sends up what was ticked off since last time. On the computer Artemis reads Iris's real
// folder, which it must never write to, so there this refuses.
#[tauri::command]
async fn sync_iris_feed(app_handle: tauri::AppHandle) -> Result<phone_feed::Synced, String> {
  if !cfg!(target_os = "android") {
    return Err("Feed sync is for the phone; on this computer Artemis reads Iris's folder directly.".to_string());
  }
  let Some(config) = read_hermes_gateway_config(&app_handle) else {
    return Err("Add Iris's gateway in Settings (its address on your Tailscale network, and its key) and her feed will follow.".to_string());
  };
  if !phone_address_allowed(&config.base_url) {
    return Err("The phone only talks to Iris over Tailscale. The gateway address has to look like http://100.x.x.x:8642 or end in .ts.net.".to_string());
  }
  phone_feed::sync_with(http_client(), &config.base_url, &config.key, &iris_feed_dir()).await
}

#[derive(Debug, Deserialize, Default)]
struct IrisFeedSuggestionRaw {
  text: Option<String>,
  #[serde(default)]
  needs_answer: bool,
}

// One card of the Tasks panel, exactly as Iris writes it (iris-feed/TASKS-CONTRACT.md).
// Every field defaults so a card with a field missing or null still parses.
#[derive(Debug, Deserialize, Serialize, Clone, Default)]
struct IrisTaskCard {
  #[serde(default)]
  id: String,
  #[serde(default)]
  title: String,
  #[serde(default)]
  detail: String,
  #[serde(default)]
  source: String,
  #[serde(default)]
  category: String,
  // Part of town ("Decatur") and cost ("Free", "$12"); null when Iris doesn't know.
  #[serde(default)]
  area: Option<String>,
  #[serde(default)]
  cost: Option<String>,
  #[serde(default)]
  when: Option<String>,
  #[serde(default)]
  link: Option<String>,
  #[serde(default)]
  goal_id: Option<String>,
  #[serde(default)]
  action: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
struct IrisTasks {
  #[serde(default)]
  updated: String,
  #[serde(default)]
  next: Vec<IrisTaskCard>,
  #[serde(default)]
  suggested: Vec<IrisTaskCard>,
}

// One insight from the weekly review, fused: what changed, what to do about it,
// and the task that "Add to tasks" creates (iris-feed/TASKS-CONTRACT.md).
#[derive(Debug, Serialize, Clone, Default, PartialEq)]
struct IrisInsightTask {
  title: String,
  category: String,
  when: Option<String>,
}

#[derive(Debug, Serialize, Clone, Default, PartialEq)]
struct IrisInsight {
  id: String,
  observation: String,
  action: String,
  task: Option<IrisInsightTask>,
  // drift | opportunity | decision
  kind: String,
  priority: i64,
}

// A week's worth is a handful; more than this is Iris ignoring her own limits.
const MAX_INSIGHTS: usize = 8;

fn insight_text(value: &serde_json::Value, key: &str) -> String {
  value.get(key).and_then(|field| field.as_str()).unwrap_or("").trim().to_string()
}

// Read leniently, by hand: Iris writes this file, and one entry with a wrong
// type (a priority written as "1", a task set to null) must cost that entry,
// never the whole Daily feed. An entry with no action has nothing to show.
fn parse_insights(raw: &serde_json::Value) -> Vec<IrisInsight> {
  let Some(list) = raw.as_array() else {
    return Vec::new();
  };
  let mut insights: Vec<IrisInsight> = list
    .iter()
    .filter_map(|entry| {
      let action = insight_text(entry, "action");
      if action.is_empty() {
        return None;
      }
      let task = entry.get("task").filter(|task| task.is_object()).map(|task| IrisInsightTask {
        title: insight_text(task, "title"),
        category: insight_text(task, "category"),
        when: Some(insight_text(task, "when")).filter(|when| !when.is_empty()),
      });
      let priority = entry
        .get("priority")
        .and_then(|number| number.as_i64().or_else(|| number.as_f64().map(|float| float as i64)).or_else(|| number.as_str().and_then(|text| text.trim().parse().ok())))
        .unwrap_or(99);
      Some(IrisInsight { id: insight_text(entry, "id"), observation: insight_text(entry, "observation"), action, task, kind: insight_text(entry, "kind").to_lowercase(), priority })
    })
    .collect();
  insights.sort_by_key(|insight| insight.priority);
  insights.truncate(MAX_INSIGHTS);
  insights
}

#[derive(Debug, Deserialize)]
struct IrisFeedIndex {
  updated: String,
  brief: Option<String>,
  events: Option<String>,
  review: Option<String>,
  spark: Option<String>,
  #[serde(default)]
  suggestion: IrisFeedSuggestionRaw,
  #[serde(default)]
  tasks: IrisTasks,
  // Kept as raw JSON and read by parse_insights.
  #[serde(default)]
  insights: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
struct IrisFeedSection {
  heading: String,
  content: String,
}

#[derive(Debug, Serialize, Default)]
struct IrisFeedContent {
  updated: String,
  brief_sections: Vec<IrisFeedSection>,
  events_sections: Vec<IrisFeedSection>,
  review_sections: Vec<IrisFeedSection>,
  spark_text: String,
  suggestion_text: Option<String>,
  suggestion_needs_answer: bool,
  tasks: IrisTasks,
  insights: Vec<IrisInsight>,
}

// A card with no id or no title can't be shown or acted on; more than a screenful
// is Iris ignoring her own limits (5 Next, 6 Suggested), so the panel stays a
// shortlist regardless.
const MAX_FEED_CARDS: usize = 12;

fn usable_cards(cards: Vec<IrisTaskCard>) -> Vec<IrisTaskCard> {
  cards.into_iter().filter(|card| !card.id.trim().is_empty() && !card.title.trim().is_empty()).take(MAX_FEED_CARDS).collect()
}

// Generic by design — doesn't hardcode which headings a given document
// type uses (the brief, events, and weekly review each have their own set
// per the README), just splits on any "## " boundary. Content before the
// first heading (e.g. a "# Title" line) isn't part of any section, matching
// how these files are actually structured.
fn parse_markdown_sections(content: &str) -> Vec<IrisFeedSection> {
  let mut sections = Vec::new();
  let mut current_heading: Option<String> = None;
  let mut current_body = String::new();

  for line in content.lines() {
    if let Some(heading) = line.trim().strip_prefix("## ") {
      if let Some(previous_heading) = current_heading.take() {
        sections.push(IrisFeedSection { heading: previous_heading, content: current_body.trim().to_string() });
      }
      current_heading = Some(heading.trim().to_string());
      current_body = String::new();
    } else if current_heading.is_some() {
      current_body.push_str(line);
      current_body.push('\n');
    }
  }
  if let Some(heading) = current_heading {
    sections.push(IrisFeedSection { heading, content: current_body.trim().to_string() });
  }
  sections
}

fn read_feed_file(filename: &str) -> String {
  fs::read_to_string(iris_feed_dir().join(filename)).unwrap_or_default()
}

#[tauri::command]
fn get_iris_feed() -> Result<IrisFeedContent, String> {
  let index_path = iris_feed_dir().join("latest.json");
  let index_raw = match fs::read_to_string(&index_path) {
    Ok(raw) => raw,
    // Not configured/started yet is a normal, expected state, not an error
    // the UI needs to display as a failure.
    Err(_) => return Ok(IrisFeedContent::default()),
  };
  let index: IrisFeedIndex = serde_json::from_str(&index_raw).map_err(|error| format!("Could not parse Iris feed index: {error}"))?;

  // "Today's Suggestion" is excluded from the generic brief sections here —
  // it gets its own interactive yes/no rendering on the frontend instead of
  // being shown as a plain text block twice.
  let brief_sections: Vec<IrisFeedSection> = index
    .brief
    .as_deref()
    .map(|filename| parse_markdown_sections(&read_feed_file(filename)))
    .unwrap_or_default()
    .into_iter()
    .filter(|section| !section.heading.eq_ignore_ascii_case("Today's Suggestion"))
    .collect();

  let events_sections = index.events.as_deref().map(|filename| parse_markdown_sections(&read_feed_file(filename))).unwrap_or_default();
  let review_sections = index.review.as_deref().map(|filename| parse_markdown_sections(&read_feed_file(filename))).unwrap_or_default();
  let spark_text = index.spark.as_deref().map(read_feed_file).unwrap_or_default().trim().to_string();

  Ok(IrisFeedContent {
    updated: index.updated,
    brief_sections,
    events_sections,
    review_sections,
    spark_text,
    suggestion_text: index.suggestion.text,
    suggestion_needs_answer: index.suggestion.needs_answer,
    tasks: IrisTasks { updated: index.tasks.updated, next: usable_cards(index.tasks.next), suggested: usable_cards(index.tasks.suggested) },
    insights: parse_insights(&index.insights),
  })
}

// A deliberately un-gated direct action, not a chat tool: the user already
// made the decision by tapping Yes/No on a suggestion they read in full —
// routing it through the same confirmation dialog as a model-initiated
// Hermes delegation would just be redundant friction on a choice already
// made. Still fully audit-logged like everything else.
#[tauri::command]
async fn respond_to_iris_suggestion(app_handle: tauri::AppHandle, suggestion_text: String, answer: String) -> Result<String, String> {
  append_audit_log(&app_handle, 0, "iris_suggestion_response", &format!("answer={answer} suggestion={suggestion_text}"));
  let prompt = format!("Regarding your suggestion: \"{suggestion_text}\" — the user's answer is: {answer}.");
  Ok(call_hermes_agent_impl(&prompt, "").await)
}

// --- Weekly goals (Iris-owned) --------------------------------------------
// HermesKB\weekly-goals.json holds the goals with a per-week target ("dance
// twice a week") and the dates each one was done. Iris is its only writer;
// Artemis reads it for the Daily ring and for the chat, and changes to it go
// through Iris (the update_goals tool below). The file's exact shape is Iris's
// to settle, so the reader accepts the obvious variants: an array or an object
// with a "goals" list, "target_count" or "target", and "completions" as a list
// of dates (or objects with a date) or a plain count for this week.
const WEEKLY_GOALS_PATH: &str = r"C:\Users\dccar\HermesKB\weekly-goals.json";

// Debug builds can point at a scratch file (ARTEMIS_WEEKLY_GOALS_PATH) so the
// ring can be exercised without touching Iris's real one.
fn weekly_goals_path() -> PathBuf {
  // On the phone Iris serves this file with the rest of her feed.
  if cfg!(target_os = "android") {
    return iris_feed_dir().join("weekly-goals.json");
  }
  #[cfg(debug_assertions)]
  if let Ok(path) = std::env::var("ARTEMIS_WEEKLY_GOALS_PATH") {
    if !path.trim().is_empty() {
      return PathBuf::from(path);
    }
  }
  PathBuf::from(WEEKLY_GOALS_PATH)
}

#[derive(Debug, Serialize, Clone, PartialEq)]
struct WeeklyGoal {
  id: String,
  title: String,
  category: String,
  target: u32,
  done: u32,
  // The same goal over the calendar month: reps logged this month against the
  // weekly target scaled to the month's length.
  month_target: u32,
  month_done: u32,
}

#[derive(Debug, Serialize, Default, PartialEq)]
struct WeeklyGoals {
  // False until Iris has created the file: the Daily tab then explains how to
  // start one instead of showing an empty ring.
  exists: bool,
  updated: String,
  week_start: String,
  week_end: String,
  month_start: String,
  month_end: String,
  goals: Vec<WeeklyGoal>,
}

fn json_text(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
  keys.iter().find_map(|key| value.get(*key).and_then(|found| found.as_str())).map(|text| text.trim().to_string()).filter(|text| !text.is_empty())
}

fn json_count(value: &serde_json::Value, keys: &[&str]) -> Option<u32> {
  let found = keys.iter().find_map(|key| value.get(*key))?;
  let number = found
    .as_u64()
    .or_else(|| found.as_f64().filter(|float| *float >= 0.0).map(|float| float as u64))
    .or_else(|| found.as_str().and_then(|text| text.trim().split(|c: char| !c.is_ascii_digit()).next().and_then(|digits| digits.parse().ok())))?;
  Some(number.min(1000) as u32)
}

fn completion_date(item: &serde_json::Value) -> Option<chrono::NaiveDate> {
  let text = match item {
    serde_json::Value::String(text) => text.as_str(),
    serde_json::Value::Object(_) => ["date", "at", "when", "completed_at"].iter().find_map(|key| item.get(*key).and_then(|found| found.as_str()))?,
    _ => return None,
  };
  chrono::NaiveDate::parse_from_str(text.get(..10)?, "%Y-%m-%d").ok()
}

// Completions dated inside [from, to]. A plain running count has no dates, so
// it is taken as-is for whatever range is asked about.
fn completions_in(goal: &serde_json::Value, from: chrono::NaiveDate, to: chrono::NaiveDate) -> u32 {
  for key in ["completions", "completed", "done_dates", "dates", "log"] {
    match goal.get(key) {
      Some(serde_json::Value::Array(items)) => {
        return items.iter().filter(|item| completion_date(item).map_or(false, |date| date >= from && date <= to)).count() as u32;
      }
      Some(serde_json::Value::Number(count)) => return count.as_u64().unwrap_or(0).min(1000) as u32,
      _ => {}
    }
  }
  0
}

fn slugify(text: &str) -> String {
  let mut slug = String::new();
  for character in text.to_lowercase().chars() {
    if character.is_ascii_alphanumeric() {
      slug.push(character);
    } else if !slug.ends_with('-') && !slug.is_empty() {
      slug.push('-');
    }
  }
  slug.trim_end_matches('-').to_string()
}

// The calendar week (Monday to Sunday) the given day falls in.
fn calendar_week(today: chrono::NaiveDate) -> (chrono::NaiveDate, chrono::NaiveDate) {
  use chrono::Datelike;
  let start = today - chrono::Duration::days(today.weekday().num_days_from_monday() as i64);
  (start, start + chrono::Duration::days(6))
}

// First and last day of the calendar month the given day falls in.
fn calendar_month(today: chrono::NaiveDate) -> (chrono::NaiveDate, chrono::NaiveDate) {
  use chrono::Datelike;
  let start = today.with_day(1).unwrap_or(today);
  let (year, month) = if today.month() == 12 { (today.year() + 1, 1) } else { (today.year(), today.month() + 1) };
  let next_start = chrono::NaiveDate::from_ymd_opt(year, month, 1).unwrap_or(start + chrono::Duration::days(31));
  (start, next_start - chrono::Duration::days(1))
}

fn parse_weekly_goals(raw: &str, today: chrono::NaiveDate) -> Result<WeeklyGoals, String> {
  let root: serde_json::Value = serde_json::from_str(raw).map_err(|error| format!("Could not parse weekly-goals.json: {error}"))?;
  let (week_start, week_end) = calendar_week(today);
  let (month_start, month_end) = calendar_month(today);
  let days_in_month = (month_end - month_start).num_days() + 1;
  let list = match &root {
    serde_json::Value::Array(items) => Some(items),
    serde_json::Value::Object(_) => ["goals", "weekly_goals", "items"].iter().find_map(|key| root.get(*key).and_then(|found| found.as_array())),
    _ => None,
  };

  let goals = list
    .map(|items| {
      items
        .iter()
        .filter(|goal| goal.get("active").and_then(|flag| flag.as_bool()) != Some(false) && goal.get("archived").and_then(|flag| flag.as_bool()) != Some(true))
        .filter_map(|goal| {
          let title = json_text(goal, &["title", "name", "label", "goal"])?;
          let target = json_count(goal, &["target_count", "target", "count"]).filter(|target| *target > 0).unwrap_or(1);
          Some(WeeklyGoal {
            id: json_text(goal, &["id"]).unwrap_or_else(|| slugify(&title)),
            category: json_text(goal, &["category"]).unwrap_or_default(),
            target,
            done: completions_in(goal, week_start, week_end),
            month_target: ((target as f64 * days_in_month as f64 / 7.0).round() as u32).max(1),
            month_done: completions_in(goal, month_start, month_end),
            title,
          })
        })
        .collect()
    })
    .unwrap_or_default();

  Ok(WeeklyGoals {
    exists: true,
    updated: json_text(&root, &["updated"]).unwrap_or_default(),
    week_start: week_start.to_string(),
    week_end: week_end.to_string(),
    month_start: month_start.to_string(),
    month_end: month_end.to_string(),
    goals,
  })
}

#[tauri::command]
fn get_weekly_goals() -> Result<WeeklyGoals, String> {
  let today = chrono::Local::now().date_naive();
  match fs::read_to_string(weekly_goals_path()) {
    Ok(raw) => parse_weekly_goals(&raw, today),
    // Not created yet is a normal state, not a failure to report.
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      let (week_start, week_end) = calendar_week(today);
      let (month_start, month_end) = calendar_month(today);
      Ok(WeeklyGoals {
        week_start: week_start.to_string(),
        week_end: week_end.to_string(),
        month_start: month_start.to_string(),
        month_end: month_end.to_string(),
        ..WeeklyGoals::default()
      })
    }
    Err(error) => Err(format!("Could not read weekly-goals.json: {error}")),
  }
}

fn weekly_goals_summary(goals: &WeeklyGoals) -> String {
  if !goals.exists {
    return "There is no weekly-goals file yet. Use update_goals to have Hermes create the first weekly goal.".to_string();
  }
  if goals.goals.is_empty() {
    return "The weekly goals file exists but lists no goals yet.".to_string();
  }
  let reps_done: u32 = goals.goals.iter().map(|goal| goal.done.min(goal.target)).sum();
  let reps_total: u32 = goals.goals.iter().map(|goal| goal.target).sum();
  let month_done: u32 = goals.goals.iter().map(|goal| goal.month_done.min(goal.month_target)).sum();
  let month_total: u32 = goals.goals.iter().map(|goal| goal.month_target).sum();
  let mut lines = vec![
    format!("Week of {} to {}: {reps_done} of {reps_total} reps done.", goals.week_start, goals.week_end),
    format!("Month of {} to {}: {month_done} of {month_total} reps done (weekly targets scaled to the month).", goals.month_start, goals.month_end),
  ];
  for goal in &goals.goals {
    let category = if goal.category.is_empty() { String::new() } else { format!(" ({})", goal.category) };
    lines.push(format!("- {}{category}: {}/{} this week, {}/{} this month [{}]", goal.title, goal.done, goal.target, goal.month_done, goal.month_target, goal.id));
  }
  lines.join("\n")
}

fn goals_update_prompt(request: &str) -> String {
  format!(
    "Update my goals. Apply exactly this change, and nothing else:\n\n\"{request}\"\n\n\
Two places hold my goals; pick the right one for the request.\n\
- Weekly routines and reps, anything with a per-week target like \"dance twice a week\": {WEEKLY_GOALS_PATH}. You are its only writer. Keep its existing structure and ids. If it doesn't exist yet, create it as {{\"updated\": \"<ISO datetime>\", \"goals\": [{{\"id\": \"<slug>\", \"title\": \"...\", \"category\": \"...\", \"target_count\": <number per week>, \"completions\": [\"YYYY-MM-DD\"]}}]}}. Logging a completion appends today's date (or the date I gave) to that goal's completions.\n\
- Long-term and yearly goals: my goals document at {GOALS_DOC_PATH}. Goals are bullets under headings, and a finished goal is wrapped in ~~strikethrough~~. Keep that format and touch only the bullet in question.\n\
Do not delete a goal unless I said to remove it. Afterwards, refresh the Tasks cards in iris-feed/latest.json if your normal job would, and reply with one short line saying what changed."
  )
}

// Hermes answers on the spot when the CLI is installed, which lets the chat
// tell the user what actually changed; otherwise the request goes to the
// gateway as a background run.
async fn ask_hermes_now(app_handle: &tauri::AppHandle, prompt: &str) -> String {
  if hermes_exe_path().exists() {
    call_hermes_agent_impl(prompt, "").await
  } else if read_hermes_gateway_config(app_handle).is_some() {
    start_hermes_run_impl(app_handle, prompt).await
  } else {
    "Hermes isn't reachable from here: it isn't installed on this machine and no gateway is set up in Settings.".to_string()
  }
}

// --- Acting on the Tasks panel ------------------------------------------
// The feed is one-way: Iris writes latest.json, Artemis reads it. So accepting
// a card or asking for events means telling Iris and letting her rewrite the
// file. Both prompts are fixed text built here; the only thing a card
// contributes is its id, and only if it looks like one.
fn is_safe_card_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn accept_card_prompt(id: &str) -> String {
  format!(
    "accept {id}\n\nThis came from the Suggested tab of the Artemis Tasks panel. Turn it into a Next card (and add a calendar hold if it has a time), as described in TASKS-CONTRACT.md, then update iris-feed/latest.json."
  )
}

// Checking off a card that belongs to a weekly goal or minimum ("Do a Portuguese
// audio lesson") is a completion Iris has to record. The count lives in her
// weekly-goals.json, which Artemis never writes; the channel the contract gives
// is one JSON line appended to iris-feed/checkoffs.jsonl, which her jobs pick up,
// add to the right array and clear (TASKS-CONTRACT.md, "Check-off channel").
// Cards with no goal (calendar events, commitments) are only hidden here.
const CHECKOFFS_FILE: &str = phone_feed::CHECKOFFS_FILE;
const DAILY_DEFAULTS_PATH: &str = r"C:\Users\dccar\HermesKB\daily-defaults.json";

// "minimum" for the ids Iris lists under weekly_minimums in daily-defaults.json,
// "goal" for everything else (or if that file can't be read).
fn checkoff_type(defaults: &str, id: &str) -> &'static str {
  let listed = serde_json::from_str::<serde_json::Value>(defaults)
    .ok()
    .and_then(|root| root.get("weekly_minimums").and_then(|list| list.as_array()).map(|list| list.iter().any(|entry| entry.get("id").and_then(|value| value.as_str()) == Some(id))))
    .unwrap_or(false);
  if listed {
    "minimum"
  } else {
    "goal"
  }
}

// The ids and dates are safe as they are (ids are checked by is_safe_card_id,
// the rest are timestamps Artemis made), so no escaping is needed and the keys
// stay in the order the contract shows them.
fn checkoff_line(kind: &str, id: &str, date: &str, sent_at: &str) -> String {
  format!(r#"{{"type":"{kind}","id":"{id}","date":"{date}","sent_at":"{sent_at}"}}"#)
}

fn append_line(path: &std::path::Path, line: &str) -> std::io::Result<()> {
  use std::io::Write;
  // A last line with no newline would otherwise get ours glued onto it.
  let needs_break = matches!(fs::read(path).ok().and_then(|bytes| bytes.last().copied()), Some(last) if last != b'\n');
  let mut file = fs::OpenOptions::new().create(true).append(true).open(path)?;
  file.write_all(format!("{}{line}\n", if needs_break { "\n" } else { "" }).as_bytes())
}

const SCOUT_PROMPT: &str = "Run your local-events scout now, the same one that runs Monday at 10am, and add what you find to the Suggested list in iris-feed/latest.json as described in TASKS-CONTRACT.md. Only real events, and nothing that is already on my calendar. Every card needs a real date and time; leave out anything you cannot date.";

// Hands one message to Iris without making the UI wait for her. With the
// gateway set up that is a durable run that returns an id straight away;
// without it, the one-shot CLI runs detached (it can take a minute or two).
async fn send_to_iris(app_handle: &tauri::AppHandle, prompt: String) -> Result<(), String> {
  if read_hermes_gateway_config(app_handle).is_some() {
    let outcome = start_hermes_run_impl(app_handle, &prompt).await;
    return if outcome.starts_with("Started Hermes run") { Ok(()) } else { Err(outcome) };
  }
  if !hermes_exe_path().exists() {
    return Err("Iris isn't reachable from here: Hermes isn't installed on this machine and no gateway is set up in Settings.".to_string());
  }
  tauri::async_runtime::spawn(async move {
    let _ = call_hermes_agent_impl(&prompt, "").await;
  });
  Ok(())
}

// Like the yes/no on Iris's daily suggestion, a deliberate un-gated action:
// the user tapped + on a card they were looking at. Still audit-logged.
#[tauri::command]
async fn accept_iris_task(app_handle: tauri::AppHandle, id: String) -> Result<(), String> {
  if !is_safe_card_id(&id) {
    return Err("That card's id isn't something Artemis will forward to Iris.".to_string());
  }
  append_audit_log(&app_handle, 0, "iris_task_accept", &format!("id={id}"));
  send_to_iris(&app_handle, accept_card_prompt(&id)).await
}

// Like the yes/no on Iris's daily suggestion, a deliberate un-gated action: the
// user ticked a card they were looking at. Nothing is sent to a model; it is one
// line in a file. Still audit-logged.
#[tauri::command]
fn record_checkoff(app_handle: tauri::AppHandle, goal_id: String) -> Result<(), String> {
  if !is_safe_card_id(&goal_id) {
    return Err("that goal's id isn't something Artemis will pass to Iris.".to_string());
  }
  let now = chrono::Local::now();
  let defaults = fs::read_to_string(DAILY_DEFAULTS_PATH).unwrap_or_default();
  let line = checkoff_line(checkoff_type(&defaults, &goal_id), &goal_id, &now.format("%Y-%m-%d").to_string(), &now.to_rfc3339());
  append_audit_log(&app_handle, 0, "iris_checkoff", &format!("goal={goal_id}"));
  let path = iris_feed_dir().join(CHECKOFFS_FILE);
  // On the phone this is its own queue (sent to Iris by the next sync), and its folder does
  // not exist until then. The computer's is Iris's folder, which is never created here.
  if cfg!(target_os = "android") {
    if let Some(parent) = path.parent() {
      let _ = fs::create_dir_all(parent);
    }
  }
  append_line(&path, &line).map_err(|error| format!("couldn't write the check-off: {error}"))
}

#[tauri::command]
async fn ask_iris_to_scout(app_handle: tauri::AppHandle) -> Result<(), String> {
  append_audit_log(&app_handle, 0, "iris_scout_request", "");
  send_to_iris(&app_handle, SCOUT_PROMPT.to_string()).await
}

// --- Hermes gateway (durable, steerable runs) ----------------------------
// The one-shot `hermes -z` subprocess above blocks for the whole run and
// abandons it (with no way to reconnect) if Artemis's own timeout fires.
// The gateway's HTTP API instead returns a run_id immediately — the run
// survives disconnects, can be polled independently, and can be steered
// mid-flight. Same "build Artemis's own storage for a credential the user
// provides" pattern as Ollama Cloud/Home Assistant/GitHub: enabling the
// gateway itself (editing Hermes's own config.yaml, a separate
// application's live configuration) is the user's action to take or
// explicitly authorize, not something to do automatically on their behalf —
// this only stores the resulting URL/key once they have.
#[derive(Debug, Serialize, Deserialize, Clone)]
struct HermesGatewayConfig {
  base_url: String,
  key: String,
}

fn hermes_gateway_config_path(app: &tauri::AppHandle) -> PathBuf {
  app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("hermes_gateway.json")
}

#[tauri::command]
fn set_hermes_gateway_config(app: tauri::AppHandle, base_url: String, key: String) -> Result<(), String> {
  // The phone talks to Iris only over Tailscale, and 127.0.0.1 there would be the phone itself.
  if cfg!(target_os = "android") && !phone_address_allowed(&base_url) {
    return Err("On the phone the gateway has to be on your Tailscale network: an address like http://100.x.x.x:8642 or a name ending in .ts.net.".to_string());
  }
  let path = hermes_gateway_config_path(&app);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let config = HermesGatewayConfig { base_url: base_url.trim().trim_end_matches('/').to_string(), key: key.trim().to_string() };
  let serialized = serde_json::to_string(&config).map_err(|error| error.to_string())?;
  fs::write(&path, serialized).map_err(|error| error.to_string())
}

#[tauri::command]
fn has_hermes_gateway_config(app: tauri::AppHandle) -> bool {
  read_hermes_gateway_config(&app).is_some()
}

#[tauri::command]
fn clear_hermes_gateway_config(app: tauri::AppHandle) -> Result<(), String> {
  let path = hermes_gateway_config_path(&app);
  if path.exists() {
    fs::remove_file(&path).map_err(|error| error.to_string())?;
  }
  Ok(())
}

fn read_hermes_gateway_config(app: &tauri::AppHandle) -> Option<HermesGatewayConfig> {
  fs::read_to_string(hermes_gateway_config_path(app))
    .ok()
    .and_then(|raw| serde_json::from_str::<HermesGatewayConfig>(&raw).ok())
    .filter(|config| !config.base_url.is_empty() && !config.key.is_empty())
}

async fn start_hermes_run_impl(app_handle: &tauri::AppHandle, prompt: &str) -> String {
  let Some(config) = read_hermes_gateway_config(app_handle) else {
    return "The Hermes gateway isn't configured yet — enable gateway.api_server in Hermes's own config, start `hermes gateway`, and add its URL/key in Artemis Settings.".to_string();
  };
  let client = http_client();
  // The field is "input", not "prompt" — confirmed against the live gateway
  // (POST with "prompt" returned a real 400 "Missing 'input' field"; the
  // integration brief this was originally built from had it wrong).
  let payload = serde_json::json!({ "input": prompt, "session_key": "artemis" });
  let response = match client.post(format!("{}/v1/runs", config.base_url)).bearer_auth(&config.key).json(&payload).send().await {
    Ok(response) => response,
    Err(error) => return format!("Could not reach the Hermes gateway: {error}"),
  };
  if !response.status().is_success() {
    return format!("Hermes gateway returned HTTP {}.", response.status());
  }
  #[derive(Deserialize)]
  struct RunCreated {
    run_id: String,
  }
  match response.json::<RunCreated>().await {
    Ok(created) => format!("Started Hermes run {}. Use check_hermes_run to see progress.", created.run_id),
    Err(error) => format!("Could not parse the gateway response: {error}"),
  }
}

async fn check_hermes_run_impl(app_handle: &tauri::AppHandle, run_id: &str) -> String {
  let Some(config) = read_hermes_gateway_config(app_handle) else {
    return "The Hermes gateway isn't configured yet.".to_string();
  };
  let client = http_client();
  let response = match client.get(format!("{}/v1/runs/{}", config.base_url, run_id.trim())).bearer_auth(&config.key).send().await {
    Ok(response) => response,
    Err(error) => return format!("Could not reach the Hermes gateway: {error}"),
  };
  if !response.status().is_success() {
    return format!("Hermes gateway returned HTTP {} for run {run_id}.", response.status());
  }
  match response.text().await {
    Ok(text) => text,
    Err(error) => format!("Could not read the gateway response: {error}"),
  }
}

async fn steer_hermes_run_impl(app_handle: &tauri::AppHandle, run_id: &str, message: &str) -> String {
  let Some(config) = read_hermes_gateway_config(app_handle) else {
    return "The Hermes gateway isn't configured yet.".to_string();
  };
  let client = http_client();
  let payload = serde_json::json!({ "message": message });
  let response = match client
    .post(format!("{}/v1/runs/{}/steer", config.base_url, run_id.trim()))
    .bearer_auth(&config.key)
    .json(&payload)
    .send()
    .await
  {
    Ok(response) => response,
    Err(error) => return format!("Could not reach the Hermes gateway: {error}"),
  };
  if response.status().as_u16() == 409 {
    format!("Run {run_id} is no longer running, so it can't be steered.")
  } else if response.status().is_success() {
    format!("Steered run {run_id}.")
  } else {
    format!("Hermes gateway returned HTTP {} for steering run {run_id}.", response.status())
  }
}

async fn stop_hermes_run_impl(app_handle: &tauri::AppHandle, run_id: &str) -> String {
  let Some(config) = read_hermes_gateway_config(app_handle) else {
    return "The Hermes gateway isn't configured yet.".to_string();
  };
  let client = http_client();
  let response = match client.post(format!("{}/v1/runs/{}/stop", config.base_url, run_id.trim())).bearer_auth(&config.key).send().await {
    Ok(response) => response,
    Err(error) => return format!("Could not reach the Hermes gateway: {error}"),
  };
  if response.status().is_success() {
    format!("Stopped run {run_id}.")
  } else {
    format!("Hermes gateway returned HTTP {} for stopping run {run_id}.", response.status())
  }
}

// `hermes send` reuses the gateway's already-configured platform credentials
// directly — no LLM, no agent loop, no running gateway required for
// bot-token platforms (Telegram/Discord/Slack/Signal). Confirmation-gated
// like GitHub comments: it's visible to other people, not just a local
// action.
async fn send_message_via_hermes_impl(target: &str, message: &str) -> String {
  if !hermes_exe_path().exists() {
    return "Hermes Agent isn't installed on this machine.".to_string();
  }
  let target = target.to_string();
  let message = message.to_string();
  let target_for_command = target.clone();

  let output_future = tauri::async_runtime::spawn_blocking(move || {
    hermes_command().arg("send").arg("--to").arg(&target_for_command).arg("--quiet").arg(&message).output()
  });

  match tokio::time::timeout(std::time::Duration::from_secs(30), output_future).await {
    Ok(Ok(Ok(output))) if output.status.success() => format!("Sent to {target}."),
    Ok(Ok(Ok(output))) => {
      let stderr = String::from_utf8_lossy(&output.stderr);
      let stdout = String::from_utf8_lossy(&output.stdout);
      let detail = if !stderr.trim().is_empty() {
        stderr.trim().to_string()
      } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
      } else {
        // `hermes send`'s documented exit codes: 1 delivery/backend error, 2
        // usage error — surface that instead of a blank message when it
        // produces no output on either stream (observed for "no platform
        // configured" on this install).
        match output.status.code() {
          Some(1) => "delivery/backend error (likely no matching platform configured — run `hermes gateway setup`).".to_string(),
          Some(2) => "usage error (check the target format).".to_string(),
          Some(code) => format!("exit code {code}."),
          None => "unknown error.".to_string(),
        }
      };
      format!("Could not send to {target}: {detail}")
    }
    Ok(Ok(Err(error))) => format!("Could not run Hermes: {error}"),
    Ok(Err(_)) => "Send task failed unexpectedly.".to_string(),
    Err(_) => "Sending timed out.".to_string(),
  }
}

// --- Web page fetch -------------------------------------------------------
// Deliberately NOT a general web search — there's no reliable, free, keyless
// search API (the ones that exist all need an account/key), and guessing at
// one would violate the "prefer open/anonymous" preference just to tick a
// box. This covers the actual value of MCP's reference "fetch" server
// without the protocol/subprocess overhead of a real MCP client: given a URL
// (from the user or the model's own knowledge), fetch it and read it.
const FETCH_WEBPAGE_MAX_CHARS: usize = 6000;
const FETCH_WEBPAGE_MAX_BYTES: usize = 2 * 1024 * 1024;

// Shared by fetch_webpage and the webpage-tracking tools below: fetch a URL
// and reduce it to readable text, or a human-readable error string. One
// implementation so the streaming/size-cap safety logic only exists once.
async fn fetch_and_extract_text(url: &str) -> Result<(String, String), String> {
  let normalized = if url.starts_with("http://") || url.starts_with("https://") {
    url.to_string()
  } else {
    format!("https://{url}")
  };

  let client = http_client();
  let mut response = client
    .get(&normalized)
    .header("User-Agent", "Artemis/1.0")
    .send()
    .await
    .map_err(|error| format!("Could not fetch {normalized}: {error}"))?;
  if !response.status().is_success() {
    return Err(format!("{normalized} returned HTTP {}.", response.status()));
  }

  // Unlike the fixed, known RSS feeds elsewhere in this file, this fetches
  // whatever URL the model is given — read incrementally with a hard cap
  // instead of response.text(), so a huge or malicious response can't
  // balloon memory or hang the app before html_to_readable_text even runs.
  let mut buffer: Vec<u8> = Vec::new();
  loop {
    match response.chunk().await {
      Ok(Some(chunk)) => {
        buffer.extend_from_slice(&chunk);
        if buffer.len() >= FETCH_WEBPAGE_MAX_BYTES {
          break;
        }
      }
      Ok(None) => break,
      Err(error) => return Err(format!("Could not read the response from {normalized}: {error}")),
    }
  }
  let html = String::from_utf8_lossy(&buffer);
  let text = html_to_readable_text(&html);
  Ok((normalized, text))
}

async fn fetch_webpage_impl(url: &str) -> String {
  match fetch_and_extract_text(url).await {
    Ok((normalized, text)) if text.is_empty() => format!("Fetched {normalized} but found no readable text content."),
    Ok((normalized, text)) => {
      let truncated: String = text.chars().take(FETCH_WEBPAGE_MAX_CHARS).collect();
      format!("Content from {normalized}:\n\n{truncated}")
    }
    Err(error) => error,
  }
}

fn ascii_starts_with_ci(haystack: &[u8], needle: &[u8]) -> bool {
  haystack.len() >= needle.len() && haystack[..needle.len()].eq_ignore_ascii_case(needle)
}

fn ascii_find_ci(haystack: &[u8], needle: &[u8]) -> Option<usize> {
  if needle.is_empty() || haystack.len() < needle.len() {
    return None;
  }
  (0..=(haystack.len() - needle.len())).find(|&start| haystack[start..start + needle.len()].eq_ignore_ascii_case(needle))
}

// Minimal, dependency-free HTML-to-text: drops <script>/<style> blocks
// bodily (their content isn't page text), strips remaining tags, and
// collapses whitespace. Not a real HTML parser — good enough for "read me
// this article", not meant for scraping structured data. Operates on raw
// byte slices (&[u8], which have no char-boundary constraint) rather than
// &str slicing specifically to avoid a panic — slicing a &str at an
// arbitrary byte offset panics if that offset lands mid-character, and a
// fixed-width lookahead window like "first 7 bytes" has no way to guarantee
// that up front.
fn html_to_readable_text(html: &str) -> String {
  let bytes = html.as_bytes();
  let mut cleaned = String::with_capacity(html.len());
  let mut i = 0usize;
  let len = bytes.len();

  while i < len {
    if ascii_starts_with_ci(&bytes[i..], b"<script") {
      match ascii_find_ci(&bytes[i..], b"</script>") {
        Some(rel_end) => i += rel_end + "</script>".len(),
        None => break,
      }
      continue;
    }
    if ascii_starts_with_ci(&bytes[i..], b"<style") {
      match ascii_find_ci(&bytes[i..], b"</style>") {
        Some(rel_end) => i += rel_end + "</style>".len(),
        None => break,
      }
      continue;
    }
    if bytes[i] == b'<' {
      match ascii_find_ci(&bytes[i..], b">") {
        Some(rel_end) => i += rel_end + 1,
        None => break,
      }
      cleaned.push(' ');
      continue;
    }
    // Every branch above only matches and advances past literal ASCII bytes
    // (a needle byte >= 0x80 can never equal an ASCII byte, so a match can
    // only land on real ASCII characters, never mid-multibyte-sequence) —
    // so i is guaranteed to be at a valid char boundary here.
    let ch = html[i..].chars().next().unwrap();
    cleaned.push(ch);
    i += ch.len_utf8();
  }

  cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

// --- Web search (honest about its limits) -------------------------------
// There is no reliable, free, keyless general web search API — every real
// one (Bing, Google, Brave, SerpApi) needs an account and a key. Rather than
// fabricate a search tool that silently fails, this uses DuckDuckGo's
// keyless Instant Answer API for what it actually is: direct-answer/summary
// lookups for well-known topics, not ranked web results for arbitrary
// queries. The tool description says so explicitly, so the model doesn't
// overclaim its own results either.
#[derive(Deserialize)]
struct DuckDuckGoResponse {
  #[serde(rename = "AbstractText", default)]
  abstract_text: String,
  #[serde(rename = "AbstractURL", default)]
  abstract_url: String,
  #[serde(rename = "RelatedTopics", default)]
  related_topics: Vec<serde_json::Value>,
}

async fn web_search_impl(query: &str) -> String {
  if query.trim().is_empty() {
    return "Error: a search query is required.".to_string();
  }
  let url = format!("https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1", urlencoding_encode(query.trim()));
  let client = http_client();
  let response = match client.get(&url).header("User-Agent", "Artemis/1.0").send().await {
    Ok(response) => response,
    Err(error) => return format!("Search failed: {error}"),
  };
  if !response.status().is_success() {
    return format!("Search failed: HTTP {}.", response.status());
  }
  let parsed: DuckDuckGoResponse = match response.json().await {
    Ok(parsed) => parsed,
    Err(error) => return format!("Could not parse search response: {error}"),
  };

  if !parsed.abstract_text.is_empty() {
    return format!("{}\n\nSource: {}", parsed.abstract_text, parsed.abstract_url);
  }
  let topics: Vec<String> = parsed
    .related_topics
    .iter()
    .filter_map(|topic| topic.get("Text").and_then(|value| value.as_str()).map(|text| format!("- {text}")))
    .take(5)
    .collect();
  if topics.is_empty() {
    "No direct answer found for that query — this tool only covers well-known topics, not general web search.".to_string()
  } else {
    topics.join("\n")
  }
}

// --- Local system diagnostics -------------------------------------------
// Scoped, read-first tools for "Personal Tech Support Agent" — deliberately
// NOT a generic shell-execution tool. Every process below runs one fixed
// system utility (sc/net) with a single argument passed via Command::arg,
// not through a shell — Windows' CreateProcess receives argv directly, so
// shell metacharacters in a hallucinated argument can't inject a second
// command the way they could through cmd /c "...". The one mutating action
// (restart) is confirmation-gated like everything else that changes state.
fn list_running_processes_impl() -> String {
  let mut system = sysinfo::System::new_all();
  system.refresh_all();
  let mut processes: Vec<_> = system.processes().values().collect();
  processes.sort_by(|a, b| b.cpu_usage().partial_cmp(&a.cpu_usage()).unwrap_or(std::cmp::Ordering::Equal));
  processes
    .iter()
    .take(20)
    .map(|process| {
      format!(
        "- {} (pid {}): {:.1}% CPU, {} MB",
        process.name().to_string_lossy(),
        process.pid(),
        process.cpu_usage(),
        process.memory() / 1024 / 1024
      )
    })
    .collect::<Vec<_>>()
    .join("\n")
}

fn check_disk_space_impl() -> String {
  let disks = sysinfo::Disks::new_with_refreshed_list();
  if disks.is_empty() {
    return "Could not read disk information.".to_string();
  }
  disks
    .iter()
    .map(|disk| {
      let total_gb = disk.total_space() as f64 / 1e9;
      let available_gb = disk.available_space() as f64 / 1e9;
      format!("- {}: {available_gb:.1} GB free of {total_gb:.1} GB", disk.mount_point().display())
    })
    .collect::<Vec<_>>()
    .join("\n")
}

fn check_windows_service_status_impl(name: &str) -> String {
  if name.trim().is_empty() {
    return "Error: a service name is required.".to_string();
  }
  match std::process::Command::new("sc").arg("query").arg(name.trim()).output() {
    Ok(output) => {
      let text = String::from_utf8_lossy(&output.stdout);
      if text.trim().is_empty() {
        format!("No service named \"{}\" was found.", name.trim())
      } else {
        text.trim().to_string()
      }
    }
    Err(error) => format!("Could not check service status: {error}"),
  }
}

// net stop/start on a real service can take real wall-clock seconds, unlike
// the quick in-memory Mutex reads most other tool impls do — run it on a
// blocking-pool thread (same discipline as read_content_with_timeout
// elsewhere in this file) so it can't stall the async runtime.
async fn restart_windows_service_impl(name: &str) -> String {
  let name = name.trim().to_string();
  if name.is_empty() {
    return "Error: a service name is required.".to_string();
  }
  tauri::async_runtime::spawn_blocking(move || {
    let stop = std::process::Command::new("net").arg("stop").arg(&name).output();
    let start = std::process::Command::new("net").arg("start").arg(&name).output();
    match (stop, start) {
      (Ok(stop_output), Ok(start_output)) => {
        let stop_text = String::from_utf8_lossy(&stop_output.stdout);
        let start_text = String::from_utf8_lossy(&start_output.stdout);
        format!("Stop: {}\nStart: {}", stop_text.trim(), start_text.trim())
      }
      _ => format!("Could not restart service \"{name}\" — it may require running Artemis as Administrator."),
    }
  })
  .await
  .unwrap_or_else(|_| "Restart task failed unexpectedly.".to_string())
}

// --- Home Assistant --------------------------------------------------------
// Same trust pattern as the Ollama Cloud key: build the plumbing without
// having real credentials, store them locally if/when the user adds their
// own, and the feature is simply unusable until they do. No account of mine
// required, no fabricated integration.
#[derive(Debug, Serialize, Deserialize, Clone)]
struct HomeAssistantConfig {
  base_url: String,
  token: String,
}

fn home_assistant_config_path(app: &tauri::AppHandle) -> PathBuf {
  app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("home_assistant.json")
}

#[tauri::command]
fn set_home_assistant_config(app: tauri::AppHandle, base_url: String, token: String) -> Result<(), String> {
  let path = home_assistant_config_path(&app);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let config = HomeAssistantConfig { base_url: base_url.trim().trim_end_matches('/').to_string(), token: token.trim().to_string() };
  let serialized = serde_json::to_string(&config).map_err(|error| error.to_string())?;
  fs::write(&path, serialized).map_err(|error| error.to_string())
}

#[tauri::command]
fn has_home_assistant_config(app: tauri::AppHandle) -> bool {
  read_home_assistant_config(&app).is_some()
}

#[tauri::command]
fn clear_home_assistant_config(app: tauri::AppHandle) -> Result<(), String> {
  let path = home_assistant_config_path(&app);
  if path.exists() {
    fs::remove_file(&path).map_err(|error| error.to_string())?;
  }
  Ok(())
}

fn read_home_assistant_config(app: &tauri::AppHandle) -> Option<HomeAssistantConfig> {
  fs::read_to_string(home_assistant_config_path(app))
    .ok()
    .and_then(|raw| serde_json::from_str::<HomeAssistantConfig>(&raw).ok())
    .filter(|config| !config.base_url.is_empty() && !config.token.is_empty())
}

// Controls a real physical device — gated behind the same confirmation
// mechanism as update_note/delete_note (see execute_tool_call), since a
// hallucinated or wrong call here has a real-world side effect, not just a
// digital one.
async fn call_home_assistant_service_impl(app_handle: &tauri::AppHandle, domain: &str, service: &str, entity_id: &str) -> String {
  let Some(config) = read_home_assistant_config(app_handle) else {
    return "Home Assistant isn't configured yet — add its URL and a long-lived access token in Settings.".to_string();
  };
  if domain.trim().is_empty() || service.trim().is_empty() {
    return "Error: both a domain and a service are required (e.g. \"light\", \"turn_on\").".to_string();
  }

  let url = format!("{}/api/services/{}/{}", config.base_url, domain.trim(), service.trim());
  let body = if entity_id.trim().is_empty() { serde_json::json!({}) } else { serde_json::json!({ "entity_id": entity_id.trim() }) };

  let client = http_client();
  match client.post(&url).bearer_auth(&config.token).json(&body).send().await {
    Ok(response) if response.status().is_success() => {
      if entity_id.trim().is_empty() {
        format!("Called {domain}.{service}.")
      } else {
        format!("Called {domain}.{service} on {}.", entity_id.trim())
      }
    }
    Ok(response) => format!("Home Assistant returned HTTP {} for {domain}.{service}.", response.status()),
    Err(error) => format!("Could not reach Home Assistant: {error}"),
  }
}

async fn list_home_assistant_entities_impl(app_handle: &tauri::AppHandle, domain_filter: &str) -> String {
  let Some(config) = read_home_assistant_config(app_handle) else {
    return "Home Assistant isn't configured yet — add its URL and a long-lived access token in Settings.".to_string();
  };

  #[derive(Deserialize)]
  struct HaState {
    entity_id: String,
    state: String,
  }

  let url = format!("{}/api/states", config.base_url);
  let client = http_client();
  let response = match client.get(&url).bearer_auth(&config.token).send().await {
    Ok(response) => response,
    Err(error) => return format!("Could not reach Home Assistant: {error}"),
  };
  if !response.status().is_success() {
    return format!("Home Assistant returned HTTP {}.", response.status());
  }
  let states: Vec<HaState> = match response.json().await {
    Ok(states) => states,
    Err(error) => return format!("Could not parse Home Assistant response: {error}"),
  };

  let filter = domain_filter.trim().to_lowercase();
  let filtered: Vec<String> = states
    .into_iter()
    .filter(|entity| filter.is_empty() || entity.entity_id.starts_with(&format!("{filter}.")))
    .take(60)
    .map(|entity| format!("- {}: {}", entity.entity_id, entity.state))
    .collect();

  if filtered.is_empty() {
    "No matching entities found.".to_string()
  } else {
    filtered.join("\n")
  }
}

// --- GitHub ------------------------------------------------------------
// Direct REST API calls rather than a real MCP client — simpler, no
// subprocess/protocol machinery to get subtly wrong, and this app has no
// other MCP servers to justify building that generic layer for just one
// integration. Same "build the plumbing, add your own token later" pattern
// as Ollama Cloud and Home Assistant above.
fn github_token_path(app: &tauri::AppHandle) -> PathBuf {
  app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("github_token.txt")
}

#[tauri::command]
fn set_github_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
  let path = github_token_path(&app);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  fs::write(&path, token.trim()).map_err(|error| error.to_string())
}

#[tauri::command]
fn has_github_token(app: tauri::AppHandle) -> bool {
  read_github_token(&app).is_some()
}

#[tauri::command]
fn clear_github_token(app: tauri::AppHandle) -> Result<(), String> {
  let path = github_token_path(&app);
  if path.exists() {
    fs::remove_file(&path).map_err(|error| error.to_string())?;
  }
  Ok(())
}

fn read_github_token(app: &tauri::AppHandle) -> Option<String> {
  fs::read_to_string(github_token_path(app)).ok().map(|content| content.trim().to_string()).filter(|token| !token.is_empty())
}

async fn list_github_issues_impl(app_handle: &tauri::AppHandle, repo: &str) -> String {
  let Some(token) = read_github_token(app_handle) else {
    return "GitHub isn't configured yet — add a personal access token in Settings.".to_string();
  };
  let url = format!("https://api.github.com/repos/{}/issues?state=open&per_page=20", repo.trim());
  let client = http_client();
  let response = match client.get(&url).bearer_auth(&token).header("User-Agent", "Artemis/1.0").header("Accept", "application/vnd.github+json").send().await {
    Ok(response) => response,
    Err(error) => return format!("Could not reach GitHub: {error}"),
  };
  if !response.status().is_success() {
    return format!("GitHub returned HTTP {} for {repo}.", response.status());
  }
  #[derive(Deserialize)]
  struct GhIssue {
    number: u64,
    title: String,
    html_url: String,
  }
  match response.json::<Vec<GhIssue>>().await {
    Ok(issues) if issues.is_empty() => format!("No open issues found in {repo}."),
    Ok(issues) => issues.iter().map(|issue| format!("- #{} {} ({})", issue.number, issue.title, issue.html_url)).collect::<Vec<_>>().join("\n"),
    Err(error) => format!("Could not parse GitHub response: {error}"),
  }
}

// A write action, visible to others on a real repository — gated behind
// confirmation for the same reason as Home Assistant service calls above.
async fn create_github_issue_impl(app_handle: &tauri::AppHandle, repo: &str, title: &str, body: &str) -> String {
  let Some(token) = read_github_token(app_handle) else {
    return "GitHub isn't configured yet — add a personal access token in Settings.".to_string();
  };
  let url = format!("https://api.github.com/repos/{}/issues", repo.trim());
  let client = http_client();
  let payload = serde_json::json!({ "title": title, "body": body });
  let response = match client.post(&url).bearer_auth(&token).header("User-Agent", "Artemis/1.0").header("Accept", "application/vnd.github+json").json(&payload).send().await {
    Ok(response) => response,
    Err(error) => return format!("Could not reach GitHub: {error}"),
  };
  if !response.status().is_success() {
    return format!("GitHub returned HTTP {} when creating an issue in {repo}.", response.status());
  }
  #[derive(Deserialize)]
  struct Created {
    html_url: String,
    number: u64,
  }
  match response.json::<Created>().await {
    Ok(created) => format!("Created issue #{} in {repo}: {}", created.number, created.html_url),
    Err(_) => format!("Created the issue in {repo}, but could not parse the confirmation response."),
  }
}

async fn check_github_pr_status_impl(app_handle: &tauri::AppHandle, repo: &str, pr_number: u64) -> String {
  let Some(token) = read_github_token(app_handle) else {
    return "GitHub isn't configured yet — add a personal access token in Settings.".to_string();
  };
  let url = format!("https://api.github.com/repos/{}/pulls/{}", repo.trim(), pr_number);
  let client = http_client();
  let response = match client.get(&url).bearer_auth(&token).header("User-Agent", "Artemis/1.0").header("Accept", "application/vnd.github+json").send().await {
    Ok(response) => response,
    Err(error) => return format!("Could not reach GitHub: {error}"),
  };
  if !response.status().is_success() {
    return format!("GitHub returned HTTP {} for {repo}#{pr_number}.", response.status());
  }
  #[derive(Deserialize)]
  struct GhPr {
    title: String,
    state: String,
    merged: bool,
    mergeable: Option<bool>,
    html_url: String,
    comments: u64,
    review_comments: u64,
  }
  match response.json::<GhPr>().await {
    Ok(pr) => format!(
      "PR #{pr_number} \"{}\" — state: {}{}, mergeable: {}, {} comments + {} review comments. {}",
      pr.title,
      pr.state,
      if pr.merged { " (merged)" } else { "" },
      pr.mergeable.map(|value| value.to_string()).unwrap_or_else(|| "unknown".to_string()),
      pr.comments,
      pr.review_comments,
      pr.html_url
    ),
    Err(error) => format!("Could not parse GitHub response: {error}"),
  }
}

// Also a write action visible to others — confirmation-gated.
async fn comment_on_github_pr_impl(app_handle: &tauri::AppHandle, repo: &str, pr_number: u64, comment: &str) -> String {
  let Some(token) = read_github_token(app_handle) else {
    return "GitHub isn't configured yet — add a personal access token in Settings.".to_string();
  };
  let url = format!("https://api.github.com/repos/{}/issues/{}/comments", repo.trim(), pr_number);
  let client = http_client();
  let payload = serde_json::json!({ "body": comment });
  let response = match client.post(&url).bearer_auth(&token).header("User-Agent", "Artemis/1.0").header("Accept", "application/vnd.github+json").json(&payload).send().await {
    Ok(response) => response,
    Err(error) => return format!("Could not reach GitHub: {error}"),
  };
  if response.status().is_success() {
    format!("Posted a comment on {repo}#{pr_number}.")
  } else {
    format!("GitHub returned HTTP {} when commenting on {repo}#{pr_number}.", response.status())
  }
}

// --- Webpage change tracking ----------------------------------------------
// The generic primitive behind "competitor intelligence", "price tracking",
// and "content monitoring" alike: snapshot a page's text, and later compare
// against a fresh fetch. Combined with schedule_daily_task, "check my
// competitor's pricing page every morning and tell me if it changed"
// requires zero new scheduling code — it's just this plus a prompt.
const TRACKED_PAGE_SNAPSHOT_MAX_CHARS: usize = 4000;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct TrackedPage {
  label: String,
  url: String,
  last_hash: String,
  last_snapshot: String,
  last_checked: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct TrackedPagesFile {
  pages: Vec<TrackedPage>,
}

struct TrackedPagesState {
  pages: Mutex<Vec<TrackedPage>>,
  path: PathBuf,
}

impl TrackedPagesState {
  fn load(path: PathBuf) -> Self {
    let pages = fs::read_to_string(&path)
      .ok()
      .and_then(|raw| serde_json::from_str::<TrackedPagesFile>(&raw).ok())
      .map(|file| file.pages)
      .unwrap_or_default();
    TrackedPagesState { pages: Mutex::new(pages), path }
  }

  fn save(&self) {
    let serialized = match self.pages.lock() {
      Ok(pages) => serde_json::to_string(&TrackedPagesFile { pages: pages.clone() }).ok(),
      Err(_) => None,
    };
    if let Some(serialized) = serialized {
      if let Some(parent) = self.path.parent() {
        let _ = fs::create_dir_all(parent);
      }
      let _ = fs::write(&self.path, serialized);
    }
  }
}

async fn track_webpage_impl(state: &TrackedPagesState, url: &str, label: &str) -> String {
  let (normalized, text) = match fetch_and_extract_text(url).await {
    Ok(result) => result,
    Err(error) => return error,
  };
  let snapshot: String = text.chars().take(TRACKED_PAGE_SNAPSHOT_MAX_CHARS).collect();
  let hash = stable_hash(&snapshot);
  let label = if label.trim().is_empty() { normalized.clone() } else { label.trim().to_string() };

  {
    let mut pages = match state.pages.lock() {
      Ok(pages) => pages,
      Err(_) => return "Could not access tracked pages.".to_string(),
    };
    pages.retain(|page| page.url != normalized);
    pages.push(TrackedPage {
      label: label.clone(),
      url: normalized.clone(),
      last_hash: hash,
      last_snapshot: snapshot,
      last_checked: chrono::Local::now().to_rfc3339(),
    });
  }
  state.save();
  format!("Now tracking \"{label}\" ({normalized}). Ask to check it later to see if it's changed.")
}

fn find_tracked_page<'a>(pages: &'a [TrackedPage], query: &str) -> Option<&'a TrackedPage> {
  let query_lower = query.trim().to_lowercase();
  if query_lower.is_empty() {
    return None;
  }
  pages
    .iter()
    .find(|page| page.label.to_lowercase() == query_lower || page.url.to_lowercase() == query_lower)
    .or_else(|| pages.iter().find(|page| page.label.to_lowercase().contains(&query_lower) || page.url.contains(&query_lower)))
}

async fn check_webpage_changes_impl(state: &TrackedPagesState, query: &str) -> String {
  let existing = {
    let pages = match state.pages.lock() {
      Ok(pages) => pages,
      Err(_) => return "Could not access tracked pages.".to_string(),
    };
    match find_tracked_page(&pages, query) {
      Some(page) => page.clone(),
      None => return format!("No tracked page matching \"{query}\" was found. Use track_webpage first."),
    }
  };

  let (normalized, text) = match fetch_and_extract_text(&existing.url).await {
    Ok(result) => result,
    Err(error) => return error,
  };
  let snapshot: String = text.chars().take(TRACKED_PAGE_SNAPSHOT_MAX_CHARS).collect();
  let new_hash = stable_hash(&snapshot);
  let changed = new_hash != existing.last_hash;

  {
    let mut pages = match state.pages.lock() {
      Ok(pages) => pages,
      Err(_) => return "Could not access tracked pages.".to_string(),
    };
    if let Some(page) = pages.iter_mut().find(|page| page.url == normalized) {
      page.last_hash = new_hash;
      page.last_snapshot = snapshot.clone();
      page.last_checked = chrono::Local::now().to_rfc3339();
    }
  }
  state.save();

  if changed {
    format!(
      "\"{}\" has changed since it was last checked.\n\nPrevious content:\n{}\n\nCurrent content:\n{}",
      existing.label, existing.last_snapshot, snapshot
    )
  } else {
    format!("\"{}\" has not changed since it was last checked.", existing.label)
  }
}

fn list_tracked_pages_impl(state: &TrackedPagesState) -> String {
  let pages = match state.pages.lock() {
    Ok(pages) => pages.clone(),
    Err(_) => return "Could not access tracked pages.".to_string(),
  };
  if pages.is_empty() {
    return "No pages are currently being tracked.".to_string();
  }
  pages.iter().map(|page| format!("- \"{}\" ({})", page.label, page.url)).collect::<Vec<_>>().join("\n")
}

fn untrack_webpage_impl(state: &TrackedPagesState, query: &str) -> String {
  let removed_label = {
    let mut pages = match state.pages.lock() {
      Ok(pages) => pages,
      Err(_) => return "Could not access tracked pages.".to_string(),
    };
    let index = pages
      .iter()
      .position(|page| page.label.to_lowercase() == query.trim().to_lowercase() || page.url == query.trim())
      .or_else(|| pages.iter().position(|page| page.label.to_lowercase().contains(&query.trim().to_lowercase())));
    index.map(|index| pages.remove(index).label)
  };
  match removed_label {
    Some(label) => {
      state.save();
      format!("Stopped tracking \"{label}\".")
    }
    None => format!("No tracked page matching \"{query}\" was found."),
  }
}

// --- Skills (taught procedures) -----------------------------------------
// "Personal SOP Builder" in scope: the user walks Artemis through a process
// once, save_skill stores it verbatim, and get_skill retrieves it later so
// the model can follow the same steps without being re-taught. Deliberately
// just a named-text store, not an execution engine — the model still does
// the reasoning/tool-calling itself, using the retrieved procedure as
// context, the same way search_knowledge_base results are used.
#[derive(Debug, Serialize, Deserialize, Clone)]
struct Skill {
  name: String,
  procedure: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct SkillsFile {
  skills: Vec<Skill>,
}

struct SkillsState {
  skills: Mutex<Vec<Skill>>,
  path: PathBuf,
}

impl SkillsState {
  fn load(path: PathBuf) -> Self {
    let skills = fs::read_to_string(&path)
      .ok()
      .and_then(|raw| serde_json::from_str::<SkillsFile>(&raw).ok())
      .map(|file| file.skills)
      .unwrap_or_default();
    SkillsState { skills: Mutex::new(skills), path }
  }

  fn save(&self) {
    let serialized = match self.skills.lock() {
      Ok(skills) => serde_json::to_string(&SkillsFile { skills: skills.clone() }).ok(),
      Err(_) => None,
    };
    if let Some(serialized) = serialized {
      if let Some(parent) = self.path.parent() {
        let _ = fs::create_dir_all(parent);
      }
      let _ = fs::write(&self.path, serialized);
    }
  }
}

fn save_skill_impl(state: &SkillsState, name: &str, procedure: &str) -> String {
  {
    let mut skills = match state.skills.lock() {
      Ok(skills) => skills,
      Err(_) => return "Could not access saved procedures.".to_string(),
    };
    match skills.iter_mut().find(|skill| skill.name.eq_ignore_ascii_case(name)) {
      Some(existing) => existing.procedure = procedure.to_string(),
      None => skills.push(Skill { name: name.to_string(), procedure: procedure.to_string() }),
    }
  }
  state.save();
  format!("Saved the \"{name}\" procedure — I'll remember how to do this.")
}

fn find_skill<'a>(skills: &'a [Skill], query: &str) -> Option<&'a Skill> {
  let query_lower = query.trim().to_lowercase();
  if query_lower.is_empty() {
    return None;
  }
  skills
    .iter()
    .find(|skill| skill.name.to_lowercase() == query_lower)
    .or_else(|| skills.iter().find(|skill| skill.name.to_lowercase().contains(&query_lower)))
}

fn get_skill_impl(state: &SkillsState, name: &str) -> String {
  let skills = match state.skills.lock() {
    Ok(skills) => skills,
    Err(_) => return "Could not access saved procedures.".to_string(),
  };
  match find_skill(&skills, name) {
    Some(skill) => format!("Procedure for \"{}\":\n{}", skill.name, skill.procedure),
    None => format!("No saved procedure matching \"{name}\" was found."),
  }
}

fn list_skills_impl(state: &SkillsState) -> String {
  let skills = match state.skills.lock() {
    Ok(skills) => skills.clone(),
    Err(_) => return "Could not access saved procedures.".to_string(),
  };
  if skills.is_empty() {
    return "No procedures have been taught yet.".to_string();
  }
  skills.iter().map(|skill| format!("- {}", skill.name)).collect::<Vec<_>>().join("\n")
}

fn remove_skill_impl(state: &SkillsState, query: &str) -> String {
  let query_lower = query.trim().to_lowercase();
  if query_lower.is_empty() {
    return "Error: a procedure name is required.".to_string();
  }

  let removed_name = {
    let mut skills = match state.skills.lock() {
      Ok(skills) => skills,
      Err(_) => return "Could not access saved procedures.".to_string(),
    };
    let index = skills
      .iter()
      .position(|skill| skill.name.to_lowercase() == query_lower)
      .or_else(|| skills.iter().position(|skill| skill.name.to_lowercase().contains(&query_lower)));
    index.map(|index| skills.remove(index).name)
  };

  match removed_name {
    Some(name) => {
      state.save();
      format!("Forgot the \"{name}\" procedure.")
    }
    None => format!("No saved procedure matching \"{query}\" was found."),
  }
}

async fn run_scheduled_task(app_handle: &tauri::AppHandle, task: &ScheduledTask) {
  let knowledge_paths = {
    let knowledge_state = app_handle.state::<KnowledgeState>();
    knowledge_state
      .index
      .lock()
      .map(|index| index.manifest.known_paths.iter().map(|path| path.display().to_string()).collect::<Vec<_>>())
      .unwrap_or_default()
  };

  let messages = vec![
    OllamaMessage {
      role: "system".to_string(),
      content: SCHEDULED_TASK_SYSTEM_PROMPT.to_string(),
      tool_calls: vec![],
      tool_name: None,
    },
    OllamaMessage { role: "user".to_string(), content: task.prompt.clone(), tool_calls: vec![], tool_name: None },
  ];

  let result = run_ollama_conversation(
    app_handle.clone(),
    SCHEDULED_TASK_MODEL.to_string(),
    messages,
    0,
    knowledge_paths.clone(),
    false,
    None,
    None,
    // Unattended background jobs default to local-only regardless of the
    // live UI's Privacy Mode state — SCHEDULED_TASK_MODEL is local today
    // anyway, but this stays safe even if that ever changes.
    true,
    Vec::new(),
  )
  .await;

  let note_body = match result {
    Ok(content) if !content.is_empty() => content,
    Ok(_) => "(This scheduled task produced no output.)".to_string(),
    Err(error) => format!("(This scheduled task failed: {error})"),
  };

  let title = format!("{} - {}", task.title, chrono::Local::now().format("%Y-%m-%d"));
  let _ = save_note_impl(&knowledge_paths, &title, &note_body);
}

const SCHEDULED_TASK_SYSTEM_PROMPT: &str =
  "You are Artemis, running an unattended scheduled task for the user. Complete the requested task using your available tools, then produce a clear, well-formatted Markdown result — this will be saved directly into the user's notes as-is.";

const SCHEDULED_TASK_CHECK_INTERVAL_SECS: u64 = 60;

async fn scheduled_task_loop(app_handle: tauri::AppHandle) {
  let mut interval = tokio::time::interval(std::time::Duration::from_secs(SCHEDULED_TASK_CHECK_INTERVAL_SECS));
  loop {
    interval.tick().await;

    let now = chrono::Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let (hour, minute) = (now.hour(), now.minute());

    let now_minutes_of_day = hour * 60 + minute;

    let due_tasks: Vec<ScheduledTask> = {
      let state = app_handle.state::<TaskSchedulerState>();
      let Ok(tasks) = state.tasks.lock() else { continue };
      tasks
        .iter()
        // >= its scheduled slot rather than an exact match — a delayed tick
        // (a slow check, the machine waking from sleep) still fires the task
        // later the same day instead of silently skipping to tomorrow.
        .filter(|task| task.hour * 60 + task.minute <= now_minutes_of_day && task.last_run_date.as_deref() != Some(today.as_str()))
        .cloned()
        .collect()
    };

    for task in due_tasks {
      run_scheduled_task(&app_handle, &task).await;

      let state = app_handle.state::<TaskSchedulerState>();
      if let Ok(mut tasks) = state.tasks.lock() {
        if let Some(stored) = tasks.iter_mut().find(|stored| stored.id == task.id) {
          stored.last_run_date = Some(today.clone());
        }
      }
      state.save();
    }
  }
}

// --- Tool registry ---------------------------------------------------------
// Every arm in execute_tool_call is a fixed, hand-written Rust function.
// Adding a tool means: one entry in tool_definitions(), one match arm below.
//
// SAFETY: no arm here may construct a reqwest::Client or call
// std::process::Command. Filesystem access is constrained per tool:
// read_file/update_note/delete_note all resolve through
// resolve_within_knowledge_paths, which canonicalizes the model-supplied path
// and rejects anything outside the user's configured knowledge folders
// (mirroring the hidden-folder filtering already used in collect_documents).
// save_note writes ONLY into a fixed "Artemis Notes" subfolder and ONLY via
// create_new(true), so it can create a file but cannot silently overwrite or
// delete one. update_note and delete_note CAN alter/remove an existing file,
// but only after request_confirmation() gets an explicit yes from the user —
// the default on timeout, a dropped channel, or a poisoned lock is always
// deny, never proceed. Any future tool must be individually re-audited
// against these invariants, not assumed safe by virtue of living here.
struct ToolDefinition {
  name: &'static str,
  description: &'static str,
  parameters: serde_json::Value,
}

fn tool_definitions() -> Vec<ToolDefinition> {
  vec![
    ToolDefinition {
      name: "search_knowledge_base",
      description: "Search the user's local notes and PDFs for passages relevant to a query. Only call this when the question needs the user's personal notes/library.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "query": { "type": "string", "description": "Search terms." } },
        "required": ["query"]
      }),
    },
    ToolDefinition {
      name: "save_note",
      description: "Create a brand-new note in the user's Obsidian vault. This can only ADD a new file — it can never overwrite or delete an existing one, so use it freely without asking first.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "title": { "type": "string", "description": "A short title for the note; used to name the file." },
          "content": { "type": "string", "description": "The full Markdown content of the note." }
        },
        "required": ["title", "content"]
      }),
    },
    ToolDefinition {
      name: "read_file",
      description: "Read the full contents of a specific file the user names, within their configured knowledge folders (notes or PDFs). Use this when the user references a specific file rather than asking a general question.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "path": { "type": "string", "description": "Full path to the file." } },
        "required": ["path"]
      }),
    },
    ToolDefinition {
      name: "update_note",
      description: "Overwrite the full contents of an existing file within the user's configured knowledge folders. The user will automatically be asked to approve this before anything changes — never skip calling this out of caution, the confirmation step handles that.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "Full path to the existing file to overwrite." },
          "new_content": { "type": "string", "description": "The complete new content for the file." }
        },
        "required": ["path", "new_content"]
      }),
    },
    ToolDefinition {
      name: "delete_note",
      description: "Permanently delete an existing file within the user's configured knowledge folders. The user will automatically be asked to approve this before anything is deleted.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "path": { "type": "string", "description": "Full path to the file to delete." } },
        "required": ["path"]
      }),
    },
    ToolDefinition {
      name: "schedule_daily_task",
      description: "Schedule a prompt to run automatically every day at a specific time. The result is written into the user's vault as a new note (via the same rules as save_note — it never overwrites anything).",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "title": { "type": "string", "description": "A short name for this recurring task." },
          "prompt": { "type": "string", "description": "The instruction to run each day, exactly as you'd want it phrased to yourself." },
          "hour": { "type": "integer", "description": "Hour of day, 0-23, local time." },
          "minute": { "type": "integer", "description": "Minute of the hour, 0-59." }
        },
        "required": ["title", "prompt", "hour", "minute"]
      }),
    },
    ToolDefinition {
      name: "list_scheduled_tasks",
      description: "List the user's currently scheduled daily tasks.",
      parameters: serde_json::json!({ "type": "object", "properties": {} }),
    },
    ToolDefinition {
      name: "cancel_scheduled_task",
      description: "Cancel a previously scheduled daily task, matched by its title, so it stops running.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "title": { "type": "string", "description": "Words from the scheduled task's title." } },
        "required": ["title"]
      }),
    },
    ToolDefinition {
      name: "add_task",
      description: "Add a new item to the user's personal to-do list, shown on the Daily tab. Use this whenever the user asks you to add, remember, or track a task for them.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "label": { "type": "string", "description": "A short description of the task." } },
        "required": ["label"]
      }),
    },
    ToolDefinition {
      name: "complete_task",
      description: "Mark an item on the user's to-do list as done, matched by its wording.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "label": { "type": "string", "description": "Words from the task to mark done." } },
        "required": ["label"]
      }),
    },
    ToolDefinition {
      name: "remove_task",
      description: "Remove an item from the user's to-do list entirely, matched by its wording.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "label": { "type": "string", "description": "Words from the task to remove." } },
        "required": ["label"]
      }),
    },
    ToolDefinition {
      name: "list_tasks",
      description: "List everything currently on the user's to-do list.",
      parameters: serde_json::json!({ "type": "object", "properties": {} }),
    },
    ToolDefinition {
      name: "remember_fact",
      description: "Save a durable fact or preference about the user for future conversations — their name, habits, people or projects they mention, ongoing situations. Only call this when the user shares something worth remembering long-term or explicitly asks you to remember it, not for one-off conversational details.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "fact": { "type": "string", "description": "The fact to remember, written plainly." } },
        "required": ["fact"]
      }),
    },
    ToolDefinition {
      name: "calculate_distance",
      description: "Calculate the distance and travel-planning band (nearby/plannable/far) from the user's configured location to a place or venue name, using free geocoding. Useful for judging whether an event or venue is a spontaneous option or needs to be planned as a bigger trip.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "destination": { "type": "string", "description": "A place, venue, or address to measure distance to." } },
        "required": ["destination"]
      }),
    },
    ToolDefinition {
      name: "check_website_health",
      description: "Check whether a website, API, or server is currently reachable, and how fast it responds. Useful for the user's own sites and services.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "url": { "type": "string", "description": "The URL or domain to check." } },
        "required": ["url"]
      }),
    },
    ToolDefinition {
      name: "save_skill",
      description: "Save a reusable procedure the user teaches you — a repeatable process like \"here's how I analyze competitors\" or \"here's my project launch checklist\". Call this when the user walks you through a multi-step process they want you to remember and reuse later, so they never have to re-explain it.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "name": { "type": "string", "description": "A short name for this procedure." },
          "procedure": { "type": "string", "description": "The full steps, written out plainly." }
        },
        "required": ["name", "procedure"]
      }),
    },
    ToolDefinition {
      name: "get_skill",
      description: "Retrieve a previously saved procedure by name so you can follow it. Call this when the user asks you to do something \"the way I showed you\" or references a named process.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "name": { "type": "string", "description": "Name or words from the procedure to retrieve." } },
        "required": ["name"]
      }),
    },
    ToolDefinition {
      name: "list_skills",
      description: "List every procedure the user has taught you so far.",
      parameters: serde_json::json!({ "type": "object", "properties": {} }),
    },
    ToolDefinition {
      name: "remove_skill",
      description: "Delete a previously saved procedure, matched by name.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "name": { "type": "string", "description": "Name or words from the procedure to remove." } },
        "required": ["name"]
      }),
    },
    ToolDefinition {
      name: "list_weekly_goals",
      description: "Show the user's weekly goals and this week's progress on each (reps done out of the weekly target). Read-only. Call this before answering questions about their goals, routines or how their week is going, and before changing them.",
      parameters: serde_json::json!({ "type": "object", "properties": {} }),
    },
    ToolDefinition {
      name: "update_goals",
      description: "Add, remove, rename, retarget or log progress on the user's goals — weekly goals (with a per-week target) and their long-term Goals document — by handing the change to Hermes (Iris), who owns those files. Describe the change in plain words, complete and self-contained (e.g. \"add a weekly goal: dance twice a week\", \"remove the yoga goal\", \"log that I did Japanese study today\"). The user is asked to approve before it runs; if they decline, don't retry or work around it. Never edit those files yourself.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "request": { "type": "string", "description": "The change to make, in plain words." } },
        "required": ["request"]
      }),
    },
    ToolDefinition {
      name: "call_hermes_agent",
      description: "Delegate a task to Hermes Agent — a separate AI agent already installed on this machine with its own tools and configured integrations (messaging platforms, Home Assistant, browser, shell). Use this only for things Artemis genuinely can't do natively. IMPORTANT: Hermes operates under its own permission model, not Artemis's — it may execute commands or use its own configured integrations autonomously once approved. The user is always asked to approve before this runs; if they decline, do not retry or work around it.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "prompt": { "type": "string", "description": "The task to hand off to Hermes, written as a complete, self-contained instruction." },
          "toolsets": { "type": "string", "description": "Optional comma-separated list of Hermes toolsets to restrict it to. Leave empty for its default toolset." }
        },
        "required": ["prompt"]
      }),
    },
    ToolDefinition {
      name: "start_hermes_run",
      description: "Start a durable, background task on Hermes Agent's gateway — unlike call_hermes_agent, this survives disconnects and can be checked on or steered later. Requires the Hermes gateway to be configured in Settings first. The user will be asked to approve before it runs.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "prompt": { "type": "string", "description": "The task to hand off to Hermes." } },
        "required": ["prompt"]
      }),
    },
    ToolDefinition {
      name: "check_hermes_run",
      description: "Check the status and output of a Hermes gateway run started with start_hermes_run.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "run_id": { "type": "string", "description": "The run_id returned by start_hermes_run." } },
        "required": ["run_id"]
      }),
    },
    ToolDefinition {
      name: "steer_hermes_run",
      description: "Send a mid-run course correction to a still-running Hermes gateway run. Only works while the run is still in progress. The user will be asked to approve, since this can redirect what Hermes does.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "run_id": { "type": "string", "description": "The run_id to steer." },
          "message": { "type": "string", "description": "The course-correction instruction." }
        },
        "required": ["run_id", "message"]
      }),
    },
    ToolDefinition {
      name: "stop_hermes_run",
      description: "Stop a still-running Hermes gateway run.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "run_id": { "type": "string", "description": "The run_id to stop." } },
        "required": ["run_id"]
      }),
    },
    ToolDefinition {
      name: "send_message_via_hermes",
      description: "Send a message on a messaging platform Hermes Agent is already configured for (Telegram, Discord, Slack, WhatsApp, Signal, etc.), via `hermes send`. Requires the user to have set up that platform in Hermes first (`hermes gateway setup`). The user will be asked to approve before it's actually sent — it's visible to other people, not just local.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "target": { "type": "string", "description": "Delivery target, e.g. \"telegram\", \"discord:#ops\", \"signal:+15551234567\"." },
          "message": { "type": "string", "description": "The message text to send." }
        },
        "required": ["target", "message"]
      }),
    },
    ToolDefinition {
      name: "query_iris_knowledge",
      description: "Search Iris's local knowledge base — the user's personal library (571 books) and Obsidian vault (7,076 notes) — for passages relevant to a query. Read-only, local-only, no network and no credentials. Use this for \"what do my books/notes say about X\" questions. Each hit includes a doc_id and page — pass those to get_iris_book_page for the exact verbatim text before quoting a book.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Search terms." },
          "corpus": { "type": "string", "description": "Restrict to \"books\" or \"notes\". Leave empty to search both." },
          "n": { "type": "integer", "description": "Max results to return (default 5, max 20)." }
        },
        "required": ["query"]
      }),
    },
    ToolDefinition {
      name: "get_iris_book_page",
      description: "Fetch one page of a book from Iris's knowledge base verbatim, by doc_id and page number from a prior query_iris_knowledge result. Always use this to verify a quote rather than reciting one from memory.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "doc_id": { "type": "string", "description": "The doc_id from a query_iris_knowledge search result." },
          "page": { "type": "integer", "description": "The page number." }
        },
        "required": ["doc_id", "page"]
      }),
    },
    ToolDefinition {
      name: "search_iris_code",
      description: "Search across the user's other project repositories (3,275 indexed source files) via Iris's knowledge base. Use this for questions about how something was implemented in one of the user's other codebases, not this one.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Search terms." },
          "project": { "type": "string", "description": "Optional project name to restrict the search to." }
        },
        "required": ["query"]
      }),
    },
    ToolDefinition {
      name: "get_iris_note",
      description: "Fetch the full content of a specific note from the user's Obsidian vault via Iris's knowledge base, by name or a distinctive substring.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "name": { "type": "string", "description": "The note's name or a distinctive substring of it." } },
        "required": ["name"]
      }),
    },
    ToolDefinition {
      name: "fetch_webpage",
      description: "Fetch a specific web page by URL and return its readable text content. Only for a URL you already have — this cannot search the web or browse generally.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "url": { "type": "string", "description": "The full URL to fetch." } },
        "required": ["url"]
      }),
    },
    ToolDefinition {
      name: "track_webpage",
      description: "Start watching a web page for changes — useful for competitor pricing pages, product listings, or any page the user wants monitored. Snapshots its current content; use check_webpage_changes later to see what changed.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "url": { "type": "string", "description": "The URL to watch." },
          "label": { "type": "string", "description": "A short name for this page (optional — defaults to the URL)." }
        },
        "required": ["url"]
      }),
    },
    ToolDefinition {
      name: "check_webpage_changes",
      description: "Re-fetch a previously tracked page and report whether it has changed since the last check, showing before/after content if so.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "page": { "type": "string", "description": "The label or URL of a previously tracked page." } },
        "required": ["page"]
      }),
    },
    ToolDefinition {
      name: "list_tracked_webpages",
      description: "List every web page currently being watched for changes.",
      parameters: serde_json::json!({ "type": "object", "properties": {} }),
    },
    ToolDefinition {
      name: "untrack_webpage",
      description: "Stop watching a page for changes.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "page": { "type": "string", "description": "The label or URL of the tracked page to remove." } },
        "required": ["page"]
      }),
    },
    ToolDefinition {
      name: "call_home_assistant_service",
      description: "Control a Home Assistant device or scene (e.g. domain \"light\", service \"turn_on\", entity_id \"light.living_room\"). Requires Home Assistant to be configured in Settings first. The user will be asked to approve before anything is actually triggered.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "domain": { "type": "string", "description": "Home Assistant domain, e.g. \"light\", \"switch\", \"scene\", \"lock\"." },
          "service": { "type": "string", "description": "Service to call, e.g. \"turn_on\", \"turn_off\", \"toggle\"." },
          "entity_id": { "type": "string", "description": "The specific entity to target, e.g. \"light.living_room\" (optional for some services)." }
        },
        "required": ["domain", "service"]
      }),
    },
    ToolDefinition {
      name: "list_home_assistant_entities",
      description: "List Home Assistant entities and their current state, optionally filtered by domain (e.g. \"light\"). Requires Home Assistant to be configured in Settings first.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "domain": { "type": "string", "description": "Optional domain filter, e.g. \"light\". Leave empty to list everything (capped)." } }
      }),
    },
    ToolDefinition {
      name: "list_github_issues",
      description: "List open issues (and pull requests) in a GitHub repository. Requires a GitHub personal access token configured in Settings.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "repo": { "type": "string", "description": "Repository as \"owner/name\", e.g. \"anthropics/claude-code\"." } },
        "required": ["repo"]
      }),
    },
    ToolDefinition {
      name: "create_github_issue",
      description: "Create a new issue in a GitHub repository. Requires a GitHub personal access token configured in Settings. The user will be asked to approve before it's actually created.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "repo": { "type": "string", "description": "Repository as \"owner/name\"." },
          "title": { "type": "string", "description": "Issue title." },
          "body": { "type": "string", "description": "Issue body/description." }
        },
        "required": ["repo", "title", "body"]
      }),
    },
    ToolDefinition {
      name: "check_github_pr_status",
      description: "Check the status of a specific pull request — open/closed/merged, mergeable, comment counts. Requires a GitHub personal access token configured in Settings.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "repo": { "type": "string", "description": "Repository as \"owner/name\"." },
          "pr_number": { "type": "integer", "description": "The pull request number." }
        },
        "required": ["repo", "pr_number"]
      }),
    },
    ToolDefinition {
      name: "comment_on_github_pr",
      description: "Post a comment on a GitHub pull request or issue. Requires a GitHub personal access token configured in Settings. The user will be asked to approve before it's actually posted.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "repo": { "type": "string", "description": "Repository as \"owner/name\"." },
          "pr_number": { "type": "integer", "description": "The pull request or issue number." },
          "comment": { "type": "string", "description": "The comment text." }
        },
        "required": ["repo", "pr_number", "comment"]
      }),
    },
    ToolDefinition {
      name: "web_search",
      description: "Look up a quick factual answer or summary for a well-known topic. This is NOT a full web search engine — it only returns direct-answer results (definitions, summaries), not ranked results for arbitrary queries. If it finds nothing, say so rather than guessing.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "query": { "type": "string", "description": "The search query." } },
        "required": ["query"]
      }),
    },
    ToolDefinition {
      name: "list_running_processes",
      description: "List the top processes on this machine by CPU usage. Useful for diagnosing why the computer feels slow.",
      parameters: serde_json::json!({ "type": "object", "properties": {} }),
    },
    ToolDefinition {
      name: "check_disk_space",
      description: "Check free disk space on all drives on this machine.",
      parameters: serde_json::json!({ "type": "object", "properties": {} }),
    },
    ToolDefinition {
      name: "check_windows_service_status",
      description: "Check whether a specific Windows service is running.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "name": { "type": "string", "description": "The Windows service name." } },
        "required": ["name"]
      }),
    },
    ToolDefinition {
      name: "restart_windows_service",
      description: "Restart a specific Windows service. The user will be asked to approve before anything is actually restarted.",
      parameters: serde_json::json!({
        "type": "object",
        "properties": { "name": { "type": "string", "description": "The Windows service name." } },
        "required": ["name"]
      }),
    },
  ]
}

fn tools_as_ollama_json() -> Vec<serde_json::Value> {
  tool_definitions()
    .into_iter()
    .map(|tool| {
      serde_json::json!({
        "type": "function",
        "function": { "name": tool.name, "description": tool.description, "parameters": tool.parameters }
      })
    })
    .collect()
}

// Picks the OneDrive Ma'at vault specifically (per the user's choice) when
// present, otherwise falls back to the first configured knowledge path — the
// shared root that both notes and uploaded documents live under.
fn resolve_knowledge_base_root(knowledge_paths: &[String]) -> Option<PathBuf> {
  knowledge_paths
    .iter()
    .find(|path| {
      let lower = path.to_lowercase();
      lower.contains("onedrive") && lower.contains("ma'at")
    })
    .or_else(|| knowledge_paths.first())
    .map(PathBuf::from)
}

fn resolve_notes_directory(knowledge_paths: &[String]) -> Option<PathBuf> {
  resolve_knowledge_base_root(knowledge_paths).map(|root| root.join("Artemis Notes"))
}

fn resolve_uploads_directory(knowledge_paths: &[String]) -> Option<PathBuf> {
  resolve_knowledge_base_root(knowledge_paths).map(|root| root.join("Artemis Uploads"))
}

// Splits "My Resume.pdf" into ("My Resume", ".pdf") so the stem can be
// sanitized while the extension (needed for the file to still open/index
// correctly) is preserved verbatim.
fn split_filename(name: &str) -> (String, String) {
  match name.rsplit_once('.') {
    Some((stem, extension)) if !extension.is_empty() && !stem.is_empty() => (stem.to_string(), format!(".{extension}")),
    _ => (name.to_string(), String::new()),
  }
}

// Same atomic create-only guarantee as write_note_create_only, but copies
// arbitrary bytes (any file type) instead of writing text content — used for
// documents the user uploads rather than notes Artemis authors itself.
fn copy_upload_create_only(directory: &Path, stem: &str, extension: &str, source_path: &Path) -> Result<PathBuf, String> {
  for attempt in 0..20 {
    let filename = if attempt == 0 { format!("{stem}{extension}") } else { format!("{stem}-{attempt}{extension}") };
    let path = directory.join(&filename);
    match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
      Ok(mut destination) => {
        let mut source = fs::File::open(source_path).map_err(|error| error.to_string())?;
        std::io::copy(&mut source, &mut destination).map_err(|error| error.to_string())?;
        return Ok(path);
      }
      Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(error) => return Err(error.to_string()),
    }
  }
  Err("Could not find an available filename after multiple attempts.".to_string())
}

// Copies a user-picked file (via the native file dialog) into the knowledge
// base and triggers a reindex so it's searchable right away rather than
// waiting for the next 6-hour rescan.
#[tauri::command]
async fn upload_document(app_handle: tauri::AppHandle, knowledge_paths: Vec<String>, source_path: String) -> Result<String, String> {
  let Some(uploads_dir) = resolve_uploads_directory(&knowledge_paths) else {
    return Err("No knowledge folder is configured to upload documents into.".to_string());
  };
  fs::create_dir_all(&uploads_dir).map_err(|error| error.to_string())?;

  let source = PathBuf::from(&source_path);
  let original_name = source.file_name().and_then(|name| name.to_str()).unwrap_or("upload").to_string();
  let (raw_stem, extension) = split_filename(&original_name);
  let stem = sanitize_filename_component(&raw_stem);

  let destination = copy_upload_create_only(&uploads_dir, &stem, &extension, &source)?;

  index_knowledge_base(app_handle, knowledge_paths).await?;

  Ok(format!("Uploaded \"{original_name}\" to {}", destination.display()))
}

fn sanitize_filename_component(input: &str) -> String {
  let cleaned: String = input
    .chars()
    .map(|character| if character.is_alphanumeric() || character == ' ' || character == '-' { character } else { ' ' })
    .collect();
  let slug = cleaned.split_whitespace().collect::<Vec<_>>().join("-");
  let slug: String = slug.chars().take(60).collect();
  if slug.is_empty() {
    "note".to_string()
  } else {
    slug
  }
}

// Atomic create-only write: create_new(true) fails outright if the file
// already exists rather than truncating it, so there's no check-then-write
// race and no path to accidentally overwriting something. On a name
// collision (e.g. two saves in the same second) this retries with a numeric
// suffix instead of ever touching the existing file.
fn write_note_create_only(directory: &Path, base_name: &str, content: &str) -> Result<PathBuf, String> {
  for attempt in 0..20 {
    let filename = if attempt == 0 { format!("{base_name}.md") } else { format!("{base_name}-{attempt}.md") };
    let path = directory.join(&filename);
    match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
      Ok(mut file) => {
        file.write_all(content.as_bytes()).map_err(|error| error.to_string())?;
        return Ok(path);
      }
      Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(error) => return Err(error.to_string()),
    }
  }
  Err("Could not find an available filename after multiple attempts.".to_string())
}

fn save_note_impl(knowledge_paths: &[String], title: &str, content: &str) -> Result<String, String> {
  let Some(notes_dir) = resolve_notes_directory(knowledge_paths) else {
    return Err("No knowledge folder is configured to save notes into.".to_string());
  };
  fs::create_dir_all(&notes_dir).map_err(|error| error.to_string())?;

  let slug = sanitize_filename_component(title);
  let timestamp = chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string();
  let path = write_note_create_only(&notes_dir, &format!("{timestamp}-{slug}"), content)?;
  Ok(format!("Saved note to {}", path.display()))
}

// Shared by read_file/update_note/delete_note: canonicalizes the requested
// path and rejects it unless it's a descendant of one of the user's
// configured knowledge folders. This is the one gate all filesystem-touching
// tools other than save_note go through. When is_cloud is true, a Secret
// folder is rejected here too — this is the one place that boundary needs to
// hold for all three tools, not three separate checks that could drift.
fn resolve_within_knowledge_paths(
  knowledge_paths: &[String],
  requested_path: &str,
  is_cloud: bool,
  secret_paths: &[String],
) -> Result<PathBuf, String> {
  let canonical_requested = fs::canonicalize(requested_path).map_err(|_| "File not found.".to_string())?;

  let allowed = knowledge_paths.iter().any(|root| {
    fs::canonicalize(root)
      .map(|canonical_root| canonical_requested.starts_with(canonical_root))
      .unwrap_or(false)
  });

  if !allowed {
    return Err("That path is outside your configured knowledge folders.".to_string());
  }

  if is_cloud {
    let secret_roots = canonical_secret_roots(secret_paths);
    if secret_roots.iter().any(|root| canonical_requested.starts_with(root)) {
      return Err("That file is in a folder marked Secret — only local models can access it, regardless of Privacy Mode.".to_string());
    }
  }

  Ok(canonical_requested)
}

fn read_file_impl(knowledge_paths: &[String], requested_path: &str, is_cloud: bool, secret_paths: &[String]) -> Result<String, String> {
  let path = resolve_within_knowledge_paths(knowledge_paths, requested_path, is_cloud, secret_paths)?;
  extract_document_text(&path).ok_or_else(|| "Could not read or extract that file.".to_string())
}

fn update_note_impl(
  knowledge_paths: &[String],
  requested_path: &str,
  new_content: &str,
  is_cloud: bool,
  secret_paths: &[String],
) -> Result<String, String> {
  let path = resolve_within_knowledge_paths(knowledge_paths, requested_path, is_cloud, secret_paths)?;
  fs::write(&path, new_content).map_err(|error| error.to_string())?;
  Ok(format!("Updated {}", path.display()))
}

fn delete_note_impl(knowledge_paths: &[String], requested_path: &str, is_cloud: bool, secret_paths: &[String]) -> Result<String, String> {
  let path = resolve_within_knowledge_paths(knowledge_paths, requested_path, is_cloud, secret_paths)?;
  fs::remove_file(&path).map_err(|error| error.to_string())?;
  Ok(format!("Deleted {}", path.display()))
}

// --- Confirmation gate for destructive tools --------------------------------
// update_note/delete_note must never proceed without the user explicitly
// clicking Approve in the running app. A pending confirmation is a oneshot
// channel keyed by a unique id: the tool call blocks on the receiver (bounded
// by a timeout) while the frontend shows an approve/deny prompt; clicking
// either resolves the channel via `respond_to_confirmation`. Any failure mode
// (timeout, dropped sender, poisoned lock) resolves to `false` — deny is
// always the safe default, never approve-by-default.
struct ConfirmationState {
  pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
}

#[derive(Debug, Serialize, Clone)]
struct OllamaConfirmRequestEvent {
  request_id: u64,
  confirmation_id: String,
  action: String,
  details: String,
}

static CONFIRMATION_COUNTER: AtomicU64 = AtomicU64::new(1);
const CONFIRMATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

// Removes the pending entry on every exit path — including this future being
// dropped mid-await when the user stops the request — so an aborted request
// can't leave an orphaned sender in the map. A stopped request is a denial by
// construction: nothing after the await ever runs.
struct PendingConfirmationGuard<'a> {
  app_handle: &'a tauri::AppHandle,
  confirmation_id: String,
}

impl Drop for PendingConfirmationGuard<'_> {
  fn drop(&mut self) {
    if let Ok(mut pending) = self.app_handle.state::<ConfirmationState>().pending.lock() {
      pending.remove(&self.confirmation_id);
    }
  }
}

async fn request_confirmation(app_handle: &tauri::AppHandle, request_id: u64, action: &str, details: &str) -> bool {
  let confirmation_id = format!("confirm-{}", CONFIRMATION_COUNTER.fetch_add(1, Ordering::Relaxed));
  let (sender, receiver) = tokio::sync::oneshot::channel();

  {
    let state = app_handle.state::<ConfirmationState>();
    match state.pending.lock() {
      Ok(mut pending) => {
        pending.insert(confirmation_id.clone(), sender);
      }
      Err(_) => return false,
    };
  }
  let _pending_guard = PendingConfirmationGuard { app_handle, confirmation_id: confirmation_id.clone() };

  append_audit_log(app_handle, request_id, "confirmation_requested", &format!("{action}: {details}"));

  let _ = app_handle.emit(
    "ollama-confirm-request",
    OllamaConfirmRequestEvent {
      request_id,
      confirmation_id: confirmation_id.clone(),
      action: action.to_string(),
      details: details.to_string(),
    },
  );

  matches!(tokio::time::timeout(CONFIRMATION_TIMEOUT, receiver).await, Ok(Ok(true)))
}

#[tauri::command]
fn respond_to_confirmation(app: tauri::AppHandle, confirmation_id: String, approved: bool) -> Result<(), String> {
  let state = app.state::<ConfirmationState>();
  let sender = state
    .pending
    .lock()
    .map_err(|_| "Confirmation state unavailable".to_string())?
    .remove(&confirmation_id);

  match sender {
    Some(sender) => {
      let _ = sender.send(approved);
      Ok(())
    }
    None => Err("No pending confirmation with that id (it may have already timed out).".to_string()),
  }
}

async fn execute_tool_call(
  app_handle: &tauri::AppHandle,
  request_id: u64,
  call: &OllamaToolCall,
  knowledge_paths: &[String],
  is_cloud: bool,
  secret_paths: &[String],
) -> String {
  // Treat model-supplied arguments as untrusted input throughout, even though
  // this is a single-user local app — coerce defensively rather than unwrap.
  let arg_str = |key: &str| call.function.arguments.get(key).and_then(|value| value.as_str()).unwrap_or("").to_string();
  let arg_u32 = |key: &str| call.function.arguments.get(key).and_then(|value| value.as_u64()).unwrap_or(0) as u32;

  match call.function.name.as_str() {
    "search_knowledge_base" => {
      let query = arg_str("query");
      match get_knowledge_context_impl(app_handle, query, knowledge_paths.to_vec(), is_cloud, secret_paths) {
        Ok(context) if !context.is_empty() => context,
        Ok(_) => "No relevant results found in the knowledge base.".to_string(),
        Err(error) => format!("Knowledge base search failed: {error}"),
      }
    }
    "save_note" => {
      let title = arg_str("title");
      let content = arg_str("content");
      match save_note_impl(knowledge_paths, &title, &content) {
        Ok(message) => message,
        Err(error) => format!("Failed to save note: {error}"),
      }
    }
    "read_file" => {
      let path = arg_str("path");
      match read_file_impl(knowledge_paths, &path, is_cloud, secret_paths) {
        Ok(content) => content,
        Err(error) => format!("Could not read file: {error}"),
      }
    }
    "update_note" => {
      let path = arg_str("path");
      let new_content = arg_str("new_content");
      let details = format!("Overwrite \"{path}\" with new content?");
      if !request_confirmation(app_handle, request_id, "update_note", &details).await {
        append_audit_log(app_handle, request_id, "confirmation_denied", &format!("update_note path={path}"));
        return "The user did not approve overwriting this file, so it was not changed.".to_string();
      }
      append_audit_log(app_handle, request_id, "confirmation_approved", &format!("update_note path={path}"));
      match update_note_impl(knowledge_paths, &path, &new_content, is_cloud, secret_paths) {
        Ok(message) => message,
        Err(error) => format!("Failed to update note: {error}"),
      }
    }
    "delete_note" => {
      let path = arg_str("path");
      let details = format!("Delete \"{path}\"? This cannot be undone.");
      if !request_confirmation(app_handle, request_id, "delete_note", &details).await {
        append_audit_log(app_handle, request_id, "confirmation_denied", &format!("delete_note path={path}"));
        return "The user did not approve deleting this file, so it was not deleted.".to_string();
      }
      append_audit_log(app_handle, request_id, "confirmation_approved", &format!("delete_note path={path}"));
      match delete_note_impl(knowledge_paths, &path, is_cloud, secret_paths) {
        Ok(message) => message,
        Err(error) => format!("Failed to delete note: {error}"),
      }
    }
    "schedule_daily_task" => {
      let title = arg_str("title");
      let prompt = arg_str("prompt");
      let hour = arg_u32("hour");
      let minute = arg_u32("minute");
      let state = app_handle.state::<TaskSchedulerState>();
      match schedule_daily_task_impl(&state, &title, &prompt, hour, minute) {
        Ok(message) => message,
        Err(error) => format!("Failed to schedule task: {error}"),
      }
    }
    "list_scheduled_tasks" => {
      let state = app_handle.state::<TaskSchedulerState>();
      list_scheduled_tasks_impl(&state)
    }
    "cancel_scheduled_task" => {
      let title = arg_str("title");
      let state = app_handle.state::<TaskSchedulerState>();
      cancel_scheduled_task_impl(&state, &title)
    }
    "add_task" => {
      let label = arg_str("label");
      if label.trim().is_empty() {
        "Error: a task label is required.".to_string()
      } else {
        let state = app_handle.state::<TodoState>();
        let item = add_todo_impl(&state, label.trim());
        format!("Added task \"{}\".", item.label)
      }
    }
    "complete_task" => {
      let label = arg_str("label");
      let state = app_handle.state::<TodoState>();
      complete_todo_by_label_impl(&state, &label, true)
    }
    "remove_task" => {
      let label = arg_str("label");
      let state = app_handle.state::<TodoState>();
      remove_todo_by_label_impl(&state, &label)
    }
    "list_tasks" => {
      let state = app_handle.state::<TodoState>();
      list_todos_impl(&state)
    }
    "remember_fact" => {
      let fact = arg_str("fact");
      if fact.trim().is_empty() {
        "Error: nothing to remember — the fact was empty.".to_string()
      } else {
        append_user_memory(app_handle, fact.trim());
        "Got it — I'll remember that.".to_string()
      }
    }
    "calculate_distance" => {
      let destination = arg_str("destination");
      calculate_distance_impl(app_handle, &destination).await
    }
    "check_website_health" => {
      let url = arg_str("url");
      if url.trim().is_empty() {
        "Error: a URL is required.".to_string()
      } else {
        check_website_health_impl(url.trim()).await
      }
    }
    "save_skill" => {
      let name = arg_str("name");
      let procedure = arg_str("procedure");
      if name.trim().is_empty() || procedure.trim().is_empty() {
        "Error: both a name and the procedure steps are required.".to_string()
      } else {
        let state = app_handle.state::<SkillsState>();
        save_skill_impl(&state, name.trim(), procedure.trim())
      }
    }
    "get_skill" => {
      let name = arg_str("name");
      let state = app_handle.state::<SkillsState>();
      get_skill_impl(&state, &name)
    }
    "list_skills" => {
      let state = app_handle.state::<SkillsState>();
      list_skills_impl(&state)
    }
    "remove_skill" => {
      let name = arg_str("name");
      let state = app_handle.state::<SkillsState>();
      remove_skill_impl(&state, &name)
    }
    "list_weekly_goals" => match get_weekly_goals() {
      Ok(goals) => weekly_goals_summary(&goals),
      Err(error) => error,
    },
    "update_goals" => {
      let request = arg_str("request");
      if request.trim().is_empty() {
        "Error: describe the change to make.".to_string()
      } else {
        let details = format!("Ask Hermes to change your goals?\n\n\"{request}\"");
        if !request_confirmation(app_handle, request_id, "update_goals", &details).await {
          append_audit_log(app_handle, request_id, "confirmation_denied", "update_goals");
          "The user did not approve changing their goals, so nothing was changed.".to_string()
        } else {
          append_audit_log(app_handle, request_id, "confirmation_approved", &format!("update_goals request={request}"));
          ask_hermes_now(app_handle, &goals_update_prompt(&request)).await
        }
      }
    }
    "call_hermes_agent" => {
      let prompt = arg_str("prompt");
      let toolsets = arg_str("toolsets");
      if prompt.trim().is_empty() {
        "Error: a prompt is required.".to_string()
      } else {
        let details = format!(
          "Delegate this to Hermes Agent — a separate agent with its own tools and permissions, which may act autonomously once approved?\n\n\"{prompt}\""
        );
        if !request_confirmation(app_handle, request_id, "call_hermes_agent", &details).await {
          append_audit_log(app_handle, request_id, "confirmation_denied", "call_hermes_agent");
          "The user did not approve delegating this to Hermes Agent.".to_string()
        } else {
          append_audit_log(app_handle, request_id, "confirmation_approved", "call_hermes_agent");
          call_hermes_agent_impl(&prompt, &toolsets).await
        }
      }
    }
    "query_iris_knowledge" => {
      let query = arg_str("query");
      let corpus = arg_str("corpus");
      let n = arg_u32("n");
      query_iris_knowledge_impl(&query, &corpus, n, is_cloud, secret_paths).await
    }
    "get_iris_book_page" => {
      let doc_id = arg_str("doc_id");
      let page = arg_u32("page");
      get_iris_book_page_impl(&doc_id, page).await
    }
    "search_iris_code" => {
      let query = arg_str("query");
      let project = arg_str("project");
      search_iris_code_impl(&query, &project).await
    }
    "get_iris_note" => {
      let name = arg_str("name");
      get_iris_note_impl(&name).await
    }
    "start_hermes_run" => {
      let prompt = arg_str("prompt");
      if prompt.trim().is_empty() {
        "Error: a prompt is required.".to_string()
      } else {
        let details = format!("Start a Hermes gateway run — a separate agent with its own tools and permissions?\n\n\"{prompt}\"");
        if !request_confirmation(app_handle, request_id, "start_hermes_run", &details).await {
          append_audit_log(app_handle, request_id, "confirmation_denied", "start_hermes_run");
          "The user did not approve starting this Hermes run.".to_string()
        } else {
          append_audit_log(app_handle, request_id, "confirmation_approved", "start_hermes_run");
          start_hermes_run_impl(app_handle, &prompt).await
        }
      }
    }
    "check_hermes_run" => {
      let run_id = arg_str("run_id");
      check_hermes_run_impl(app_handle, &run_id).await
    }
    "steer_hermes_run" => {
      let run_id = arg_str("run_id");
      let message = arg_str("message");
      let details = format!("Steer Hermes run {run_id} with a new instruction?\n\n\"{message}\"");
      if !request_confirmation(app_handle, request_id, "steer_hermes_run", &details).await {
        append_audit_log(app_handle, request_id, "confirmation_denied", &format!("steer_hermes_run run_id={run_id}"));
        "The user did not approve steering this run.".to_string()
      } else {
        append_audit_log(app_handle, request_id, "confirmation_approved", &format!("steer_hermes_run run_id={run_id}"));
        steer_hermes_run_impl(app_handle, &run_id, &message).await
      }
    }
    "stop_hermes_run" => {
      let run_id = arg_str("run_id");
      stop_hermes_run_impl(app_handle, &run_id).await
    }
    "send_message_via_hermes" => {
      let target = arg_str("target");
      let message = arg_str("message");
      if target.trim().is_empty() || message.trim().is_empty() {
        "Error: both a target and a message are required.".to_string()
      } else {
        let details = format!("Send this message via Hermes to \"{target}\"?\n\n\"{message}\"");
        if !request_confirmation(app_handle, request_id, "send_message_via_hermes", &details).await {
          append_audit_log(app_handle, request_id, "confirmation_denied", &format!("send_message_via_hermes target={target}"));
          "The user did not approve sending this message.".to_string()
        } else {
          append_audit_log(app_handle, request_id, "confirmation_approved", &format!("send_message_via_hermes target={target}"));
          send_message_via_hermes_impl(&target, &message).await
        }
      }
    }
    "fetch_webpage" => {
      let url = arg_str("url");
      if url.trim().is_empty() {
        "Error: a URL is required.".to_string()
      } else {
        fetch_webpage_impl(url.trim()).await
      }
    }
    "track_webpage" => {
      let url = arg_str("url");
      let label = arg_str("label");
      if url.trim().is_empty() {
        "Error: a URL is required.".to_string()
      } else {
        let state = app_handle.state::<TrackedPagesState>();
        track_webpage_impl(&state, url.trim(), &label).await
      }
    }
    "check_webpage_changes" => {
      let page = arg_str("page");
      let state = app_handle.state::<TrackedPagesState>();
      check_webpage_changes_impl(&state, &page).await
    }
    "list_tracked_webpages" => {
      let state = app_handle.state::<TrackedPagesState>();
      list_tracked_pages_impl(&state)
    }
    "untrack_webpage" => {
      let page = arg_str("page");
      let state = app_handle.state::<TrackedPagesState>();
      untrack_webpage_impl(&state, &page)
    }
    "call_home_assistant_service" => {
      let domain = arg_str("domain");
      let service = arg_str("service");
      let entity_id = arg_str("entity_id");
      let target = if entity_id.trim().is_empty() { String::new() } else { format!(" on {}", entity_id.trim()) };
      let details = format!("Call Home Assistant service {domain}.{service}{target}?");
      if !request_confirmation(app_handle, request_id, "call_home_assistant_service", &details).await {
        append_audit_log(app_handle, request_id, "confirmation_denied", &format!("home_assistant {domain}.{service}"));
        return "The user did not approve this Home Assistant action, so nothing was changed.".to_string();
      }
      append_audit_log(app_handle, request_id, "confirmation_approved", &format!("home_assistant {domain}.{service}"));
      call_home_assistant_service_impl(app_handle, &domain, &service, &entity_id).await
    }
    "list_home_assistant_entities" => {
      let domain = arg_str("domain");
      list_home_assistant_entities_impl(app_handle, &domain).await
    }
    "list_github_issues" => {
      let repo = arg_str("repo");
      list_github_issues_impl(app_handle, &repo).await
    }
    "create_github_issue" => {
      let repo = arg_str("repo");
      let title = arg_str("title");
      let body = arg_str("body");
      let details = format!("Create issue \"{title}\" in {repo}?");
      if !request_confirmation(app_handle, request_id, "create_github_issue", &details).await {
        append_audit_log(app_handle, request_id, "confirmation_denied", &format!("create_github_issue repo={repo}"));
        return "The user did not approve creating this issue, so it was not created.".to_string();
      }
      append_audit_log(app_handle, request_id, "confirmation_approved", &format!("create_github_issue repo={repo}"));
      create_github_issue_impl(app_handle, &repo, &title, &body).await
    }
    "check_github_pr_status" => {
      let repo = arg_str("repo");
      let pr_number = arg_u32("pr_number");
      check_github_pr_status_impl(app_handle, &repo, pr_number as u64).await
    }
    "comment_on_github_pr" => {
      let repo = arg_str("repo");
      let pr_number = arg_u32("pr_number");
      let comment = arg_str("comment");
      let details = format!("Post a comment on {repo}#{pr_number}?");
      if !request_confirmation(app_handle, request_id, "comment_on_github_pr", &details).await {
        append_audit_log(app_handle, request_id, "confirmation_denied", &format!("comment_on_github_pr repo={repo}#{pr_number}"));
        return "The user did not approve posting this comment, so it was not posted.".to_string();
      }
      append_audit_log(app_handle, request_id, "confirmation_approved", &format!("comment_on_github_pr repo={repo}#{pr_number}"));
      comment_on_github_pr_impl(app_handle, &repo, pr_number as u64, &comment).await
    }
    "web_search" => {
      let query = arg_str("query");
      web_search_impl(&query).await
    }
    "list_running_processes" => list_running_processes_impl(),
    "check_disk_space" => check_disk_space_impl(),
    "check_windows_service_status" => {
      let name = arg_str("name");
      check_windows_service_status_impl(&name)
    }
    "restart_windows_service" => {
      let name = arg_str("name");
      let details = format!("Restart the \"{name}\" Windows service?");
      if !request_confirmation(app_handle, request_id, "restart_windows_service", &details).await {
        append_audit_log(app_handle, request_id, "confirmation_denied", &format!("restart_windows_service name={name}"));
        return "The user did not approve restarting this service, so it was not restarted.".to_string();
      }
      append_audit_log(app_handle, request_id, "confirmation_approved", &format!("restart_windows_service name={name}"));
      restart_windows_service_impl(&name).await
    }
    unknown => format!("Error: unknown tool \"{unknown}\" — no such tool is available."),
  }
}

// --- Daily dashboard: news + weather -----------------------------------
// Deliberately independent of Privacy Mode: these calls only ever read
// public RSS/weather data and never carry a user prompt or any local
// content, so they're a different category of network activity than the
// Ollama cloud gate above and are not blocked by it.
// A story without a picture isn't shown at all, so `image` is always present.
// `image_width` is the largest width the feed declared for it, when it said —
// the dashboard uses it to pick a sharp image for the big top-story slot.
#[derive(Serialize, Clone)]
struct NewsItem {
  title: String,
  link: String,
  source: String,
  category: String,
  image: String,
  image_width: Option<u32>,
  summary: String,
}

// (feed URL, source label, category, max items to take from this feed)
// Every one of these was checked to be plain RSS 2.0 (the reader below doesn't
// speak Atom) and to carry a real image on its items. Categories follow the
// interests in the handoff: politics and world, technology and science, art,
// books and ideas, film, history and culture, and the outdoors.
const NEWS_FEEDS: &[(&str, &str, &str, usize)] = &[
  ("https://feeds.npr.org/1014/rss.xml", "NPR", "Politics", 4),
  ("https://www.theguardian.com/world/rss", "The Guardian", "World", 4),
  ("https://feeds.arstechnica.com/arstechnica/index", "Ars Technica", "Technology", 4),
  ("https://www.wired.com/feed/rss", "Wired", "Technology", 4),
  ("https://www.theguardian.com/science/rss", "The Guardian", "Science", 3),
  ("https://www.nasa.gov/feed/", "NASA", "Science", 3),
  ("https://www.thisiscolossal.com/feed/", "Colossal", "Art", 4),
  ("https://hyperallergic.com/feed/", "Hyperallergic", "Art", 4),
  ("https://www.theguardian.com/artanddesign/rss", "The Guardian", "Art", 3),
  ("https://lithub.com/feed/", "Literary Hub", "Books", 3),
  ("https://www.theguardian.com/books/rss", "The Guardian", "Books", 3),
  ("https://aeon.co/feed.rss", "Aeon", "Ideas", 3),
  ("https://comicbook.com/category/marvel/feed/", "ComicBook.com", "Film", 3),
  ("https://comicbook.com/category/dc/feed/", "ComicBook.com", "Film", 3),
  ("https://collider.com/feed/", "Collider", "Film", 3),
  ("https://www.theguardian.com/film/rss", "The Guardian", "Film", 3),
  ("https://www.smithsonianmag.com/rss/latest_articles/", "Smithsonian", "History", 3),
  ("https://www.atlasobscura.com/feeds/latest", "Atlas Obscura", "Culture", 4),
  ("https://www.outdoorlife.com/feed/", "Outdoor Life", "Outdoors", 4),
];

// One slow or dead feed must not hold up the whole dashboard.
const FEED_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

// FirstShowing posts almost nothing but trailers, each with a poster image —
// a keyless stand-in for a trailers API (TMDB and friends all need a key).
const TRAILER_FEED: (&str, &str) = ("https://www.firstshowing.net/feed/", "FirstShowing");

// Feed text arrives as HTML fragments with entities still encoded. Strip tags
// first and decode entities second — the other order would turn an escaped
// "&lt;b&gt;" into a real tag that then gets stripped along with its content.
fn strip_html_tags(input: &str) -> String {
  let mut output = String::with_capacity(input.len());
  let mut in_tag = false;
  for character in input.chars() {
    match character {
      '<' => in_tag = true,
      '>' => in_tag = false,
      _ if !in_tag => output.push(character),
      _ => {}
    }
  }
  output
}

fn decode_html_entities(input: &str) -> String {
  let mut output = String::with_capacity(input.len());
  let mut rest = input;
  while let Some(start) = rest.find('&') {
    output.push_str(&rest[..start]);
    let after = &rest[start + 1..];
    let decoded = after.find(';').filter(|&end| end <= 10).and_then(|end| {
      let entity = &after[..end];
      let character = match entity {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        _ => entity.strip_prefix('#').and_then(|number| {
          match number.strip_prefix('x').or_else(|| number.strip_prefix('X')) {
            Some(hex) => u32::from_str_radix(hex, 16).ok(),
            None => number.parse::<u32>().ok(),
          }
          .and_then(char::from_u32)
        }),
      };
      character.map(|character| (character, end))
    });
    match decoded {
      Some((character, end)) => {
        output.push(character);
        rest = &after[end + 1..];
      }
      None => {
        output.push('&');
        rest = after;
      }
    }
  }
  output.push_str(rest);
  output
}

// A short, plain-text teaser for a feed item: tags stripped, entities decoded,
// WordPress's "The post X appeared first on Y." footer removed, and cut at a
// word boundary.
fn feed_summary(raw: &str) -> String {
  const MAX_CHARS: usize = 230;
  let text = normalize_whitespace(&decode_html_entities(&strip_html_tags(raw)));
  let text = match text.find("The post ") {
    Some(index) => text[..index].trim().to_string(),
    None => text,
  };
  // The Guardian and others end their teaser with a "Continue reading..." link.
  let text = match text.to_ascii_lowercase().find("continue reading") {
    Some(index) => text[..index].trim().to_string(),
    None => text,
  };
  if text.chars().count() <= MAX_CHARS {
    return text;
  }
  let cut: String = text.chars().take(MAX_CHARS).collect();
  let trimmed = match cut.rfind(' ') {
    Some(index) => &cut[..index],
    None => &cut,
  };
  format!("{}…", trimmed.trim_end_matches(|c: char| c.is_ascii_punctuation() || c.is_whitespace()))
}

// Extracts the value of an HTML attribute (double- or single-quoted) from a
// single tag, matching only when the name is preceded by whitespace so that
// asking for "src" never returns "data-src".
fn html_attribute(tag: &str, name: &str) -> Option<String> {
  let lower = tag.to_ascii_lowercase();
  let needle = format!("{name}=");
  let mut from = 0;
  while let Some(found) = lower[from..].find(&needle) {
    let position = from + found;
    let preceded_by_space = position > 0 && lower.as_bytes()[position - 1].is_ascii_whitespace();
    let value_start = position + needle.len();
    if preceded_by_space {
      let quote = tag[value_start..].chars().next().filter(|c| *c == '"' || *c == '\'')?;
      let body = &tag[value_start + 1..];
      return body.find(quote).map(|end| body[..end].to_string());
    }
    from = value_start;
  }
  None
}

// A 1x1 tracking beacon is not a story picture. NPR's audio and podcast items
// carry only one — "npr-rss-pixel.png" — which is exactly how a blank
// thumbnail once ended up on the dashboard.
fn is_tracking_image(url: &str) -> bool {
  let lower = url.to_ascii_lowercase();
  ["tracking", "pixel", "1x1", "spacer", "beacon", "blank.gif", "/analytics"].iter().any(|marker| lower.contains(marker))
}

// NPR serves each photo at its original size (routinely 6000+ px and several
// MB) unless asked otherwise; its image service honors a smaller resize, which
// returns the same picture at a fraction of the weight. Returns the URL and
// the width it now asks for.
fn shrink_brightspot_url(url: &str) -> Option<(String, u32)> {
  const TARGET_WIDTH: u32 = 1200;
  if !url.contains("brightspotcdn.com") {
    return None;
  }
  let start = url.find("/resize/")?;
  let rest = &url[start + "/resize/".len()..];
  let end = rest.find("!/")?;
  let (width, height) = rest[..end].split_once('x')?;
  let (width, height): (u32, u32) = (width.parse().ok()?, height.parse().ok()?);
  if width <= TARGET_WIDTH {
    return None;
  }
  let new_height = (TARGET_WIDTH as f64 * height as f64 / width as f64).round() as u32;
  Some((format!("{}/resize/{}x{}!/{}", &url[..start], TARGET_WIDTH, new_height, &rest[end + 2..]), TARGET_WIDTH))
}

fn first_image_in_html(html: &str) -> Option<String> {
  let lower = html.to_ascii_lowercase();
  let mut from = 0;
  while let Some(found) = lower[from..].find("<img") {
    let tag_start = from + found;
    let tag_end = lower[tag_start..].find('>').map(|end| tag_start + end)?;
    if let Some(src) = html_attribute(&html[tag_start..tag_end], "src") {
      let src = decode_html_entities(&src);
      if src.starts_with("http") && !is_tracking_image(&src) {
        return Some(src);
      }
    }
    from = tag_end;
  }
  None
}

// Feeds disagree on where an image lives, so try each convention in order of
// how deliberate it is: media:content/thumbnail (taking the widest declared),
// an image enclosure, then the first real <img> inside the body. Returns the
// URL and, when the feed said, its width.
fn feed_item_image(item: &rss::Item) -> Option<(String, Option<u32>)> {
  let mut best: Option<(String, Option<u32>)> = None;
  if let Some(media) = item.extensions().get("media") {
    for key in ["content", "thumbnail"] {
      for extension in media.get(key).into_iter().flatten() {
        let attributes = extension.attrs();
        let is_image = attributes.get("medium").map(|medium| medium == "image").unwrap_or(true)
          && attributes.get("type").map(|kind| kind.starts_with("image/")).unwrap_or(true);
        let Some(url) = attributes.get("url").filter(|url| is_image && url.starts_with("http") && !is_tracking_image(url)) else {
          continue;
        };
        let width = attributes.get("width").and_then(|width| width.parse::<u32>().ok());
        let wider = match &best {
          None => true,
          Some((_, best_width)) => width.unwrap_or(0) > best_width.unwrap_or(0),
        };
        if wider {
          best = Some((url.clone(), width));
        }
      }
    }
  }
  if best.is_none() {
    if let Some(enclosure) = item.enclosure() {
      if enclosure.mime_type().starts_with("image/") && enclosure.url().starts_with("http") && !is_tracking_image(enclosure.url()) {
        best = Some((enclosure.url().to_string(), None));
      }
    }
  }
  if best.is_none() {
    best = item
      .content()
      .and_then(first_image_in_html)
      .or_else(|| item.description().and_then(first_image_in_html))
      .map(|url| (url, None));
  }
  best.map(|(url, width)| match shrink_brightspot_url(&url) {
    Some((smaller, smaller_width)) => (smaller, Some(smaller_width)),
    None => (url, width),
  })
}

async fn fetch_feed_items(url: &str, source: &str, category: &str, limit: usize, title_must_contain: Option<&str>) -> Vec<NewsItem> {
  let client = http_client();
  let Ok(response) = client.get(url).header("User-Agent", "Artemis/1.0").timeout(FEED_TIMEOUT).send().await else {
    return Vec::new();
  };
  if !response.status().is_success() {
    return Vec::new();
  }
  let Ok(bytes) = response.bytes().await else { return Vec::new() };
  let Ok(channel) = rss::Channel::read_from(&bytes[..]) else { return Vec::new() };

  channel
    .items()
    .iter()
    .filter_map(|item| {
      let title = normalize_whitespace(&decode_html_entities(item.title()?));
      let link = item.link()?.to_string();
      if let Some(needle) = title_must_contain {
        if !title.to_lowercase().contains(needle) {
          return None;
        }
      }
      // No usable picture, no story.
      let (image, image_width) = feed_item_image(item)?;
      let summary = item.description().or_else(|| item.content()).map(feed_summary).unwrap_or_default();
      Some(NewsItem { title, link: link.trim().to_string(), source: source.to_string(), category: category.to_string(), image, image_width, summary })
    })
    .take(limit)
    .collect()
}

// Feeds are independent, so fetch them concurrently — the slowest one sets
// the pace instead of all four adding up.
#[tauri::command]
async fn fetch_daily_news() -> Result<Vec<NewsItem>, String> {
  let fetches = NEWS_FEEDS.iter().map(|(url, source, category, limit)| fetch_feed_items(url, source, category, *limit, None));
  Ok(futures_util::future::join_all(fetches).await.into_iter().flatten().collect())
}

// --- Local news ------------------------------------------------------------
// Local outlets only make sense near the place they cover, so each set of feeds
// is tied to a circle on the map and the section stays empty everywhere else.
// Same rules as NEWS_FEEDS: plain RSS 2.0 with a real picture on the items
// (all checked live). Decaturish, the closest neighbourhood paper to Tucker,
// answers every request with a 429, so it isn't here.
struct LocalNewsArea {
  latitude: f64,
  longitude: f64,
  radius_miles: f64,
  // (feed url, source name, items to take)
  feeds: &'static [(&'static str, &'static str, usize)],
}

const LOCAL_NEWS_AREAS: &[LocalNewsArea] = &[LocalNewsArea {
  // Metro Atlanta, Tucker and Decatur included.
  latitude: 33.749,
  longitude: -84.388,
  radius_miles: 60.0,
  feeds: &[
    ("https://roughdraftatlanta.com/feed/", "Rough Draft Atlanta", 3),
    ("https://www.atlantamagazine.com/feed/", "Atlanta Magazine", 3),
    ("https://www.11alive.com/feeds/syndication/rss/news/local", "11Alive", 3),
    ("https://www.wsbtv.com/arc/outboundfeeds/rss/category/news/local/?outputType=xml", "WSB-TV", 3),
    ("https://www.atlantanewsfirst.com/arc/outboundfeeds/rss/?outputType=xml", "Atlanta News First", 3),
    ("https://atlanta.urbanize.city/rss.xml", "Urbanize Atlanta", 3),
  ],
}];

fn local_news_area(latitude: f64, longitude: f64) -> Option<&'static LocalNewsArea> {
  LOCAL_NEWS_AREAS.iter().find(|area| haversine_miles(latitude, longitude, area.latitude, area.longitude) <= area.radius_miles)
}

// Follows the location the user has set, like the weather does.
#[tauri::command]
async fn fetch_local_news(app: tauri::AppHandle) -> Result<Vec<NewsItem>, String> {
  let here = get_location(app);
  let Some(area) = local_news_area(here.latitude, here.longitude) else {
    return Ok(Vec::new());
  };
  let fetches = area.feeds.iter().map(|(url, source, limit)| fetch_feed_items(url, source, "", *limit, None));
  Ok(futures_util::future::join_all(fetches).await.into_iter().flatten().collect())
}

#[tauri::command]
async fn fetch_movie_trailers() -> Result<Vec<NewsItem>, String> {
  Ok(fetch_feed_items(TRAILER_FEED.0, TRAILER_FEED.1, "Trailers", 7, Some("trailer")).await)
}

// Opens a link in the user's default browser. Restricted to http(s) with no
// whitespace or control characters, and launched without a shell (the URL is
// a single argv entry), so neither a feed-supplied link nor anything else can
// smuggle in a different scheme or extra arguments.
#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
  let trimmed = url.trim();
  let lower = trimmed.to_ascii_lowercase();
  if !(lower.starts_with("https://") || lower.starts_with("http://")) || trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
    return Err("Only http(s) links can be opened.".to_string());
  }

  // The phone opens it in whatever the user has set for web links.
  #[cfg(target_os = "android")]
  {
    use tauri_plugin_opener::OpenerExt;
    return app.opener().open_url(trimmed, None::<&str>).map_err(|error| format!("Could not open the link: {error}"));
  }

  #[cfg(not(target_os = "android"))]
  {
    let _ = &app;
    #[cfg(windows)]
    let spawned = std::process::Command::new("rundll32").arg("url.dll,FileProtocolHandler").arg(trimmed).spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(trimmed).spawn();
    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
    let spawned = std::process::Command::new("xdg-open").arg(trimmed).spawn();

    spawned.map(|_| ()).map_err(|error| format!("Could not open the link: {error}"))
  }
}

#[derive(Serialize)]
struct WeatherInfo {
  temperature_f: f64,
  condition: String,
  location: String,
  wind_mph: f64,
  weather_code: u32,
  is_day: bool,
}

// --- Location (user-set, not guessed) ----------------------------------
// IP-based geolocation was tried first and dropped: live testing turned up
// both an aggressive rate limit on the free geolocation service and, more
// fundamentally, that it just isn't reliably accurate (VPNs, corporate
// networks, and ISP routing all throw it off). Explicit user control is both
// simpler and actually correct.
#[derive(Debug, Serialize, Deserialize, Clone)]
struct LocationInfo {
  label: String,
  latitude: f64,
  longitude: f64,
}

// Was a generic Atlanta placeholder from before the user's real location was
// known. Confirmed via ARTEMIS_HANDOFF.md (from Iris/Hermes, 2026-09-19) —
// only takes effect if the user hasn't already set one in Settings.
fn default_location() -> LocationInfo {
  LocationInfo { label: "Tucker, GA".to_string(), latitude: 33.8546, longitude: -84.2218 }
}

fn location_path(app: &tauri::AppHandle) -> PathBuf {
  app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("location.json")
}

#[tauri::command]
fn get_location(app: tauri::AppHandle) -> LocationInfo {
  fs::read_to_string(location_path(&app))
    .ok()
    .and_then(|raw| serde_json::from_str::<LocationInfo>(&raw).ok())
    .unwrap_or_else(default_location)
}

#[tauri::command]
fn set_location(app: tauri::AppHandle, label: String, latitude: f64, longitude: f64) -> Result<(), String> {
  let path = location_path(&app);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let serialized = serde_json::to_string(&LocationInfo { label, latitude, longitude }).map_err(|error| error.to_string())?;
  fs::write(&path, serialized).map_err(|error| error.to_string())
}

// --- City search ---------------------------------------------------------
// Open-Meteo's geocoder is free and keyless, but it only matches the *name*:
// "Atlanta, GA" finds Atlanta plus every park and dam with Atlanta in its name,
// and "Atlanta GA" finds nothing useful at all. So the query is split into a
// name and region hints, the name is searched, and the answer is filtered to
// real populated places and ranked here.
#[derive(Deserialize)]
struct GeocodeApiResponse {
  #[serde(default)]
  results: Vec<GeocodePlace>,
}

// One place as the geocoder returns it. More fields than the picker shows:
// the feature code and population are what let a search skip airports and
// put the big city first.
#[derive(Deserialize, Clone)]
struct GeocodePlace {
  name: String,
  latitude: f64,
  longitude: f64,
  #[serde(default)]
  admin1: Option<String>,
  #[serde(default)]
  country: Option<String>,
  #[serde(default)]
  country_code: Option<String>,
  #[serde(default)]
  feature_code: Option<String>,
  #[serde(default)]
  population: Option<u64>,
}

#[derive(Serialize, Clone)]
struct GeocodeResult {
  name: String,
  // The short form that gets saved and shown beside the weather: "Tucker, GA".
  label: String,
  latitude: f64,
  longitude: f64,
  admin1: Option<String>,
  country: Option<String>,
}

const US_STATES: [(&str, &str); 51] = [
  ("AL", "Alabama"),
  ("AK", "Alaska"),
  ("AZ", "Arizona"),
  ("AR", "Arkansas"),
  ("CA", "California"),
  ("CO", "Colorado"),
  ("CT", "Connecticut"),
  ("DE", "Delaware"),
  ("DC", "District of Columbia"),
  ("FL", "Florida"),
  ("GA", "Georgia"),
  ("HI", "Hawaii"),
  ("ID", "Idaho"),
  ("IL", "Illinois"),
  ("IN", "Indiana"),
  ("IA", "Iowa"),
  ("KS", "Kansas"),
  ("KY", "Kentucky"),
  ("LA", "Louisiana"),
  ("ME", "Maine"),
  ("MD", "Maryland"),
  ("MA", "Massachusetts"),
  ("MI", "Michigan"),
  ("MN", "Minnesota"),
  ("MS", "Mississippi"),
  ("MO", "Missouri"),
  ("MT", "Montana"),
  ("NE", "Nebraska"),
  ("NV", "Nevada"),
  ("NH", "New Hampshire"),
  ("NJ", "New Jersey"),
  ("NM", "New Mexico"),
  ("NY", "New York"),
  ("NC", "North Carolina"),
  ("ND", "North Dakota"),
  ("OH", "Ohio"),
  ("OK", "Oklahoma"),
  ("OR", "Oregon"),
  ("PA", "Pennsylvania"),
  ("RI", "Rhode Island"),
  ("SC", "South Carolina"),
  ("SD", "South Dakota"),
  ("TN", "Tennessee"),
  ("TX", "Texas"),
  ("UT", "Utah"),
  ("VT", "Vermont"),
  ("VA", "Virginia"),
  ("WA", "Washington"),
  ("WV", "West Virginia"),
  ("WI", "Wisconsin"),
  ("WY", "Wyoming"),
];

fn us_state_name(abbr: &str) -> Option<&'static str> {
  US_STATES.iter().find(|(code, _)| code.eq_ignore_ascii_case(abbr)).map(|(_, name)| *name)
}

fn us_state_abbr(name: &str) -> Option<&'static str> {
  let wanted = fold_for_search(name);
  US_STATES.iter().find(|(_, full)| fold_for_search(full) == wanted).map(|(code, _)| *code)
}

// Lowercase, accents and punctuation gone, so "São Paulo", "sao paulo" and
// "St. Louis" / "St Louis" compare equal.
fn fold_for_search(text: &str) -> String {
  let folded: String = text
    .chars()
    .flat_map(|c| c.to_lowercase())
    .map(|c| match c {
      'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
      'ç' | 'ć' | 'č' => 'c',
      'ď' | 'đ' => 'd',
      'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => 'e',
      'ğ' => 'g',
      'ì' | 'í' | 'î' | 'ï' | 'ī' | 'ı' => 'i',
      'ł' => 'l',
      'ñ' | 'ń' | 'ň' => 'n',
      'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => 'o',
      'ř' => 'r',
      'ś' | 'š' | 'ş' | 'ș' => 's',
      'ť' | 'ţ' | 'ț' => 't',
      'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => 'u',
      'ý' | 'ÿ' => 'y',
      'ź' | 'ż' | 'ž' => 'z',
      '-' => ' ',
      other => other,
    })
    .filter(|c| c.is_alphanumeric() || c.is_whitespace())
    .collect();
  folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

// "Atlanta, GA" and "Atlanta GA" both mean the city named Atlanta, in Georgia.
// Returns the place name, the region hints, and whether the hint was inferred
// from a bare trailing state code (which is only a guess: "New Or" is more
// likely half of "New Orleans" than a city called New in Oregon).
fn split_location_query(query: &str) -> (String, Vec<String>, bool) {
  if query.contains(',') {
    let mut parts = query.split(',').map(str::trim).filter(|part| !part.is_empty());
    let name = parts.next().unwrap_or("").to_string();
    return (name, parts.map(String::from).collect(), false);
  }
  let words: Vec<&str> = query.split_whitespace().collect();
  if words.len() >= 2 {
    let last = words[words.len() - 1];
    if last.chars().count() == 2 && us_state_name(last).is_some() {
      return (words[..words.len() - 1].join(" "), vec![last.to_string()], true);
    }
  }
  (words.join(" "), Vec::new(), false)
}

// A hint like "GA", "georgia" or "Unit" (someone still typing "United States")
// agrees with a place when it starts the state, its abbreviation or the country.
fn place_matches_region(place: &GeocodePlace, hint: &str) -> bool {
  let hint = fold_for_search(hint);
  if hint.is_empty() {
    return true;
  }
  let mut names: Vec<String> = Vec::new();
  if let Some(admin) = &place.admin1 {
    names.push(fold_for_search(admin));
    if place.country_code.as_deref() == Some("US") {
      if let Some(abbr) = us_state_abbr(admin) {
        names.push(abbr.to_lowercase());
      }
    }
  }
  if let Some(country) = &place.country {
    names.push(fold_for_search(country));
  }
  if let Some(code) = &place.country_code {
    names.push(code.to_lowercase());
    match code.as_str() {
      "US" => names.push("usa".to_string()),
      "GB" => names.push("uk".to_string()),
      _ => {}
    }
  }
  names.iter().any(|name| name.starts_with(&hint))
}

// An exact-name match only leads the list when it is a real place; see rank_places.
const EXACT_MATCH_MIN_POPULATION: u64 = 1000;

// Best match first: the exact name, then names that start with what was typed,
// then names that merely contain it; bigger places ahead of smaller within each.
// With `exact_only`, nothing but the exact name counts and a region hint that
// matches nothing rules everything out (instead of being ignored).
fn rank_places(places: Vec<GeocodePlace>, name: &str, hints: &[String], exact_only: bool) -> Vec<GeocodePlace> {
  let wanted = fold_for_search(name);
  if wanted.is_empty() {
    return Vec::new();
  }
  let mut named: Vec<(u8, GeocodePlace)> = places
    .into_iter()
    .filter_map(|place| {
      let folded = fold_for_search(&place.name);
      let tier = if folded == wanted {
        // A tiny or unsized place with the exact name ("San Di", a village in
        // Myanmar) must not outrank the big city being typed toward.
        if exact_only || place.population.unwrap_or(0) >= EXACT_MATCH_MIN_POPULATION { 0 } else { 1 }
      } else if exact_only {
        return None;
      } else if folded.starts_with(&wanted) {
        1
      } else if folded.contains(&wanted) {
        2
      } else {
        return None;
      };
      Some((tier, place))
    })
    .collect();

  // Cities and towns, not dams, parks and airports — unless that leaves nothing
  // (someone searching for a landmark still gets the landmark).
  let is_populated = |place: &GeocodePlace| place.feature_code.as_deref().map_or(true, |code| code.starts_with("PPL"));
  if named.iter().any(|(_, place)| is_populated(place)) {
    named.retain(|(_, place)| is_populated(place));
  }

  if !hints.is_empty() {
    let (matching, others): (Vec<_>, Vec<_>) = named.into_iter().partition(|(_, place)| hints.iter().all(|hint| place_matches_region(place, hint)));
    named = if matching.is_empty() && !exact_only { others } else { matching };
  }

  named.sort_by(|(tier_a, a), (tier_b, b)| tier_a.cmp(tier_b).then(b.population.unwrap_or(0).cmp(&a.population.unwrap_or(0))));
  named.into_iter().map(|(_, place)| place).collect()
}

// "Tucker, GA" for a US place, "Paris, Île-de-France, France" elsewhere.
fn geocode_label(place: &GeocodePlace) -> String {
  let admin = place.admin1.as_deref().filter(|admin| !admin.is_empty() && *admin != place.name);
  if place.country_code.as_deref() == Some("US") {
    match admin.and_then(us_state_abbr) {
      Some("DC") => return place.name.clone(),
      Some(abbr) => return format!("{}, {}", place.name, abbr),
      None => {}
    }
  }
  let country = place.country.as_deref().filter(|country| !country.is_empty());
  [Some(place.name.as_str()), admin, country].into_iter().flatten().collect::<Vec<_>>().join(", ")
}

async fn fetch_places(name: &str, us_only: bool, count: u32) -> Result<Vec<GeocodePlace>, String> {
  let mut url = format!("https://geocoding-api.open-meteo.com/v1/search?name={}&count={count}&language=en&format=json", urlencoding_encode(name));
  if us_only {
    url.push_str("&countryCode=US");
  }
  let response = http_client().get(&url).send().await.map_err(|error| format!("Failed to search for that location: {error}"))?;
  if !response.status().is_success() {
    return Err(format!("Failed to search for that location: geocoding service returned {}", response.status()));
  }
  let parsed: GeocodeApiResponse = response.json().await.map_err(|error| format!("Failed to parse geocoding response: {error}"))?;
  Ok(parsed.results)
}

// Backs the location search in Settings and on the Daily tab; called as the
// user types, so it has to be forgiving of half-finished names.
#[tauri::command]
async fn geocode_location(query: String) -> Result<Vec<GeocodeResult>, String> {
  let (name, hints, from_state_code) = split_location_query(query.trim());
  if name.chars().count() < 2 {
    return Ok(Vec::new());
  }

  let us_only = hints.iter().any(|hint| us_state_name(hint).is_some() || us_state_abbr(hint).is_some());
  let count = if hints.is_empty() { 20 } else { 40 };
  let mut ranked = rank_places(fetch_places(&name, us_only, count).await?, &name, &hints, from_state_code);
  if ranked.is_empty() && from_state_code {
    let whole = query.split_whitespace().collect::<Vec<_>>().join(" ");
    ranked = rank_places(fetch_places(&whole, false, 20).await?, &whole, &[], false);
  }

  let mut seen = HashSet::new();
  Ok(
    ranked
      .into_iter()
      .map(|place| GeocodeResult {
        label: geocode_label(&place),
        name: place.name,
        latitude: place.latitude,
        longitude: place.longitude,
        admin1: place.admin1,
        country: place.country,
      })
      .filter(|result| seen.insert(result.label.clone()))
      .take(8)
      .collect(),
  )
}

// Nominatim (OpenStreetMap) rather than Open-Meteo's geocoder above — this
// needs to resolve specific venues/addresses ("Vinyl @ Center Stage"), not
// just city names, which is what Open-Meteo's geocoder is built for.
#[derive(Deserialize)]
struct NominatimResult {
  lat: String,
  lon: String,
  display_name: String,
}

fn haversine_miles(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
  const EARTH_RADIUS_MILES: f64 = 3958.8;
  let lat1_rad = lat1.to_radians();
  let lat2_rad = lat2.to_radians();
  let delta_lat = (lat2 - lat1).to_radians();
  let delta_lon = (lon2 - lon1).to_radians();
  let a = (delta_lat / 2.0).sin().powi(2) + lat1_rad.cos() * lat2_rad.cos() * (delta_lon / 2.0).sin().powi(2);
  let c = 2.0 * a.sqrt().asin();
  EARTH_RADIUS_MILES * c
}

fn distance_band(miles: f64) -> &'static str {
  if miles < 10.0 {
    "nearby — a spontaneous trip"
  } else if miles < 15.0 {
    "a bit of a trip — plannable, could still be same-day"
  } else {
    "far — treat as an all-day trip"
  }
}

// Read-only, no side effects — no confirmation gate needed, same tier as
// check_website_health.
async fn calculate_distance_impl(app_handle: &tauri::AppHandle, destination: &str) -> String {
  if destination.trim().is_empty() {
    return "Error: a destination is required.".to_string();
  }
  let base = get_location(app_handle.clone());

  // Bias to a ~50mi box around the user's own location — unbiased Nominatim
  // search is unreliable for common US place names (verified: "Decatur GA"
  // with no bias resolved to Decatur County near the Florida line, 200+
  // miles from the Decatur near Atlanta the user actually means). bounded=1
  // makes this a hard filter, not just a preference: a wrong distant match
  // here would be actively misleading for a tool whose whole purpose is
  // judging whether somewhere is a quick trip or not.
  const BIAS_DEGREES: f64 = 0.7;
  let client = http_client();
  let url = format!(
    "https://nominatim.openstreetmap.org/search?q={}&format=json&limit=1&viewbox={},{},{},{}&bounded=1",
    urlencoding_encode(destination.trim()),
    base.longitude - BIAS_DEGREES,
    base.latitude + BIAS_DEGREES,
    base.longitude + BIAS_DEGREES,
    base.latitude - BIAS_DEGREES
  );
  let response = match client.get(&url).header("User-Agent", "Artemis/1.0").send().await {
    Ok(response) => response,
    Err(error) => return format!("Could not look up \"{destination}\": {error}"),
  };
  if !response.status().is_success() {
    return format!("Geocoding service returned HTTP {} for \"{destination}\".", response.status());
  }
  let results: Vec<NominatimResult> = match response.json().await {
    Ok(results) => results,
    Err(error) => return format!("Could not parse geocoding response: {error}"),
  };
  let Some(result) = results.into_iter().next() else {
    return format!("Could not find a location matching \"{destination}\".");
  };
  let (Ok(lat), Ok(lon)) = (result.lat.parse::<f64>(), result.lon.parse::<f64>()) else {
    return format!("Could not parse coordinates for \"{destination}\".");
  };

  let miles = haversine_miles(base.latitude, base.longitude, lat, lon);
  format!("{} is about {miles:.1} miles from {} — {}.", result.display_name, base.label, distance_band(miles))
}

// Minimal, dependency-free percent-encoding — the only untrusted input going
// into a URL here is a free-text city name, so this covers exactly what's needed.
fn urlencoding_encode(input: &str) -> String {
  let mut encoded = String::with_capacity(input.len());
  for byte in input.as_bytes() {
    match byte {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => encoded.push(*byte as char),
      _ => encoded.push_str(&format!("%{byte:02X}")),
    }
  }
  encoded
}

#[derive(Deserialize)]
struct OpenMeteoResponse {
  current: OpenMeteoCurrent,
}

#[derive(Deserialize)]
struct OpenMeteoCurrent {
  temperature_2m: f64,
  weather_code: u32,
  wind_speed_10m: f64,
  #[serde(default = "default_is_day")]
  is_day: u8,
}

fn default_is_day() -> u8 {
  1
}

fn weather_code_description(code: u32) -> &'static str {
  match code {
    0 => "Clear sky",
    1 | 2 => "Partly cloudy",
    3 => "Overcast",
    45 | 48 => "Fog",
    51 | 53 | 55 => "Drizzle",
    56 | 57 => "Freezing drizzle",
    61 | 63 | 65 => "Rain",
    66 | 67 => "Freezing rain",
    71 | 73 | 75 => "Snow",
    77 => "Snow grains",
    80 | 81 | 82 => "Rain showers",
    85 | 86 => "Snow showers",
    95 => "Thunderstorm",
    96 | 99 => "Thunderstorm with hail",
    _ => "Unknown",
  }
}

#[tauri::command]
async fn fetch_daily_weather(app: tauri::AppHandle) -> Result<WeatherInfo, String> {
  let client = http_client();
  let location = get_location(app);

  let url = format!(
    "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}&current=temperature_2m,weather_code,wind_speed_10m,is_day&temperature_unit=fahrenheit&wind_speed_unit=mph",
    location.latitude, location.longitude
  );

  let weather_response = client
    .get(&url)
    .send()
    .await
    .map_err(|error| format!("Failed to fetch weather: {error}"))?;
  if !weather_response.status().is_success() {
    return Err(format!("Failed to fetch weather: weather service returned {}", weather_response.status()));
  }
  let weather: OpenMeteoResponse = weather_response
    .json()
    .await
    .map_err(|error| format!("Failed to parse weather response: {error}"))?;

  Ok(WeatherInfo {
    temperature_f: weather.current.temperature_2m,
    condition: weather_code_description(weather.current.weather_code).to_string(),
    location: location.label,
    wind_mph: weather.current.wind_speed_10m,
    weather_code: weather.current.weather_code,
    is_day: weather.current.is_day != 0,
  })
}

// --- Inana (MarketGenius) live data ------------------------------------------
// Inana is the user's own MarketGenius backend, so this is a private,
// first-party connection rather than a third-party lookup — the same trust
// tier as the remote Ollama server and Hermes gateway above. Like weather and
// news it only ever pulls data down; nothing from a Privacy Mode conversation
// is sent to it.
//
// Access: there is no sign-in and no password. MarketGenius only gives data to a session
// token, so scripts/inana-token.mjs makes Artemis one token for the owner's own account,
// once, and writes it (with the two URLs) to inana.json in Artemis's data folder. The
// token lasts years, the frontend can never read it back, and Disconnect deletes it.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct InanaConfig {
  api_url: String,
  web_url: String,
  email: String,
  token: String,
}

#[derive(Debug, Serialize)]
struct InanaPublicConfig {
  api_url: String,
  web_url: String,
  email: String,
  // Whether Artemis has an access token for Inana.
  connected: bool,
}

const INANA_DEFAULT_API_URL: &str = "http://localhost:8080";
const INANA_DEFAULT_WEB_URL: &str = "http://localhost:5173";
const INANA_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);
const INANA_AUTH_EXPIRED: &str = "inana_auth_expired";
const INANA_NOT_CONNECTED: &str = "inana_not_connected";

fn inana_config_path(app: &tauri::AppHandle) -> PathBuf {
  app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("inana.json")
}

fn read_inana_config(app: &tauri::AppHandle) -> InanaConfig {
  fs::read_to_string(inana_config_path(app)).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

fn write_inana_config(app: &tauri::AppHandle, config: &InanaConfig) -> Result<(), String> {
  let path = inana_config_path(app);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let serialized = serde_json::to_string(config).map_err(|error| error.to_string())?;
  fs::write(&path, serialized).map_err(|error| error.to_string())
}

// Never includes the token: the frontend only ever learns whether one exists.
fn public_inana_config(config: &InanaConfig) -> InanaPublicConfig {
  InanaPublicConfig {
    api_url: if config.api_url.is_empty() { INANA_DEFAULT_API_URL.to_string() } else { config.api_url.clone() },
    web_url: if config.web_url.is_empty() { INANA_DEFAULT_WEB_URL.to_string() } else { config.web_url.clone() },
    email: config.email.clone(),
    connected: !config.token.is_empty(),
  }
}

#[tauri::command]
fn get_inana_config(app: tauri::AppHandle) -> InanaPublicConfig {
  public_inana_config(&read_inana_config(&app))
}

// Forgets the access token (the URLs stay). Linking Inana again is one run of
// scripts/inana-token.mjs.
#[tauri::command]
fn disconnect_inana(app: tauri::AppHandle) -> Result<(), String> {
  let mut config = read_inana_config(&app);
  config.token.clear();
  write_inana_config(&app, &config)
}

// The three outcomes a caller has to tell apart: a lapsed session (the whole
// dashboard needs to reconnect), a source the user simply hasn't linked inside
// Inana (a 400 — expected, not an error), and a genuine failure.
enum InanaFetchError {
  AuthExpired,
  NotConnected,
  Failed(String),
}

async fn inana_get(config: &InanaConfig, path: &str) -> Result<serde_json::Value, InanaFetchError> {
  let response = http_client()
    .get(format!("{}{path}", config.api_url))
    .bearer_auth(&config.token)
    .timeout(INANA_REQUEST_TIMEOUT)
    .send()
    .await
    .map_err(|error| InanaFetchError::Failed(format!("Could not reach Inana: {error}")))?;

  let status = response.status().as_u16();
  match status {
    401 => return Err(InanaFetchError::AuthExpired),
    400 => return Err(InanaFetchError::NotConnected),
    200..=299 => {}
    _ => {
      let message = response
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|body| body.get("message").and_then(|message| message.as_str()).map(String::from))
        .unwrap_or_else(|| format!("HTTP {status}"));
      return Err(InanaFetchError::Failed(message));
    }
  }
  response.json().await.map_err(|error| InanaFetchError::Failed(format!("Unreadable response from Inana: {error}")))
}

#[derive(Default)]
struct InanaProductData {
  meta: Vec<serde_json::Value>,
  ga4: Option<serde_json::Value>,
  errors: Vec<String>,
  auth_expired: bool,
}

// Folds a fetch outcome into a product's data: keeps the value on success,
// silently skips a source that isn't linked, and records anything else.
fn absorb_inana_result(data: &mut InanaProductData, label: &str, result: Result<serde_json::Value, InanaFetchError>) -> Option<serde_json::Value> {
  match result {
    Ok(value) => Some(value),
    Err(InanaFetchError::AuthExpired) => {
      data.auth_expired = true;
      None
    }
    Err(InanaFetchError::NotConnected) => None,
    Err(InanaFetchError::Failed(message)) => {
      data.errors.push(format!("{label}: {message}"));
      None
    }
  }
}

async fn fetch_inana_product(config: &InanaConfig, id: &str, name: &str) -> InanaProductData {
  let mut data = InanaProductData::default();
  let encoded_id = urlencoding_encode(id);

  let accounts_result = inana_get(config, &format!("/api/data/meta/ad-accounts?productId={encoded_id}")).await;
  if let Some(accounts_value) = absorb_inana_result(&mut data, &format!("Meta Ads ({name})"), accounts_result) {
    let requests: Vec<(serde_json::Value, String)> = accounts_value
      .get("adAccounts")
      .and_then(|accounts| accounts.as_array())
      .cloned()
      .unwrap_or_default()
      .into_iter()
      .filter_map(|account| {
        let account_id = account.get("account_id")?.as_str()?.to_string();
        let path = format!("/api/data/meta/insights?productId={encoded_id}&adAccountId={}", urlencoding_encode(&account_id));
        Some((account, path))
      })
      .collect();

    let results = futures_util::future::join_all(requests.iter().map(|(_, path)| inana_get(config, path))).await;
    for ((account, _), result) in requests.into_iter().zip(results) {
      if let Some(insights) = absorb_inana_result(&mut data, &format!("Meta Ads ({name})"), result) {
        data.meta.push(serde_json::json!({
          "product_id": id,
          "product_name": name,
          "account": account,
          "insights": insights.get("insights").cloned().unwrap_or(serde_json::Value::Null),
          "daily": insights.get("daily").cloned().unwrap_or_else(|| serde_json::json!([])),
        }));
      }
    }
  }

  let ga4_result = inana_get(config, &format!("/api/data/google-analytics/summary?productId={encoded_id}")).await;
  data.ga4 = absorb_inana_result(&mut data, &format!("Google Analytics ({name})"), ga4_result);
  data
}

// One call that gathers everything the Daily dashboard's Inana panels need,
// with every product fetched in parallel. Deliberately returns raw JSON: the
// shaping (windows, deltas, which metrics to feature) lives in the frontend
// next to the charts that use it, and a field Inana adds later flows through
// without a Rust change. A source that fails or isn't linked just goes
// missing / lands in `errors`; only a lapsed session fails the whole call.
#[tauri::command]
async fn fetch_inana_data(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
  fetch_inana_for(&read_inana_config(&app)).await
}

// No token means Inana was never linked on this machine; one Inana rejects has run out.
async fn fetch_inana_for(config: &InanaConfig) -> Result<serde_json::Value, String> {
  if config.token.is_empty() {
    return Err(INANA_NOT_CONNECTED.to_string());
  }
  let mut config = config.clone();
  if config.api_url.is_empty() {
    config.api_url = INANA_DEFAULT_API_URL.to_string();
  }
  fetch_inana_with(&config).await
}

async fn fetch_inana_with(config: &InanaConfig) -> Result<serde_json::Value, String> {
  let products = match inana_get(config, "/api/products").await {
    Ok(value) => value.as_array().cloned().unwrap_or_default(),
    Err(InanaFetchError::AuthExpired) => return Err(INANA_AUTH_EXPIRED.to_string()),
    Err(InanaFetchError::NotConnected) => Vec::new(),
    Err(InanaFetchError::Failed(message)) => return Err(message),
  };
  let product_list: Vec<(String, String)> = products
    .iter()
    .filter_map(|product| {
      let id = product.get("id")?.as_str()?.to_string();
      let name = product.get("name").and_then(|name| name.as_str()).unwrap_or(&id).to_string();
      Some((id, name))
    })
    .collect();

  let per_product = futures_util::future::join_all(product_list.iter().map(|(id, name)| fetch_inana_product(config, id, name))).await;

  let mut meta = Vec::new();
  let mut ga4 = Vec::new();
  let mut errors = Vec::new();
  for (data, (id, name)) in per_product.into_iter().zip(product_list.iter()) {
    if data.auth_expired {
      return Err(INANA_AUTH_EXPIRED.to_string());
    }
    meta.extend(data.meta);
    if let Some(summary) = data.ga4 {
      ga4.push(serde_json::json!({ "product_id": id, "product_name": name, "summary": summary }));
    }
    errors.extend(data.errors);
  }

  let stripe = match inana_get(config, "/api/data/stripe/summary").await {
    Ok(value) => value,
    Err(InanaFetchError::AuthExpired) => return Err(INANA_AUTH_EXPIRED.to_string()),
    Err(InanaFetchError::NotConnected) => serde_json::Value::Null,
    Err(InanaFetchError::Failed(message)) => {
      errors.push(format!("Stripe: {message}"));
      serde_json::Value::Null
    }
  };

  Ok(serde_json::json!({
    "fetched_at": chrono::Local::now().to_rfc3339(),
    "products": product_list.iter().map(|(id, name)| serde_json::json!({ "id": id, "name": name })).collect::<Vec<_>>(),
    "meta": meta,
    "ga4": ga4,
    "stripe": stripe,
    "errors": errors,
  }))
}

// Re-scan the knowledge base periodically while the app is running, so
// new/edited files in the library get picked up without needing a restart —
// "check for updates later".
//
// Deliberately NOT auto-resuming a scan from the on-disk manifest's known_paths
// at launch: the frontend calls index_knowledge_base with its current
// (localStorage-merged) path list within moments of mount anyway, and a
// startup resume-scan using a possibly-stale on-disk path list would win the
// single-flight race in spawn_knowledge_index and block that correct call
// from running until the stale one finished — which, discovered the hard way,
// is exactly what happened when a new default knowledge path was added but
// the on-disk manifest still only knew about the old one.
const KNOWLEDGE_RESCAN_INTERVAL_SECS: u64 = 6 * 60 * 60;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Auto-updater plugin — activate by setting "active": true in tauri.conf.json
      // and providing a valid pubkey + endpoints once you have a release server.
      // Desktop only: a phone app is updated by installing the next APK.
      #[cfg(desktop)]
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
      #[cfg(target_os = "android")]
      app.handle().plugin(tauri_plugin_opener::init())?;
      app.handle().plugin(tauri_plugin_dialog::init())?;
      #[cfg(target_os = "android")]
      {
        let _ = ANDROID_FEED_DIR.set(app.path().app_data_dir()?.join("iris-feed"));
      }

      let knowledge_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("knowledge_index");
      let knowledge_state = KnowledgeState::load(knowledge_dir);
      app.manage(knowledge_state);
      app.manage(ConfirmationState { pending: Mutex::new(HashMap::new()) });
      app.manage(ChatCancelState { handles: Mutex::new(HashMap::new()) });

      let tasks_path = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("scheduled_tasks.json");
      app.manage(TaskSchedulerState::load(tasks_path));

      let todos_path = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("todos.json");
      app.manage(TodoState::load(todos_path));

      let skills_path = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("skills.json");
      app.manage(SkillsState::load(skills_path));

      let tracked_pages_path = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("tracked_pages.json");
      app.manage(TrackedPagesState::load(tracked_pages_path));

      {
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(scheduled_task_loop(app_handle));
      }

      {
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
          let mut interval = tokio::time::interval(std::time::Duration::from_secs(KNOWLEDGE_RESCAN_INTERVAL_SECS));
          // tokio::time::interval's first tick fires immediately — skip it. The
          // frontend's own on-mount call is what triggers the startup scan; this
          // loop exists purely for the periodic re-scans after that.
          interval.tick().await;
          loop {
            interval.tick().await;
            let state = app_handle.state::<KnowledgeState>();
            let known_paths = state.index.lock().map(|index| index.manifest.known_paths.clone()).unwrap_or_default();
            if !known_paths.is_empty() {
              spawn_knowledge_index(app_handle.clone(), known_paths);
            }
          }
        });
      }

      // The tray icon is a desktop idea (a phone has no tray).
      #[cfg(desktop)]
      {
      let show_item = MenuItem::with_id(app, "show", "Show Artemis", true, None::<&str>)?;
      let quit_item = MenuItem::with_id(app, "quit", "Quit Artemis", true, None::<&str>)?;
      let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

      let mut tray_builder = TrayIconBuilder::new()
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
          "show" => {
            if let Some(window) = app.get_webview_window("main") {
              let _ = window.show();
              let _ = window.set_focus();
            }
          }
          "quit" => app.exit(0),
          _ => {}
        })
        .on_tray_icon_event(|tray, event| {
          if let tauri::tray::TrayIconEvent::Click {
            button: tauri::tray::MouseButton::Left,
            button_state: tauri::tray::MouseButtonState::Up,
            ..
          } = event
          {
            let app = tray.app_handle();
            if let Some(window) = app.get_webview_window("main") {
              let _ = window.show();
              let _ = window.set_focus();
            }
          }
        });
      if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
      }
      tray_builder.build(app)?;
      }

      Ok(())
    })
    // Keep Artemis (and its warm Ollama connection) running in the tray instead
    // of fully quitting on close — "work in the background during the day".
    .on_window_event(|window, event| {
      #[cfg(desktop)]
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let _ = window.hide();
        api.prevent_close();
      }
      #[cfg(mobile)]
      let _ = (window, event);
    })
    .invoke_handler(tauri::generate_handler![
      get_ollama_models,
      chat_with_ollama,
      cancel_chat,
      get_knowledge_context,
      index_knowledge_base,
      model_supports_tools,
      respond_to_confirmation,
      set_ollama_cloud_key,
      has_ollama_cloud_key,
      clear_ollama_cloud_key,
      read_audit_log,
      fetch_daily_news,
      fetch_movie_trailers,
      open_external_url,
      get_inana_config,
      disconnect_inana,
      fetch_inana_data,
      fetch_daily_weather,
      get_location,
      set_location,
      geocode_location,
      list_todos,
      add_todo,
      set_todo_done,
      remove_todo,
      get_user_memory,
      upload_document,
      list_scheduled_tasks_direct,
      cancel_scheduled_task_by_id,
      set_home_assistant_config,
      has_home_assistant_config,
      clear_home_assistant_config,
      set_github_token,
      has_github_token,
      clear_github_token,
      set_hermes_gateway_config,
      has_hermes_gateway_config,
      clear_hermes_gateway_config,
      get_goals,
      toggle_goal_item,
      break_down_goal,
      toggle_goal_substep,
      set_remote_ollama_config,
      get_remote_ollama_config,
      clear_remote_ollama_config,
      get_iris_feed,
      respond_to_iris_suggestion,
      accept_iris_task,
      record_checkoff,
      sync_iris_feed,
      ask_iris_to_scout,
      get_weekly_goals,
      fetch_local_news
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}


#[cfg(test)]
mod geocode_tests {
  use super::*;

  fn place(name: &str, admin1: &str, code: &str, feature: &str, population: Option<u64>) -> GeocodePlace {
    GeocodePlace {
      name: name.to_string(),
      latitude: 0.0,
      longitude: 0.0,
      admin1: Some(admin1.to_string()),
      country: Some(if code == "US" { "United States".to_string() } else { "France".to_string() }),
      country_code: Some(code.to_string()),
      feature_code: Some(feature.to_string()),
      population,
    }
  }

  #[test]
  fn splits_city_and_state() {
    assert_eq!(split_location_query("Atlanta, GA"), ("Atlanta".to_string(), vec!["GA".to_string()], false));
    assert_eq!(split_location_query("Atlanta GA"), ("Atlanta".to_string(), vec!["GA".to_string()], true));
    assert_eq!(split_location_query("New York"), ("New York".to_string(), vec![], false));
    assert_eq!(
      split_location_query("Atlanta, Georgia, United States"),
      ("Atlanta".to_string(), vec!["Georgia".to_string(), "United States".to_string()], false)
    );
    assert_eq!(split_location_query("  tucker   ga "), ("tucker".to_string(), vec!["ga".to_string()], true));
  }

  #[test]
  fn folds_accents_and_punctuation() {
    assert_eq!(fold_for_search("São Paulo"), "sao paulo");
    assert_eq!(fold_for_search("St. Louis"), "st louis");
    assert_eq!(fold_for_search("Winston-Salem"), "winston salem");
  }

  #[test]
  fn state_hint_picks_the_right_atlanta_and_drops_landmarks() {
    let places = vec![
      place("Atlanta Botanical Garden", "Georgia", "US", "PRK", None),
      place("Atlanta", "Texas", "US", "PPLA2", Some(5500)),
      place("Atlanta", "Georgia", "US", "PPLA", Some(510823)),
      place("Atlanta Regional Airport", "Georgia", "US", "AIRP", None),
      place("Atlanta", "Michigan", "US", "PPL", Some(800)),
    ];
    let ranked = rank_places(places, "Atlanta", &["GA".to_string()], false);
    assert_eq!(ranked.len(), 1);
    assert_eq!(ranked[0].admin1.as_deref(), Some("Georgia"));
    assert_eq!(geocode_label(&ranked[0]), "Atlanta, GA");
  }

  #[test]
  fn ranks_exact_then_prefix_then_by_population() {
    let places = vec![
      place("Tucson", "Arizona", "US", "PPLA2", Some(542629)),
      place("Tucker", "Mississippi", "US", "PPL", Some(662)),
      place("Tucker", "Georgia", "US", "PPL", Some(27581)),
    ];
    let names: Vec<String> = rank_places(places, "Tucker", &[], false).into_iter().map(|p| geocode_label(&p)).collect();
    assert_eq!(names, vec!["Tucker, GA".to_string(), "Tucker, MS".to_string()]);
  }

  #[test]
  fn a_tiny_exact_match_does_not_outrank_the_city_being_typed() {
    let places = vec![
      place("San Di", "Yangon", "MM", "PPL", None),
      place("San Diego", "California", "US", "PPLA2", Some(1404452)),
      place("San Dimas", "California", "US", "PPL", Some(34000)),
    ];
    let names: Vec<String> = rank_places(places, "San Di", &[], false).into_iter().map(|p| p.name).collect();
    assert_eq!(names, vec!["San Diego", "San Dimas", "San Di"]);
  }

  #[test]
  fn partial_names_match_by_prefix_without_junk() {
    let places = vec![
      place("Decatur", "Illinois", "US", "PPLA2", Some(73254)),
      place("Decatur", "Georgia", "US", "PPLA2", Some(21957)),
      place("Blue Island", "Illinois", "US", "PPL", Some(23652)),
    ];
    let ranked = rank_places(places, "Decat", &[], false);
    assert_eq!(ranked.len(), 2);
    assert_eq!(geocode_label(&ranked[0]), "Decatur, IL");
  }

  #[test]
  fn guessed_state_code_needs_an_exact_name_or_yields_nothing() {
    let places = vec![place("Newport", "Oregon", "US", "PPL", Some(10000))];
    // "New Or" -> name "New" + region "Or": Newport is not a city called New.
    assert!(rank_places(places, "New", &["Or".to_string()], true).is_empty());
  }

  #[test]
  fn labels_read_short_for_the_us_and_full_elsewhere() {
    assert_eq!(geocode_label(&place("Tucker", "Georgia", "US", "PPL", None)), "Tucker, GA");
    assert_eq!(geocode_label(&place("Paris", "Île-de-France", "FR", "PPLC", None)), "Paris, Île-de-France, France");
    assert_eq!(geocode_label(&place("Washington D.C.", "District of Columbia", "US", "PPLC", None)), "Washington D.C.");
  }
}


#[cfg(test)]
mod iris_feed_tests {
  use super::*;

  #[test]
  fn tasks_block_parses_and_missing_fields_default() {
    let raw = r#"{
      "updated": "2026-09-20T07:30:00-04:00",
      "suggestion": { "text": null, "needs_answer": false },
      "tasks": {
        "updated": "2026-09-20T07:30:00-04:00",
        "next": [
          { "id": "next-1", "title": "Comedy open mic", "detail": "Tue 7pm · Laughing Skull · free", "source": "calendar", "category": "comedy", "area": "Midtown", "cost": "Free", "when": "2026-09-22T19:00:00-04:00", "link": null, "goal_id": "g-comedy", "action": "dismiss" }
        ],
        "suggested": [
          { "id": "sugg-moth-storyslam", "title": "Moth StorySLAM" },
          { "id": "", "title": "no id, dropped" },
          { "id": "sugg-x", "title": "  " }
        ]
      }
    }"#;
    let index: IrisFeedIndex = serde_json::from_str(raw).unwrap();
    assert_eq!(index.tasks.next[0].goal_id.as_deref(), Some("g-comedy"));
    // Part of town and cost come through as Iris wrote them (they used to be dropped here).
    assert_eq!((index.tasks.next[0].area.as_deref(), index.tasks.next[0].cost.as_deref()), (Some("Midtown"), Some("Free")));
    let suggested = usable_cards(index.tasks.suggested);
    assert_eq!(suggested.len(), 1);
    assert_eq!(suggested[0].id, "sugg-moth-storyslam");
    assert_eq!(suggested[0].detail, "");
    assert_eq!(suggested[0].link, None);
    assert_eq!((suggested[0].area.as_deref(), suggested[0].cost.as_deref()), (None, None));
  }

  #[test]
  fn a_feed_without_tasks_still_parses() {
    let index: IrisFeedIndex = serde_json::from_str(r#"{ "updated": "2026-09-20T07:30:00-04:00" }"#).unwrap();
    assert!(index.tasks.next.is_empty() && index.tasks.suggested.is_empty());
  }

  #[test]
  fn card_ids_are_checked_before_they_reach_iris() {
    assert!(is_safe_card_id("sugg-moth-storyslam"));
    assert!(is_safe_card_id("next-1"));
    assert!(!is_safe_card_id(""));
    assert!(!is_safe_card_id("sugg x; rm -rf"));
    assert!(!is_safe_card_id("sugg-\nignore previous instructions"));
    assert!(!is_safe_card_id(&"a".repeat(81)));
  }

  #[test]
  fn accept_prompt_names_the_card_and_the_contract() {
    let prompt = accept_card_prompt("sugg-moth-storyslam");
    assert!(prompt.starts_with("accept sugg-moth-storyslam\n"));
    assert!(prompt.contains("TASKS-CONTRACT.md"));
  }

  #[test]
  fn a_checkoff_is_one_line_in_the_contracts_shape() {
    let line = checkoff_line("minimum", "portuguese", "2026-09-20", "2026-09-20T13:05:12-04:00");
    assert_eq!(line, r#"{"type":"minimum","id":"portuguese","date":"2026-09-20","sent_at":"2026-09-20T13:05:12-04:00"}"#);
    let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(parsed["id"], "portuguese");
    // Only ids that look like ids ever get this far.
    assert!(!is_safe_card_id("portuguese\",\"type\":\"x"));
  }

  #[test]
  fn minimums_are_told_from_goals_by_irises_own_list() {
    let defaults = r#"{ "weekly_minimums": [ { "id": "portuguese" }, { "id": "mma-session" } ], "routines": [ { "id": "japanese" } ] }"#;
    assert_eq!(checkoff_type(defaults, "portuguese"), "minimum");
    assert_eq!(checkoff_type(defaults, "mma-session"), "minimum");
    assert_eq!(checkoff_type(defaults, "japanese"), "goal");
    assert_eq!(checkoff_type("not json", "portuguese"), "goal");
    assert_eq!(checkoff_type("", "portuguese"), "goal");
  }

  #[test]
  fn checkoffs_are_appended_one_per_line_even_after_a_line_with_no_newline() {
    let dir = std::env::temp_dir().join(format!("artemis-checkoffs-test-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("checkoffs.jsonl");
    append_line(&path, "one").unwrap();
    append_line(&path, "two").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "one\ntwo\n");
    fs::write(&path, "left without a newline").unwrap();
    append_line(&path, "three").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "left without a newline\nthree\n");
    fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn insights_are_read_leniently_and_in_priority_order() {
    let raw = serde_json::json!([
      { "id": "ins-book", "observation": "Hook work is analysis-first.", "action": "Write the chapter revision.", "task": { "title": "Revise one chapter", "category": "writing", "when": null }, "kind": "Drift", "priority": 2 },
      { "id": "ins-wander", "observation": "WanderWork is stale.", "action": "Close the Vercel issue.", "task": null, "kind": "opportunity", "priority": "1" },
      { "id": "ins-empty", "observation": "Nothing to do about this.", "action": "  " },
      { "id": "ins-late", "action": "Decide on the ledger.", "kind": "decision", "task": { "title": "Decide", "when": "2026-09-22T10:00:00-04:00" } }
    ]);
    let insights = parse_insights(&raw);
    // The entry with no action is dropped; a priority written as a string still counts.
    assert_eq!(insights.iter().map(|insight| insight.id.as_str()).collect::<Vec<_>>(), ["ins-wander", "ins-book", "ins-late"]);
    assert_eq!(insights[0].task, None);
    assert_eq!(insights[1].kind, "drift");
    assert_eq!(insights[1].task.as_ref().unwrap().title, "Revise one chapter");
    assert_eq!(insights[1].task.as_ref().unwrap().when, None);
    assert_eq!(insights[2].priority, 99);
    assert_eq!(insights[2].task.as_ref().unwrap().when.as_deref(), Some("2026-09-22T10:00:00-04:00"));
  }

  #[test]
  fn a_feed_without_usable_insights_still_parses() {
    for raw in [r#"{ "updated": "x" }"#, r#"{ "updated": "x", "insights": null }"#, r#"{ "updated": "x", "insights": [] }"#, r#"{ "updated": "x", "insights": "later" }"#] {
      let index: IrisFeedIndex = serde_json::from_str(raw).unwrap();
      assert!(parse_insights(&index.insights).is_empty(), "{raw}");
    }
  }
}


#[cfg(test)]
mod weekly_goals_tests {
  use super::*;

  fn day(text: &str) -> chrono::NaiveDate {
    chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
  }

  #[test]
  fn calendar_week_runs_monday_to_sunday() {
    // 2026-09-20 is a Sunday.
    assert_eq!(calendar_week(day("2026-09-20")), (day("2026-09-14"), day("2026-09-20")));
    assert_eq!(calendar_week(day("2026-09-14")), (day("2026-09-14"), day("2026-09-20")));
    assert_eq!(calendar_week(day("2026-09-16")), (day("2026-09-14"), day("2026-09-20")));
  }

  #[test]
  fn counts_only_this_weeks_completions_against_the_target() {
    let raw = r#"{
      "updated": "2026-09-20T08:00:00-04:00",
      "goals": [
        { "id": "dance", "title": "Dance class", "category": "dance", "target_count": 2, "completions": ["2026-09-13", "2026-09-15", "2026-09-18T19:00:00-04:00"] },
        { "id": "pt", "title": "Portuguese, 2 audio lessons", "target_count": 2, "completions": [] },
        { "title": "Paused thing", "active": false, "target_count": 3 }
      ]
    }"#;
    let goals = parse_weekly_goals(raw, day("2026-09-20")).unwrap();
    assert!(goals.exists);
    assert_eq!(goals.goals.len(), 2);
    assert_eq!((goals.goals[0].done, goals.goals[0].target), (2, 2));
    assert_eq!((goals.goals[1].done, goals.goals[1].target), (0, 2));
    // Last week's completion (the 13th) is not counted.
    assert_eq!(goals.week_start, "2026-09-14");
  }

  #[test]
  fn calendar_month_covers_the_whole_month_including_december() {
    assert_eq!(calendar_month(day("2026-09-20")), (day("2026-09-01"), day("2026-09-30")));
    assert_eq!(calendar_month(day("2026-12-31")), (day("2026-12-01"), day("2026-12-31")));
    assert_eq!(calendar_month(day("2028-02-10")), (day("2028-02-01"), day("2028-02-29")));
  }

  #[test]
  fn monthly_progress_counts_the_whole_month_against_a_scaled_target() {
    let raw = r#"{"goals":[{"id":"dance","title":"Dance class","target_count":2,"completions":["2026-08-31","2026-09-01","2026-09-08","2026-09-15","2026-09-18"]}]}"#;
    let goals = parse_weekly_goals(raw, day("2026-09-20")).unwrap();
    let dance = &goals.goals[0];
    // This week (Sep 14-20): the 15th and 18th. This month: everything from Sep 1 on, not Aug 31.
    assert_eq!((dance.done, dance.target), (2, 2));
    assert_eq!(dance.month_done, 4);
    // 2 a week over 30 days is 8.57, shown as 9.
    assert_eq!(dance.month_target, 9);
    assert_eq!((goals.month_start.as_str(), goals.month_end.as_str()), ("2026-09-01", "2026-09-30"));
  }

  #[test]
  fn accepts_an_array_object_dates_and_plain_counts() {
    let raw = r#"[
      { "name": "Write", "target": "3 per week", "completions": [{ "date": "2026-09-16" }] },
      { "title": "Yoga", "target_count": 4, "completions": 1 }
    ]"#;
    let goals = parse_weekly_goals(raw, day("2026-09-18")).unwrap();
    assert_eq!(goals.goals[0].id, "write");
    assert_eq!((goals.goals[0].done, goals.goals[0].target), (1, 3));
    assert_eq!((goals.goals[1].done, goals.goals[1].target), (1, 4));
  }

  #[test]
  fn a_missing_target_counts_as_one_and_bad_json_is_an_error() {
    let goals = parse_weekly_goals(r#"{"goals":[{"title":"Meditate"}]}"#, day("2026-09-18")).unwrap();
    assert_eq!(goals.goals[0].target, 1);
    assert!(parse_weekly_goals("not json", day("2026-09-18")).is_err());
  }

  #[test]
  fn summary_reads_cleanly_for_the_model() {
    let goals = parse_weekly_goals(r#"{"goals":[{"id":"dance","title":"Dance class","category":"dance","target_count":2,"completions":["2026-09-15"]}]}"#, day("2026-09-18")).unwrap();
    let summary = weekly_goals_summary(&goals);
    assert!(summary.contains("1 of 2 reps done"));
    assert!(summary.contains("- Dance class (dance): 1/2 this week, 1/9 this month [dance]"));
    assert!(weekly_goals_summary(&WeeklyGoals::default()).contains("no weekly-goals file"));
  }

  #[test]
  fn the_goal_tools_are_offered_to_the_model_with_usable_schemas() {
    let tools = tool_definitions();
    let names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();
    let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
    assert_eq!(names.len(), unique.len(), "tool names must be unique");

    let list = tools.iter().find(|tool| tool.name == "list_weekly_goals").expect("list_weekly_goals is registered");
    assert_eq!(list.parameters["type"], "object");

    let update = tools.iter().find(|tool| tool.name == "update_goals").expect("update_goals is registered");
    assert_eq!(update.parameters["required"][0], "request");
    assert!(update.description.contains("asked to approve"));
  }

  #[test]
  fn update_prompt_carries_the_request_and_both_goal_files() {
    let prompt = goals_update_prompt("add a weekly goal: dance twice a week");
    assert!(prompt.contains("\"add a weekly goal: dance twice a week\""));
    assert!(prompt.contains("weekly-goals.json"));
    assert!(prompt.contains("Goals.md"));
    assert!(prompt.contains("Do not delete a goal unless I said to remove it"));
  }
}


#[cfg(test)]
mod local_news_tests {
  use super::*;

  #[test]
  fn metro_atlanta_gets_local_news_and_faraway_places_do_not() {
    // Tucker and Decatur, the saved and the searched-for home.
    assert!(local_news_area(33.8546, -84.2218).is_some());
    assert!(local_news_area(33.7748, -84.2963).is_some());
    // Portland, Oregon and Athens, Georgia (about 65 miles out) are outside it.
    assert!(local_news_area(45.5152, -122.6784).is_none());
    assert!(local_news_area(33.9519, -83.3576).is_none());
  }

  #[test]
  fn every_local_feed_is_https_and_named() {
    for area in LOCAL_NEWS_AREAS {
      for (url, source, limit) in area.feeds {
        assert!(url.starts_with("https://") && !source.is_empty() && *limit > 0, "{url}");
      }
    }
  }
}


#[cfg(test)]
mod todo_tests {
  use super::*;

  #[test]
  fn when_accepts_a_day_a_local_time_or_a_timestamp_and_nothing_else() {
    assert_eq!(clean_when("2026-09-22"), Some("2026-09-22".to_string()));
    assert_eq!(clean_when(" 2026-09-22T14:00 "), Some("2026-09-22T14:00".to_string()));
    assert_eq!(clean_when("2026-09-22T14:00:00-04:00"), Some("2026-09-22T14:00:00-04:00".to_string()));
    assert_eq!(clean_when(""), None);
    assert_eq!(clean_when("tomorrow"), None);
    assert_eq!(clean_when("2026-13-45"), None);
  }

  #[test]
  fn tasks_saved_before_dates_existed_still_load() {
    let old = r#"{"items":[{"id":"todo-1","label":"Buy milk","done":false}]}"#;
    let file: TodoListFile = serde_json::from_str(old).unwrap();
    assert_eq!(file.items[0].when, None);
    assert_eq!(file.items[0].note, "");
  }

  #[test]
  fn a_task_keeps_its_day_time_and_description() {
    let path = std::env::temp_dir().join(format!("artemis-todo-test-{}.json", chrono::Local::now().timestamp_nanos_opt().unwrap_or(0)));
    let state = TodoState { items: Mutex::new(Vec::new()), path: path.clone() };
    let item = add_todo_full_impl(&state, "Dentist", "", " Bring the forms ", Some("2026-09-22T14:00"), None, None);
    assert_eq!(item.when.as_deref(), Some("2026-09-22T14:00"));
    assert_eq!(item.note, "Bring the forms");
    assert_eq!((item.area.as_deref(), item.cost.as_deref()), (None, None));
    let undated = add_todo_full_impl(&state, "Call mom", "", "", Some("not a date"), Some("  "), None);
    assert_eq!(undated.when, None);
    assert_eq!(undated.area, None, "blank is nothing");
    // A task made from a suggestion keeps its part of town and cost.
    let event = add_todo_full_impl(&state, "Java Monkey Speaks", "Iris", "Open mic", Some("2026-09-20T19:30"), Some(" Decatur "), Some("Free"));
    assert_eq!((event.area.as_deref(), event.cost.as_deref()), (Some("Decatur"), Some("Free")));
    assert!(list_todos_impl(&state).contains("- [ ] Dentist (2026-09-22 14:00)"));
    let _ = fs::remove_file(path);
  }
}


#[cfg(test)]
mod inana_access_tests {
  use super::*;
  use std::io::{Read, Write};

  // A local server that answers each request in turn with the next canned response and
  // hands back what it was sent.
  fn serve(responses: Vec<(&'static str, &'static str)>) -> (String, std::sync::mpsc::Receiver<String>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
      for (status_line, body) in responses {
        let Ok((mut stream, _)) = listener.accept() else { return };
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
        let mut received: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
          match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => received.extend_from_slice(&buffer[..count]),
          }
          let text = String::from_utf8_lossy(&received).to_string();
          if let Some(split) = text.find("\r\n\r\n") {
            let wanted = text[..split].to_lowercase().split("content-length:").nth(1).and_then(|rest| rest.trim().split_whitespace().next().and_then(|n| n.parse::<usize>().ok())).unwrap_or(0);
            if text.len() >= split + 4 + wanted {
              break;
            }
          }
        }
        let _ = sender.send(String::from_utf8_lossy(&received).to_string());
        let response = format!("HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = stream.write_all(response.as_bytes());
      }
    });
    (format!("http://{address}"), receiver)
  }

  #[test]
  fn the_frontend_only_learns_whether_there_is_a_token_never_the_token() {
    let none = public_inana_config(&InanaConfig::default());
    assert!(!none.connected);
    assert_eq!((none.api_url.as_str(), none.web_url.as_str()), (INANA_DEFAULT_API_URL, INANA_DEFAULT_WEB_URL));
    let linked = public_inana_config(&InanaConfig { api_url: "http://localhost:9000".to_string(), email: "me@example.com".to_string(), token: "secret-token".to_string(), ..InanaConfig::default() });
    assert!(linked.connected);
    assert_eq!((linked.api_url.as_str(), linked.email.as_str()), ("http://localhost:9000", "me@example.com"));
    assert!(!format!("{linked:?}").contains("secret-token"));
  }

  #[test]
  fn nothing_is_asked_without_a_token_and_with_one_every_request_carries_it() {
    // never linked: "not connected", and no request is made at all
    assert_eq!(tauri::async_runtime::block_on(fetch_inana_for(&InanaConfig::default())).unwrap_err(), INANA_NOT_CONNECTED);
    // linked: the token goes out as a bearer token on the first call (the products list)
    let (url, requests) = serve(vec![("200 OK", "[]"), ("400 Bad Request", "{}")]);
    let config = InanaConfig { api_url: url, token: "abc.def.ghi".to_string(), ..InanaConfig::default() };
    let data = tauri::async_runtime::block_on(fetch_inana_for(&config)).unwrap();
    let first = requests.recv().unwrap();
    assert!(first.starts_with("GET /api/products "), "{first}");
    assert!(first.to_lowercase().contains("authorization: bearer abc.def.ghi"), "{first}");
    assert_eq!(data["products"], serde_json::json!([]));
  }

  #[test]
  fn a_token_inana_rejects_says_it_has_run_out_instead_of_asking_for_a_login() {
    let (url, _) = serve(vec![("401 Unauthorized", "{}")]);
    let config = InanaConfig { api_url: url, token: "old".to_string(), ..InanaConfig::default() };
    assert_eq!(tauri::async_runtime::block_on(fetch_inana_for(&config)).unwrap_err(), INANA_AUTH_EXPIRED);
  }
}


#[cfg(test)]
mod tailscale_tests {
  use super::*;

  #[test]
  fn only_addresses_on_the_tailscale_network_are_accepted() {
    for good in ["http://100.94.158.103:11434", "http://100.64.0.1", "https://100.127.255.254:8443/path", "http://horus.tail1234.ts.net:11434", "HTTP://Horus.Tail1234.TS.NET"] {
      assert!(is_tailscale_url(good), "{good}");
    }
    for bad in [
      "http://100.63.255.255:11434",
      "http://100.128.0.1",
      "http://192.168.1.5:11434",
      "http://localhost:11434",
      "https://ollama.com",
      "http://100.94.158.103.evil.com",
      "https://evil.com/100.94.158.103",
      "http://100.94.158.103@evil.com",
      "http://user:pw@100.94.158.103",
      "http://.ts.net",
      "http://evil.com.ts.net.evil.com",
      "100.94.158.103:11434",
      "ftp://100.94.158.103",
      "",
    ] {
      assert!(!is_tailscale_url(bad), "{bad}");
    }
  }

  #[test]
  fn the_emulator_alias_is_only_ever_accepted_by_a_debug_build() {
    assert!(phone_address_allowed("http://100.94.158.103:8642") && phone_address_allowed("http://iris.tail1234.ts.net:8642"));
    assert_eq!(phone_address_allowed("http://10.0.2.2:8642"), cfg!(debug_assertions));
    for bad in ["http://10.0.2.2.evil.com:8642", "http://10.0.2.3:8642", "http://evil.com/http://10.0.2.2:8642", "http://user@10.0.2.2:8642", "http://192.168.1.5:8642", "https://ollama.com"] {
      assert!(!phone_address_allowed(bad), "{bad}");
    }
  }
}
