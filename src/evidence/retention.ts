// Screenshot retention. Debug screenshots are full-fidelity (unredactable) and
// only ever live locally under runs/. This sweep deletes them after a retention
// window so the data-minimization promise is a real mechanism, not a claim.
// It touches ONLY image files - the redacted logs, results, and DOM snapshots
// stay - and it never looks outside the run root.
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const IMAGE = /\.png$/i;

/** Delete screenshot images under runRoot older than maxAgeMs. Returns how many
 *  were removed. Missing directories are ignored, so it is safe to call on
 *  startup before any run exists. */
export async function sweepScreenshots(runRoot: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let removed = 0;
  let runDirs: string[];
  try {
    runDirs = await readdir(runRoot);
  } catch {
    return 0;
  }
  for (const runId of runDirs) {
    for (const sub of ["steps", "failure"]) {
      const dir = path.join(runRoot, runId, sub);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!IMAGE.test(file)) continue;
        const target = path.join(dir, file);
        try {
          const info = await stat(target);
          if (now - info.mtimeMs > maxAgeMs) {
            await rm(target, { force: true });
            removed += 1;
          }
        } catch {
          // A file that vanished or cannot be read is simply skipped.
        }
      }
    }
  }
  return removed;
}

/** Default retention window for debug screenshots: 24 hours. */
export const SCREENSHOT_RETENTION_MS = 24 * 60 * 60 * 1000;
