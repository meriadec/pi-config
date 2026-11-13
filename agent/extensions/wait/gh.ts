import { execFile } from "node:child_process";
import type { PrView } from "./conditions.ts";

/** Real `gh pr view`. Kept apart so tests use a fake. */
export function ghPrView(url: string, fields: string[], signal?: AbortSignal): Promise<PrView> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["pr", "view", url, "--json", fields.join(",")],
      { signal, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr).trim() || err.message));
        try {
          resolve(JSON.parse(stdout) as PrView);
        } catch {
          reject(new Error("gh returned invalid JSON"));
        }
      },
    );
  });
}
