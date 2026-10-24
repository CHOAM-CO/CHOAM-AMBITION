import fs from 'node:fs';

// Load KEY=VALUE pairs from the secrets file (never logged, never committed).
export function loadEnvFile(p) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no env file: rely on process env */ }
}

loadEnvFile(process.env.AMBITION_ENV_FILE || 'D:\\ambition\\secrets\\api.env');

export const config = {
  host: '127.0.0.1',
  port: Number(process.env.AMBITION_PORT || 8788),
  dataDir: process.env.AMBITION_DATA_DIR || 'D:\\ambition\\data',
  mediaDir: process.env.AMBITION_MEDIA_DIR || 'D:\\ambition\\media',
  binDir: process.env.AMBITION_BIN_DIR || 'D:\\ambition\\bin',
  ytCacheDir: process.env.AMBITION_YT_CACHE_DIR || 'D:\\ambition\\yt-cache',
  asrUrl: process.env.AMBITION_ASR_URL || 'http://127.0.0.1:8790',
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  visionModel: process.env.AMBITION_VISION_MODEL || 'claude-haiku-5-5',
  summaryModel: process.env.AMBITION_SUMMARY_MODEL || 'claude-sonnet-5-5',
  maxBodyBytes: 12 * 1024 * 1024,
  speakCooldownMs: 15000,
  startedAt: new Date().toISOString(),
};
