#!/usr/bin/env node
/*
 * Artemis feed sidecar for the Android phone (transport decision (b), Claude's
 * IRIS reply 2026-09-21). Serves Iris's iris-feed folder on the tailnet with
 * the two routes Claude's phone code expects:
 *
 *   GET  /artemis/feed       -> { updated, files: { name: rawText } }
 *   POST /artemis/checkoffs  -> append to iris-feed/checkoffs.jsonl (dedupe id+date)
 *
 * Auth: same Bearer key as the Hermes gateway /v1 routes (API_SERVER_KEY in
 * %HERMES_HOME%\.env) — read at startup, never logged, never returned.
 * Bind: 0.0.0.0:8643 — reach it at http://<tailscale-ip>:8643 (zephyr =
 * 100.72.210.122). Only the two fixed paths exist; everything else 404s.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FEED_DIR = 'C:/Users/dccar/OneDrive/Desktop/Projects/Artemis/iris-feed';
const GOALS_FILE = 'C:/Users/dccar/HermesKB/weekly-goals.json';
const PORT = 8643;
const MAX_FILE = 512 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;

function loadApiKey() {
  const envPath = path.join(os.homedir(), 'AppData', 'Local', 'hermes', '.env');
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^API_SERVER_KEY=(.+)\s*$/);
      if (m) return m[1].trim();
    }
  } catch (e) { /* fall through */ }
  return null;
}

const API_KEY = loadApiKey();
if (!API_KEY) {
  console.error('FATAL: API_SERVER_KEY not found in Hermes .env — refusing to start');
  process.exit(1);
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(__dirname, 'feed-server.log'), line + '\n'); } catch (e) {}
}

function safeFileName(name) {
  return typeof name === 'string'
    && /^[A-Za-z0-9._-]+$/.test(name)
    && (name.endsWith('.md') || name.endsWith('.json'));
}

async function readIfSmall(p) {
  try {
    const st = await fs.promises.stat(p);
    if (st.size > MAX_FILE) return null;
    return await fs.promises.readFile(p, 'utf8');
  } catch (e) { return null; }
}

// Async throughout: the handler runs on the single Node thread, and a blocking
// read here (or a OneDrive hydration stall) would freeze POST /checkoffs too.
async function buildFeedBundle() {
  let latest;
  try {
    latest = await fs.promises.readFile(path.join(FEED_DIR, 'latest.json'), 'utf8');
  } catch (e) {
    return { error: 'latest.json unreadable: ' + e.message };
  }
  const files = { 'latest.json': latest };
  // One parse: the same object yields both the timestamp and the file list.
  let updated = null;
  try {
    const j = JSON.parse(latest);
    updated = j.updated || null;
    // every file latest.json names by plain file name (brief/review/spark/…)
    for (const [key, val] of Object.entries(j)) {
      if (typeof val === 'string' && safeFileName(val)) files[val] = null; // mark intent
    }
  } catch (e) {}
  files['weekly-review.md'] = null;
  files['philosophical-spark.md'] = null;
  try {
    await fs.promises.access(GOALS_FILE);
    files['weekly-goals.json'] = null;
  } catch (e) {}

  let total = latest.length;
  for (const name of Object.keys(files)) {
    if (name === 'latest.json') continue;
    const p = name === 'weekly-goals.json' ? GOALS_FILE : path.join(FEED_DIR, name);
    const text = await readIfSmall(p);
    if (text == null) { delete files[name]; continue; }
    total += text.length;
    if (total > MAX_TOTAL) { delete files[name]; continue; }
    files[name] = text;
  }
  return { updated, files };
}

function readCheckoffs() {
  const p = path.join(FEED_DIR, 'checkoffs.jsonl');
  try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean); } catch (e) { return []; }
}

function handleCheckoffs(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch (e) { return { status: 400, out: { error: 'invalid JSON' } }; }
  const list = parsed && Array.isArray(parsed.checkoffs) ? parsed.checkoffs : null;
  if (!list) return { status: 400, out: { error: 'body must be {"checkoffs":[...]}' } };

  const seen = new Set();
  for (const line of readCheckoffs()) {
    try {
      const j = JSON.parse(line);
      seen.add(`${j.id}|${j.date}`);
    } catch (e) {}
  }
  let appended = 0, duplicates = 0;
  const lines = [];
  for (const c of list.slice(0, 500)) {
    if (!c || typeof c.id !== 'string' || !c.id || typeof c.date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(c.date)) {
      duplicates += 0; continue;
    }
    const key = `${c.id}|${c.date}`;
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    lines.push(JSON.stringify({
      type: typeof c.type === 'string' && c.type ? c.type : 'goal',
      id: c.id.slice(0, 120),
      date: c.date.slice(0, 10),
      sent_at: typeof c.sent_at === 'string' ? c.sent_at.slice(0, 60) : new Date().toISOString(),
    }));
    appended += 1;
  }
  if (lines.length) {
    fs.appendFileSync(path.join(FEED_DIR, 'checkoffs.jsonl'), lines.join('\n') + '\n');
  }
  return { status: 200, out: { appended, duplicates } };
}

const server = http.createServer((req, res) => {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${API_KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/artemis/feed') {
    buildFeedBundle().then((bundle) => {
      if (bundle.error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bundle));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bundle));
      log(`GET /artemis/feed from ${req.socket.remoteAddress} -> ${Object.keys(bundle.files).length} files`);
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'feed build failed: ' + e.message }));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/artemis/checkoffs') {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) return;
      const { status, out } = handleCheckoffs(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      log(`POST /artemis/checkoffs from ${req.socket.remoteAddress} -> ${JSON.stringify(out)}`);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  log(`artemis feed sidecar listening on 0.0.0.0:${PORT} (key loaded: yes)`);
});