# ARTEMIS PRIVATE BRAIN — horus Ollama (Iris-configured)

> 2026-09-19, set up by Iris per dccar: **Artemis's privacy-mode model layer now points at the home server's Ollama. Zero cloud, zero telemetry.** Claude: wire Artemis's model endpoint to this; no credentials needed (Tailscale-only network).

## Endpoint (for Artemis's Rust HTTP client)

```
Base URL:  http://192.168.1.65:11434/v1       # horus on home LAN — CONFIRMED WORKING 2026-09-19
           http://100.94.158.103:11434/v1     # via Tailscale — BLOCKED by NordVPN Threat Protection
                                              #   (WFP filter drops TCP on the Tailscale interface; tunnel itself
                                              #   works — tailscale ping succeeds, TCP doesn't).
                                              # FIX IN NORDVPN APP: Settings -> Threat Protection -> toggle OFF,
                                              #   or Split Tunneling -> allow Tailscale, then reconnect the tunnel.
Models:    qwen3:30b-a3b (MoE, ~4-6s/reply — BEST quality/speed, recommended default)
           qwen3:4b, gpt-oss:20b (also installed; 4b's /v1 replies came back empty in tests — use 30b)
Auth:      none (LAN/Tailscale only; Ollama bound to 0.0.0.0 via systemd override on horus)
```

- Both horus and zephyr (the PC) are on the user's Tailscale network (`100.94.158.103` horus / `100.72.210.122` zephyr) — traffic is end-to-end encrypted between them.
- **Privacy-mode contract unchanged:** when privacy mode is ON, Artemis's model calls go to this Ollama endpoint ONLY (localhost/LAN/Tailscale). No external API hosts. When OFF (explicit user choice per-task), cloud is allowed.
- Quick test from zephyr: `curl http://100.94.158.103:11434/api/tags` → should list both models.
- If horus is asleep/unreachable, Artemis should fall back gracefully (offline mode), not error.

## Performance notes (measured 2026-09-19)

- horus: i7-8750H 12 threads / 32GB RAM / GTX 1050 Ti 4GB. qwen3:4b is responsive; gpt-oss:20b is CPU-bound (slow — expect 30s+ first token). Suggest pulling a 7–8B model later (`ollama pull qwen3:8b` or llama3.1:8b) as the default quality/speed balance.
- Artemis's existing OpenAI-compatible client already points at `127.0.0.1:11434` per its original config — for horus inference just swap the host to `100.94.158.103:11434`.

## Also on horus (Iris-managed, already live)

- `/backup/nightly.sh` — 2am nightly: MongoDB Atlas dump (wanderwork) + git mirrors (Citizn, WanderWork, marketinggenius), 14-day rotation. Log: `/var/log/nightly-backup.log`. Verified: `BACKUP_OK 17M mongo, 29M git`.
- `/backup/uptime.sh` — every 5 min: citizn.app + wanderwork health → `/backup/uptime.json`. Iris reads this into the 9:30 brief. Verified: citizn 200, wanderwork 200.
- marketgenius + aonverse show "pending-domain" — dccar to provide their public URLs, then add to the pinger.
- Docker 29.8.1 + Compose installed (ready for anything).
- Git mirrors verified: Citizn.git 97M + marketinggenius.git 432M + WanderWork.git 29M — all three repos now mirrored nightly. A GitHub token sits in `/root/.git-credentials` (root-only, chmod 600) for private-repo fetches — treat as sensitive; rotate if horus is ever exposed.
- Domains confirmed by dccar 2026-09-19: aonverse.com (→www, 200) · wanderwork.io (→www, 200) · citizn.app (200) · MarketGenius NOT public yet (pinger marks pending-domain; add when launched).