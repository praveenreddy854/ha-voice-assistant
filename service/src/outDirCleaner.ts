import fs from "fs";
import path from "path";

const OUT_DIR = path.join(process.cwd(), "out");
const MAX_AGE_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let cleanerStarted = false;

function sweepOutDir(): void {
  if (!fs.existsSync(OUT_DIR)) return;

  const cutoff = Date.now() - MAX_AGE_MS;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(OUT_DIR, { withFileTypes: true });
  } catch (err) {
    console.error("[OutDirCleaner] Failed to read out dir:", err);
    return;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(OUT_DIR, entry.name);
    try {
      const stat = fs.statSync(dirPath);
      if (stat.mtimeMs >= cutoff) continue;
      fs.rmSync(dirPath, { recursive: true, force: true });
      removed += 1;
      console.log(`[OutDirCleaner] Removed ${entry.name} (mtime ${stat.mtime.toISOString()})`);
    } catch (err) {
      console.error(`[OutDirCleaner] Failed to process ${entry.name}:`, err);
    }
  }

  if (removed > 0) {
    console.log(`[OutDirCleaner] Sweep complete, removed ${removed} stale dir(s)`);
  }
}

export function startOutDirCleaner(): void {
  if (cleanerStarted) return;
  cleanerStarted = true;
  sweepOutDir();
  setInterval(sweepOutDir, SWEEP_INTERVAL_MS);
  console.log(`[OutDirCleaner] Started (target=${OUT_DIR}, maxAge=1h, interval=1h)`);
}
