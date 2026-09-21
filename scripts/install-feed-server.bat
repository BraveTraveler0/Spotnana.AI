@echo off
REM One-click install for the Artemis phone feed path (run as Administrator).
REM 1) Opens TCP 8643 on Windows Firewall for Tailscale addresses only.
REM 2) Verifies the sidecar answers.
netsh advfirewall firewall add rule name="Artemis feed sidecar (Tailscale only)" dir=in action=allow protocol=TCP localport=8643 remoteip=100.64.0.0/10 profile=private,public
echo.
echo Rule created. If the sidecar is not running yet it will start at next logon,
REM or start it now:
start "" /min node "C:\Users\dccar\OneDrive\Desktop\Projects\Artemis\scripts\feed-server.cjs"
timeout /t 2 >nul
curl -s -o nul -w "local check: HTTP %%{http_code} (401 expected without key)\n" http://127.0.0.1:8643/artemis/feed
pause