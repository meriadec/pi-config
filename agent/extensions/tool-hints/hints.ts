/** Pure hint rules for failing `read` and `edit` results. Hints only ADD text; they never throw. */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";

export const MAX_HINT_BYTES = 400;
export const MAX_SCAN_ENTRIES = 200;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const ANCHOR_RE = /(\d+)#([ZPMQVRWSNKTXJBYH]{2})/g;
const MAX_TRACKED_PATHS = 64;

/** Cut a string to a byte budget without splitting a UTF-8 character. */
export function boundBytes(text: string, max = MAX_HINT_BYTES): string {
  if (Buffer.byteLength(text) <= max) return text;
  let out = text;
  while (Buffer.byteLength(out + "…") > max) out = out.slice(0, -1);
  return out + "…";
}

const tilde = (p: string) => {
  const home = homedir();
  return p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
};

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** Up to 3 names close to `wanted` (same stem, case change or small typo). */
export function similarNames(wanted: string, entries: readonly string[]): string[] {
  const w = wanted.toLowerCase();
  const stem = (n: string) => n.toLowerCase().slice(0, n.length - extname(n).length);
  const limit = Math.max(2, Math.floor(w.length / 4));
  return entries
    .slice(0, MAX_SCAN_ENTRIES)
    .map((name) => {
      const n = name.toLowerCase();
      const d = stem(name) === stem(wanted) && stem(name) !== "" ? 0 : levenshtein(w, n);
      return { name, d };
    })
    .filter((x) => x.d <= limit && x.name !== wanted)
    .sort((x, y) => x.d - y.d || x.name.localeCompare(y.name))
    .slice(0, 3)
    .map((x) => x.name);
}

export interface Fs {
  exists(path: string): boolean;
  list(dir: string): string[];
}
export const realFs: Fs = {
  exists: (p) => existsSync(p),
  list: (d) => readdirSync(d).slice(0, MAX_SCAN_ENTRIES),
};

function nearestExistingDir(path: string, fs: Fs): string | undefined {
  let dir = dirname(path);
  for (let i = 0; i < 16; i++) {
    if (fs.exists(dir)) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

export type ReadHintKind = "image-missing" | "similar-name" | "dir-missing" | "dir-no-match";
export interface ReadHint {
  kind: ReadHintKind;
  text: string;
}

/** Hint for a `read` that failed because the path does not exist. One directory scan at most. */
export function readNotFoundHint(
  rawPath: string,
  cwd: string,
  fs: Fs = realFs,
): ReadHint | undefined {
  try {
    const clean = rawPath.replace(/^@/, "");
    const abs = clean.startsWith("~") ? clean.replace("~", homedir()) : resolve(cwd, clean);
    if (fs.exists(abs)) return undefined; // not a missing path: stay silent
    const name = basename(abs);
    if (IMAGE_EXT.has(extname(abs).toLowerCase())) {
      return {
        kind: "image-missing",
        text: boundBytes(
          `Hint: "${name}" does not exist. If a command in the same message creates it, calls run in parallel: read it in the next message. Else check the path.`,
        ),
      };
    }
    const dir = dirname(abs);
    if (fs.exists(dir)) {
      const similar = similarNames(name, fs.list(dir));
      if (similar.length > 0) {
        return {
          kind: "similar-name",
          text: boundBytes(
            `Hint: "${name}" not found. Similar names in the same directory: ${similar.join(", ")}.`,
          ),
        };
      }
      return {
        kind: "dir-no-match",
        text: boundBytes(
          `Hint: "${name}" not found in an existing directory and no similar name. List the directory first.`,
        ),
      };
    }
    const anchor = nearestExistingDir(abs, fs);
    const worktree = /\/(\.t3\/)?worktrees\//.test(abs)
      ? " The path looks like a removed worktree."
      : "";
    return {
      kind: "dir-missing",
      text: boundBytes(
        `Hint: directory of "${name}" does not exist. Nearest existing directory: ${anchor ? tilde(anchor) : "none"}.${worktree} List it first.`,
      ),
    };
  } catch {
    return undefined;
  }
}

export type EditHintKind =
  | "malformed-ref"
  | "never-shown"
  | "edited-since-read"
  | "changed-since-read";
export interface EditHint {
  kind: EditHintKind;
  text: string;
}

interface PathState {
  shown: Set<string>;
  editedSinceRead: boolean;
}

/** Remembers which anchors the model has seen per file, to explain a stale anchor error. */
export class AnchorTracker {
  private readonly files = new Map<string, PathState>();

  private state(path: string): PathState {
    let s = this.files.get(path);
    if (!s) {
      s = { shown: new Set(), editedSinceRead: false };
      this.files.set(path, s);
      if (this.files.size > MAX_TRACKED_PATHS) {
        const oldest = this.files.keys().next().value;
        if (oldest !== undefined) this.files.delete(oldest);
      }
    }
    return s;
  }

  /** Feed every finished result. `text` is the joined text parts. */
  onResult(tool: string, path: string | undefined, isError: boolean, text: string): void {
    if (!path || isError) return;
    if (tool === "read" || tool === "grep") {
      const s = this.state(path);
      s.editedSinceRead = false;
      for (const m of text.matchAll(ANCHOR_RE)) s.shown.add(m[0]);
    } else if (tool === "edit" || tool === "write") {
      const s = this.state(path);
      s.shown.clear();
      s.editedSinceRead = true;
    }
  }

  /** Hint for an `edit` error text, or undefined when the error is not an anchor error. */
  hintFor(path: string | undefined, errorText: string): EditHint | undefined {
    try {
      if (/E_BAD_REF/.test(errorText)) {
        return {
          kind: "malformed-ref",
          text: boundBytes(
            "Hint: copy each anchor exactly as LINE#HASH from read output (hash = 2 letters of ZPMQVRWSNKTXJBYH). Never invent or shorten one. Read first.",
          ),
        };
      }
      const stale = /E_STALE_ANCHOR/.test(errorText);
      if (!stale) return undefined;
      const s = path ? this.files.get(path) : undefined;
      const list = errorText.match(/stale anchors?: ([^.\n]*)\./)?.[1] ?? "";
      const refs = [...list.matchAll(ANCHOR_RE)].map((m) => m[0]);
      if (s?.editedSinceRead) {
        return {
          kind: "edited-since-read",
          text: boundBytes(
            "Hint: you edited this file after your last read, so lines moved. Read the file again, then edit.",
          ),
        };
      }
      if (refs.length > 0 && refs.every((r) => !s?.shown.has(r))) {
        const line = refs[0]?.split("#")[0] ?? "";
        return {
          kind: "never-shown",
          text: boundBytes(
            `Hint: anchor ${refs[0]} was never shown by a read of this file. Read lines near ${line} (offset/limit) and copy anchors from that output.`,
          ),
        };
      }
      return {
        kind: "changed-since-read",
        text: boundBytes(
          "Hint: the file changed after you read it. Read the lines again, then edit.",
        ),
      };
    } catch {
      return undefined;
    }
  }
}

export const toAbs = (cwd: string, p: string) =>
  isAbsolute(p) ? p : resolve(cwd, p.replace(/^@/, ""));
