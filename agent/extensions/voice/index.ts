import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTranscriber } from "./transcriber.ts";
import { isKittyProtocolActive, matchesKey, type KeyId } from "@earendil-works/pi-tui";

// Env (read by daemon.py): PI_VOICE_MODEL (default "small"), PI_VOICE_LANG (default: auto-detect).
const DAEMON = join(dirname(fileURLToPath(import.meta.url)), "daemon.py");
// Push-to-talk key: hold to record, release to transcribe.
const PTT_KEY = (process.env["PI_VOICE_KEY"] ?? "f9") as KeyId;
// Without Kitty key-release events, treat "no key repeat for this long" as release.
const RELEASE_TIMEOUT_MS = 700;

interface Recording {
  proc: ChildProcess;
  dir: string;
  wav: string;
  exited: Promise<void>;
}

export default function voiceExtension(pi: ExtensionAPI): void {
  const transcriber = createTranscriber("uv", ["run", "--quiet", "--script", DAEMON]);
  let rec: Recording | undefined;
  let busy = false;

  const toggle = async (ctx: ExtensionContext): Promise<void> => {
    if (busy) return;
    if (!rec) return start(ctx);
    busy = true;
    try {
      await stopAndTranscribe(ctx);
    } finally {
      busy = false;
    }
  };

  async function start(ctx: ExtensionContext): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "pi-voice-"));
    const wav = join(dir, "in.wav");
    const proc = spawn("arecord", ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", wav], {
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.once("error", (err) => {
        ctx.ui.notify(`Recording failed: ${err.message}`, "error");
        rec = undefined;
        resolve();
      });
    });
    rec = { proc, dir, wav, exited };
    ctx.ui.setStatus("voice", "🎙 recording… (/voice to stop)");
  }

  async function stopAndTranscribe(ctx: ExtensionContext): Promise<void> {
    const current = rec;
    if (!current) return;
    rec = undefined;
    current.proc.kill("SIGINT"); // lets arecord finalize the WAV header
    await current.exited;
    ctx.ui.setStatus("voice", "⏳ transcribing…");
    try {
      const text = (await transcriber.transcribe(current.wav)).trim();
      if (text.length === 0) {
        ctx.ui.notify("No speech detected.", "warning");
        return;
      }
      const existing = ctx.ui.getEditorText();
      ctx.ui.setEditorText(existing.length > 0 ? `${existing} ${text}` : text);
    } catch (err) {
      ctx.ui.notify(
        `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      ctx.ui.setStatus("voice", undefined);
      await rm(current.dir, { recursive: true, force: true });
    }
  }

  pi.registerCommand("voice", {
    description: "Start/stop voice recording; transcribe with Whisper into the editor",
    handler: async (_args, ctx) => toggle(ctx),
  });

  let unsubscribe: (() => void) | undefined;
  let held = false;
  let starting: Promise<void> = Promise.resolve();
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;

  const release = (ctx: ExtensionContext): void => {
    if (!held) return;
    held = false;
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = undefined;
    void starting.then(() => (rec ? toggle(ctx) : undefined));
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    transcriber.warmUp(); // load the model while the user is not talking yet
    unsubscribe?.();
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      const ev = parsePttEvent(data);
      if (!ev) return undefined;
      if (ev === "release") {
        release(ctx);
        return { consume: true };
      }
      if (!held) {
        held = true;
        starting = toggle(ctx);
      }
      if (!isKittyProtocolActive()) {
        if (releaseTimer) clearTimeout(releaseTimer);
        releaseTimer = setTimeout(() => release(ctx), RELEASE_TIMEOUT_MS);
      }
      return { consume: true };
    });
  });

  pi.on("session_shutdown", async () => {
    unsubscribe?.();
    unsubscribe = undefined;
    transcriber.close();
    if (releaseTimer) clearTimeout(releaseTimer);
    if (!rec) return;
    const current = rec;
    rec = undefined;
    current.proc.kill("SIGKILL");
    await rm(current.dir, { recursive: true, force: true });
  });
}

/**
 * Kitty reports event types as `CSI code;mods:type~` (1=press, 2=repeat, 3=release).
 * pi-tui's matchesKey rejects that form for function keys, so strip it first.
 */
const CSI = "\u001b[";

function parsePttEvent(data: string): "press" | "release" | undefined {
  const m = data.startsWith(CSI)
    ? /^(\d+)(?:;(\d+)(?::(\d))?)?([~A-Z])$/.exec(data.slice(2))
    : null;
  if (m) {
    const [, head, mods, type, end] = m;
    const plain = `${CSI}${head}${mods && mods !== "1" ? `;${mods}` : ""}${end}`;
    if (!matchesKey(plain, PTT_KEY)) return undefined;
    return type === "3" ? "release" : "press";
  }
  return matchesKey(data, PTT_KEY) ? "press" : undefined;
}
