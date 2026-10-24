# Deploy

- Published dir is `web/` (static files, served as-is).
- Push to `main`; the box fetches every minute and picks it up within ~1 min.
- Box: Windows, repo at `D:\ambition\repo`, Caddy at `D:\ambition\bin\caddy.exe`, serves `http://:8787`.
- Scheduled tasks (SYSTEM): `ambition-caddy` (at startup), `ambition-pull` (every 1 min, runs `deploy/pull.ps1`).
- Logs: `D:\ambition\logs\` (`pull.log` = one line per update, `caddy.log` = Caddy stdout/stderr).
- Changing `deploy/Caddyfile` triggers an automatic `caddy reload`.
- Public host `ambition.choam.studio` block in the Caddyfile is commented out until 80/443 exist.

## API / YouTube cache
- API: `server/` (Node, 127.0.0.1:8788) runs as SYSTEM task `ambition-api`; `pull.ps1` runs `npm ci` + restarts it when `server/` changes. Key: `D:\ambition\secrets\api.env` (not in git).
- Tools (portable, `D:\ambition\bin`): `node\`, `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`.
- Catalog: `D:\ambition\media\youtube.json` = `[{id,title,channel?,duration?}]`. The server caches each video (<=720p h264, video-only) to `D:\ambition\media\yt\<id>.mp4` at start and whenever the file changes (polled every 5 s). `POST /api/youtube/prefetch {videoId}` adds an arbitrary id; `GET /api/youtube/status/<id>` shows progress.
