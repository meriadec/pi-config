import { execFileSync, spawn } from "node:child_process";
import { platform } from "node:os";

export async function copyTextToClipboard(text: string): Promise<void> {
  const errors: string[] = [];

  for (const method of getClipboardMethods()) {
    try {
      await method.copy(text);
      return;
    } catch (error) {
      errors.push(`${method.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (emitOsc52(text)) return;

  throw new Error(errors.length > 0 ? errors.join("; ") : "no clipboard backend available");
}

interface ClipboardMethod {
  name: string;
  copy(text: string): Promise<void> | void;
}

function getClipboardMethods(): ClipboardMethod[] {
  const methods: ClipboardMethod[] = [];
  const currentPlatform = platform();

  if (currentPlatform === "darwin") {
    methods.push(syncCommandMethod("pbcopy", "pbcopy", []));
    return methods;
  }

  if (currentPlatform === "win32") {
    methods.push(syncCommandMethod("clip", "clip", []));
    return methods;
  }

  if (process.env.TERMUX_VERSION) {
    methods.push(syncCommandMethod("termux-clipboard-set", "termux-clipboard-set", []));
  }

  if (process.env.WAYLAND_DISPLAY) {
    methods.push(detachedPipeMethod("wl-copy", "wl-copy", []));
  }

  if (process.env.DISPLAY) {
    methods.push(detachedPipeMethod("xclip", "xclip", ["-selection", "clipboard"]));
    methods.push(detachedPipeMethod("xsel", "xsel", ["--clipboard", "--input"]));
  }

  if (process.env.KITTY_WINDOW_ID) {
    methods.push(syncCommandMethod("kitty clipboard", "kitty", ["+kitten", "clipboard"]));
  }

  return methods;
}

function syncCommandMethod(name: string, command: string, args: string[]): ClipboardMethod {
  return {
    name,
    copy(text: string): void {
      execFileSync(command, args, {
        input: text,
        timeout: 1000,
        stdio: ["pipe", "ignore", "pipe"],
      });
    },
  };
}

function detachedPipeMethod(name: string, command: string, args: string[]): ClipboardMethod {
  return {
    name,
    async copy(text: string): Promise<void> {
      execFileSync("which", [command], { stdio: "ignore", timeout: 1000 });
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], detached: true });
        let settled = false;
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };

        proc.on("error", settle);
        proc.stdin.on("error", settle);
        proc.stdin.end(text, () => {
          proc.unref();
          settle();
        });
      });
    },
  };
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function emitOsc52(text: string): boolean {
  const encoded = Buffer.from(text).toString("base64");
  if (encoded.length > MAX_OSC52_ENCODED_LENGTH) return false;
  process.stdout.write(`\x1b]52;c;${encoded}\x07`);
  return true;
}
