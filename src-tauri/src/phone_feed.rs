// The phone's copy of Iris's feed.
//
// On the desktop Artemis reads Iris's folder (iris-feed/) directly. A phone has no such
// folder, so Iris serves the same files over the Hermes gateway (reachable only on the
// user's Tailscale network) and this keeps a copy of them in the app's own storage. Every
// reader the desktop uses (latest.json and the files it names) then reads that copy
// unchanged, so both show identical data, and the last copy stays readable when the phone
// is off Tailscale.
//
//   GET  {gateway}/artemis/feed        -> {"updated": "...", "files": {"latest.json": "<text>", ...}}
//   POST {gateway}/artemis/checkoffs   <- {"checkoffs": [{"type":"goal","id":"...","date":"...","sent_at":"..."}]}
//
// Both carry the gateway's bearer key. The files are exactly Iris's, as text; the
// contract stays "latest.json is canonical". Artemis only ever writes inside its own
// storage, never Iris's real folder.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

const MAX_FILES: usize = 32;
const MAX_FILE_BYTES: usize = 512 * 1024;
const MAX_BUNDLE_BYTES: usize = 4 * 1024 * 1024;
const INDEX_FILE: &str = "latest.json";
// What the phone has ticked off and Iris has not been told yet; sent, then cleared.
pub const CHECKOFFS_FILE: &str = "checkoffs.jsonl";
// The check-offs being sent right now, kept until Iris has them.
const SENDING_FILE: &str = "checkoffs.sending.jsonl";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Deserialize)]
struct Bundle {
  #[serde(default)]
  updated: String,
  #[serde(default)]
  files: BTreeMap<String, String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Synced {
  pub updated: String,
  pub files: usize,
  pub sent_checkoffs: usize,
  // Set when the feed came through but the check-offs could not be delivered; they stay
  // queued and go with the next sync.
  pub checkoff_problem: Option<String>,
}

// Plain names only: whatever the server sends, nothing is written outside the feed folder.
fn is_feed_file_name(name: &str) -> bool {
  !name.is_empty()
    && name.len() <= 96
    && !name.starts_with('.')
    && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    && (name.ends_with(".md") || name.ends_with(".json"))
}

fn parse_bundle(body: &[u8]) -> Result<(String, Vec<(String, String)>), String> {
  if body.len() > MAX_BUNDLE_BYTES {
    return Err("Iris's feed is bigger than the phone will take.".to_string());
  }
  let bundle: Bundle = serde_json::from_slice(body).map_err(|error| format!("Iris's feed wasn't in the shape Artemis expects: {error}"))?;
  let files: Vec<(String, String)> = bundle
    .files
    .into_iter()
    .filter(|(name, text)| is_feed_file_name(name) && text.len() <= MAX_FILE_BYTES)
    .take(MAX_FILES)
    .collect();
  let index = files.iter().find(|(name, _)| name == INDEX_FILE).ok_or_else(|| "Iris's feed had no latest.json.".to_string())?;
  let parsed: serde_json::Value = serde_json::from_str(&index.1).map_err(|error| format!("Iris's latest.json wasn't valid JSON: {error}"))?;
  let updated = if bundle.updated.is_empty() { parsed.get("updated").and_then(|value| value.as_str()).unwrap_or_default().to_string() } else { bundle.updated };
  Ok((updated, files))
}

fn write_atomically(path: &Path, text: &str) -> std::io::Result<()> {
  let mut temporary = path.as_os_str().to_owned();
  temporary.push(".tmp");
  let temporary = std::path::PathBuf::from(temporary);
  fs::write(&temporary, text)?;
  fs::rename(&temporary, path)
}

// The index goes last, so it never names a file that has not arrived. Files Iris no longer
// serves (yesterday's brief) are removed; the check-off queue is never touched.
fn write_files(dir: &Path, files: &[(String, String)]) -> std::io::Result<()> {
  fs::create_dir_all(dir)?;
  for (name, text) in files.iter().filter(|(name, _)| name != INDEX_FILE) {
    write_atomically(&dir.join(name), text)?;
  }
  if let Some((name, text)) = files.iter().find(|(name, _)| name == INDEX_FILE) {
    write_atomically(&dir.join(name), text)?;
  }
  let kept: std::collections::HashSet<&str> = files.iter().map(|(name, _)| name.as_str()).collect();
  for entry in fs::read_dir(dir)?.flatten() {
    let name = entry.file_name().to_string_lossy().to_string();
    let stale = name.ends_with(".tmp") || (is_feed_file_name(&name) && !kept.contains(name.as_str()));
    if stale {
      let _ = fs::remove_file(entry.path());
    }
  }
  Ok(())
}

fn lines_of(path: &Path) -> Vec<String> {
  fs::read_to_string(path).unwrap_or_default().lines().map(str::trim).filter(|line| !line.is_empty()).map(String::from).collect()
}

// Moves what has been ticked off since the last send into the sending file (renaming first,
// so a check-off made right now starts a fresh queue instead of being lost), and returns
// everything waiting to go, including what an interrupted send left behind.
fn take_pending_checkoffs(dir: &Path) -> std::io::Result<Vec<String>> {
  let pending = dir.join(CHECKOFFS_FILE);
  let sending = dir.join(SENDING_FILE);
  if pending.exists() {
    let taken = dir.join(format!("checkoffs.taken-{}.jsonl", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_nanos()).unwrap_or(0)));
    fs::rename(&pending, &taken)?;
    let mut file = fs::OpenOptions::new().create(true).append(true).open(&sending)?;
    for line in lines_of(&taken) {
      writeln!(file, "{line}")?;
    }
    drop(file);
    fs::remove_file(&taken)?;
  }
  Ok(lines_of(&sending))
}

fn host_of(base: &str) -> &str {
  base.split("://").nth(1).unwrap_or(base).split(['/', '?', '#']).next().unwrap_or(base)
}

fn unreachable_message(base: &str) -> String {
  format!("Can't reach Iris at {}. Is Tailscale on?", host_of(base))
}

fn refused_message(status: reqwest::StatusCode, what: &str) -> String {
  match status.as_u16() {
    401 | 403 => "Iris's gateway didn't accept the key. Check it in Settings.".to_string(),
    404 => format!("Iris isn't serving {what} yet (the gateway answered 404)."),
    code => format!("Iris's gateway answered HTTP {code} for {what}."),
  }
}

async fn send_checkoffs(client: &reqwest::Client, base: &str, key: &str, dir: &Path) -> Result<usize, String> {
  let lines = take_pending_checkoffs(dir).map_err(|error| format!("Couldn't read the waiting check-offs: {error}"))?;
  // A line that isn't JSON would never be accepted, so it is not kept forever.
  let entries: Vec<serde_json::Value> = lines.iter().filter_map(|line| serde_json::from_str(line).ok()).collect();
  let sending = dir.join(SENDING_FILE);
  if entries.is_empty() {
    let _ = fs::remove_file(&sending);
    return Ok(0);
  }
  let response = client
    .post(format!("{base}/artemis/checkoffs"))
    .bearer_auth(key)
    .timeout(REQUEST_TIMEOUT)
    .json(&serde_json::json!({ "checkoffs": entries }))
    .send()
    .await
    .map_err(|_| unreachable_message(base))?;
  if !response.status().is_success() {
    return Err(refused_message(response.status(), "check-offs"));
  }
  let _ = fs::remove_file(&sending);
  Ok(entries.len())
}

// Sends what the phone has ticked off, then pulls Iris's files into `dir`.
pub async fn sync_with(client: &reqwest::Client, base_url: &str, key: &str, dir: &Path) -> Result<Synced, String> {
  let base = base_url.trim().trim_end_matches('/');
  fs::create_dir_all(dir).map_err(|error| format!("Couldn't open the phone's feed folder: {error}"))?;
  let (sent, problem) = match send_checkoffs(client, base, key, dir).await {
    Ok(count) => (count, None),
    Err(message) => (0, Some(message)),
  };

  let response = client
    .get(format!("{base}/artemis/feed"))
    .bearer_auth(key)
    .timeout(REQUEST_TIMEOUT)
    .send()
    .await
    .map_err(|_| unreachable_message(base))?;
  if !response.status().is_success() {
    return Err(refused_message(response.status(), "the phone feed"));
  }
  let body = response.bytes().await.map_err(|_| unreachable_message(base))?;
  let (updated, files) = parse_bundle(&body)?;
  write_files(dir, &files).map_err(|error| format!("Couldn't save Iris's feed on the phone: {error}"))?;
  Ok(Synced { updated, files: files.len(), sent_checkoffs: sent, checkoff_problem: problem })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Read;

  // A local server that answers each request in turn with the next canned response and
  // hands back what it was sent.
  fn serve(responses: Vec<(&'static str, String)>) -> (String, std::sync::mpsc::Receiver<String>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
      for (status_line, body) in responses {
        let Ok((mut stream, _)) = listener.accept() else { return };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
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

  fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("artemis-phone-feed-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
  }

  fn feed(files: &[(&str, &str)]) -> String {
    let map: BTreeMap<&str, &str> = files.iter().copied().collect();
    serde_json::json!({ "updated": "2026-09-20T22:45:00-04:00", "files": map }).to_string()
  }

  const INDEX: &str = r#"{"updated":"2026-09-20T22:45:00-04:00","brief":"2026-09-20-brief.md"}"#;

  #[test]
  fn only_plain_feed_file_names_are_accepted() {
    for good in ["latest.json", "weekly-review.md", "2026-09-20-brief.md", "weekly-goals.json", "philosophical-spark.md"] {
      assert!(is_feed_file_name(good), "{good}");
    }
    for bad in ["", "../latest.json", "a/b.md", r"a\b.md", ".hidden.md", "checkoffs.jsonl", "notes.txt", "latest.json.tmp", "évil.md", "a b.md"] {
      assert!(!is_feed_file_name(bad), "{bad}");
    }
    assert!(!is_feed_file_name(&format!("{}.md", "x".repeat(100))));
  }

  #[test]
  fn a_bundle_needs_a_readable_index_and_skips_what_it_may_not_write() {
    let body = feed(&[("latest.json", INDEX), ("2026-09-20-brief.md", "## Weather"), ("../escape.md", "no"), ("notes.txt", "no")]);
    let (updated, files) = parse_bundle(body.as_bytes()).unwrap();
    assert_eq!(updated, "2026-09-20T22:45:00-04:00");
    assert_eq!(files.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["2026-09-20-brief.md", "latest.json"]);
    assert!(parse_bundle(feed(&[("weekly-review.md", "x")]).as_bytes()).unwrap_err().contains("no latest.json"));
    assert!(parse_bundle(feed(&[("latest.json", "{not json")]).as_bytes()).unwrap_err().contains("valid JSON"));
    assert!(parse_bundle(b"[]").is_err() && parse_bundle(b"\"text\"").unwrap_err().contains("shape"));
    // the bundle's own "updated" is optional: the index says it too
    let bare = serde_json::json!({ "files": { "latest.json": INDEX } }).to_string();
    assert_eq!(parse_bundle(bare.as_bytes()).unwrap().0, "2026-09-20T22:45:00-04:00");
    // a file over the limit is left out rather than taking the rest down
    let big = "x".repeat(MAX_FILE_BYTES + 1);
    let (_, files) = parse_bundle(feed(&[("latest.json", INDEX), ("weekly-review.md", &big)]).as_bytes()).unwrap();
    assert_eq!(files.len(), 1);
    assert!(parse_bundle(&vec![b' '; MAX_BUNDLE_BYTES + 1]).unwrap_err().contains("bigger"));
  }

  #[test]
  fn writing_replaces_files_drops_the_ones_iris_stopped_serving_and_keeps_the_queue() {
    let dir = scratch("write");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("2026-09-19-brief.md"), "yesterday").unwrap();
    fs::write(dir.join("latest.json.tmp"), "half").unwrap();
    fs::write(dir.join(CHECKOFFS_FILE), "{\"id\":\"a\"}\n").unwrap();
    write_files(&dir, &[("latest.json".to_string(), INDEX.to_string()), ("2026-09-20-brief.md".to_string(), "## Weather".to_string())]).unwrap();
    assert_eq!(fs::read_to_string(dir.join("latest.json")).unwrap(), INDEX);
    assert_eq!(fs::read_to_string(dir.join("2026-09-20-brief.md")).unwrap(), "## Weather");
    assert!(!dir.join("2026-09-19-brief.md").exists() && !dir.join("latest.json.tmp").exists());
    assert_eq!(fs::read_to_string(dir.join(CHECKOFFS_FILE)).unwrap(), "{\"id\":\"a\"}\n", "the check-off queue is not the feed's to touch");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_sync_sends_the_check_offs_then_saves_the_feed() {
    let dir = scratch("sync");
    fs::create_dir_all(&dir).unwrap();
    let line = r#"{"type":"goal","id":"portuguese-audio","date":"2026-09-20","sent_at":"2026-09-20T12:00:00-04:00"}"#;
    fs::write(dir.join(CHECKOFFS_FILE), format!("{line}\nnot json at all\n")).unwrap();
    let (url, requests) = serve(vec![("200 OK", r#"{"appended":1}"#.to_string()), ("200 OK", feed(&[("latest.json", INDEX), ("2026-09-20-brief.md", "## Weather\nSunny")]))]);

    let synced = tauri::async_runtime::block_on(sync_with(&reqwest::Client::new(), &format!("{url}/"), "the-key", &dir)).unwrap();
    assert_eq!(synced, Synced { updated: "2026-09-20T22:45:00-04:00".to_string(), files: 2, sent_checkoffs: 1, checkoff_problem: None });

    let post = requests.recv().unwrap();
    assert!(post.starts_with("POST /artemis/checkoffs "), "{post}");
    assert!(post.to_lowercase().contains("authorization: bearer the-key"));
    assert!(post.contains(r#""checkoffs":[{"#) && post.contains(r#""id":"portuguese-audio""#) && !post.contains("not json"));
    let get = requests.recv().unwrap();
    assert!(get.starts_with("GET /artemis/feed "), "{get}");
    assert_eq!(fs::read_to_string(dir.join("2026-09-20-brief.md")).unwrap(), "## Weather\nSunny");
    assert!(!dir.join(CHECKOFFS_FILE).exists() && !dir.join(SENDING_FILE).exists(), "delivered check-offs are cleared");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn check_offs_that_could_not_be_delivered_wait_for_the_next_sync() {
    let dir = scratch("queue");
    fs::create_dir_all(&dir).unwrap();
    let first = r#"{"type":"goal","id":"a","date":"2026-09-20","sent_at":"t1"}"#;
    let second = r#"{"type":"goal","id":"b","date":"2026-09-20","sent_at":"t2"}"#;
    fs::write(dir.join(CHECKOFFS_FILE), format!("{first}\n")).unwrap();
    // Iris has no check-off endpoint yet (404), but the feed itself comes through
    let (url, _) = serve(vec![("404 Not Found", "{}".to_string()), ("200 OK", feed(&[("latest.json", INDEX)]))]);
    let synced = tauri::async_runtime::block_on(sync_with(&reqwest::Client::new(), &url, "k", &dir)).unwrap();
    assert_eq!(synced.sent_checkoffs, 0);
    assert!(synced.checkoff_problem.unwrap().contains("check-offs yet"));
    assert!(fs::read_to_string(dir.join(SENDING_FILE)).unwrap().contains(r#""id":"a""#), "kept, not dropped");

    // one more tick while it waits; the next sync sends both, oldest first
    fs::write(dir.join(CHECKOFFS_FILE), format!("{second}\n")).unwrap();
    let (url, requests) = serve(vec![("200 OK", "{}".to_string()), ("200 OK", feed(&[("latest.json", INDEX)]))]);
    let synced = tauri::async_runtime::block_on(sync_with(&reqwest::Client::new(), &url, "k", &dir)).unwrap();
    assert_eq!((synced.sent_checkoffs, synced.checkoff_problem), (2, None));
    let post = requests.recv().unwrap();
    assert!(post.find(r#""id":"a""#).unwrap() < post.find(r#""id":"b""#).unwrap());
    assert!(!dir.join(SENDING_FILE).exists() && !dir.join(CHECKOFFS_FILE).exists());
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn an_unreachable_or_unwilling_gateway_gets_a_message_that_says_what_to_do() {
    let dir = scratch("errors");
    let client = reqwest::Client::new();
    // nothing listening: the Tailscale hint, with the address so it is clear which one
    let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", dead.local_addr().unwrap());
    drop(dead);
    let error = tauri::async_runtime::block_on(sync_with(&client, &url, "k", &dir)).unwrap_err();
    assert!(error.starts_with("Can't reach Iris at 127.0.0.1:") && error.ends_with("Is Tailscale on?"), "{error}");
    // a wrong key
    let (url, _) = serve(vec![("401 Unauthorized", "{}".to_string())]);
    let error = tauri::async_runtime::block_on(sync_with(&client, &url, "wrong", &dir)).unwrap_err();
    assert!(error.contains("didn't accept the key"), "{error}");
    // a gateway that does not serve the feed yet
    let (url, _) = serve(vec![("404 Not Found", "{}".to_string())]);
    let error = tauri::async_runtime::block_on(sync_with(&client, &url, "k", &dir)).unwrap_err();
    assert!(error.contains("isn't serving the phone feed yet"), "{error}");
    // and a feed that is not one leaves what the phone already has alone
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("latest.json"), INDEX).unwrap();
    let (url, _) = serve(vec![("200 OK", "<html>captive portal</html>".to_string())]);
    let error = tauri::async_runtime::block_on(sync_with(&client, &url, "k", &dir)).unwrap_err();
    assert!(error.contains("shape"), "{error}");
    assert_eq!(fs::read_to_string(dir.join("latest.json")).unwrap(), INDEX);
    let _ = fs::remove_dir_all(&dir);
  }
}
