import { homedir } from "node:os";
import { join } from "node:path";

export interface WorkPathOptions {
  home?: string;
  runtime?: string;
}

export interface WorkPaths {
  root: string;
  config: string;
  socket: string;
}

export function createWorkPaths(options: WorkPathOptions = {}): WorkPaths {
  const home = options.home ?? homedir();
  const runtime = options.runtime ?? process.env["XDG_RUNTIME_DIR"];
  if (runtime === undefined || runtime.length === 0) {
    throw new Error("XDG_RUNTIME_DIR is required for the work daemon socket.");
  }
  const root = join(home, "work");
  return {
    root,
    config: join(root, "config.json"),
    socket: join(runtime, "pi-workd.sock"),
  };
}
