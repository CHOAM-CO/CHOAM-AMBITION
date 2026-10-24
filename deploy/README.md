# Deploy

- Published dir is `web/` (static files, served as-is).
- Push to `main`; the box fetches every minute and picks it up within ~1 min.
- Box: Windows, repo at `D:\ambition\repo`, Caddy at `D:\ambition\bin\caddy.exe`, serves `http://:8787`.
- Scheduled tasks (SYSTEM): `ambition-caddy` (at startup), `ambition-pull` (every 1 min, runs `deploy/pull.ps1`).
- Logs: `D:\ambition\logs\` (`pull.log` = one line per update, `caddy.log` = Caddy stdout/stderr).
- Changing `deploy/Caddyfile` triggers an automatic `caddy reload`.
- Public host `ambition.choam.studio` block in the Caddyfile is commented out until 80/443 exist.
