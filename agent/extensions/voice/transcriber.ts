import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface Transcriber {
  /** Transcribe a WAV file. Starts the worker on first use and keeps the model loaded. */
  transcribe(wav: string): Promise<string>;
  /** Start the worker early so the model is loaded before the first recording. */
  warmUp(): void;
  close(): void;
}

interface Pending {
  resolve(text: string): void;
  reject(err: Error): void;
}

export function createTranscriber(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Transcriber {
  let proc: ChildProcess | undefined;
  let ready: Promise<void> | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  function failAll(err: Error): void {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  function ensure(): Promise<void> {
    if (ready) return ready;
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    proc = child;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-800);
    });
    ready = new Promise<void>((resolveReady, rejectReady) => {
      const reset = (err: Error): void => {
        rejectReady(err);
        failAll(err);
        proc = undefined;
        ready = undefined;
      };
      child.once("error", (err) => reset(err));
      child.once("exit", (code) =>
        reset(new Error(stderr.trim() || `worker exited with code ${code}`)),
      );
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let msg: { ready?: boolean; id?: number; text?: string; error?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          return; // ignore non-protocol output
        }
        if (msg.ready) return resolveReady();
        const p = msg.id === undefined ? undefined : pending.get(msg.id);
        if (!p || msg.id === undefined) return;
        pending.delete(msg.id);
        if (msg.error !== undefined) p.reject(new Error(msg.error));
        else p.resolve(msg.text ?? "");
      });
    });
    ready.catch(() => {}); // surfaced through transcribe(); avoid unhandled rejection on warm-up
    return ready;
  }

  return {
    warmUp() {
      void ensure();
    },
    async transcribe(wav) {
      await ensure();
      const child = proc;
      if (!child?.stdin) throw new Error("worker not running");
      const id = nextId++;
      return new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin!.write(`${JSON.stringify({ id, wav })}\n`);
      });
    },
    close() {
      const child = proc;
      proc = undefined;
      ready = undefined;
      failAll(new Error("transcriber closed"));
      child?.kill("SIGTERM");
    },
  };
}
