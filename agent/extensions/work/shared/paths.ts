import { homedir } from "node:os";
import { join } from "node:path";

export interface WorkPathOptions {
  home?: string;
  runtime?: string;
}

export interface WorkPaths {
  root: string;
  config: string;
  topics: string;
  affiliations: string;
  socket: string;
  topicDirectory(id: string): string;
  topicManifest(id: string): string;
}

export function createWorkPaths(options: WorkPathOptions = {}): WorkPaths {
  const home = options.home ?? homedir();
  const runtime = options.runtime ?? process.env["XDG_RUNTIME_DIR"];
  if (runtime === undefined || runtime.length === 0) {
    throw new Error("XDG_RUNTIME_DIR is required for the work daemon socket.");
  }
  const root = join(home, "work");
  const topics = join(root, "topics");
  return {
    root,
    config: join(root, "config.json"),
    topics,
    affiliations: join(root, "affiliations.json"),
    socket: join(runtime, "pi-workd.sock"),
    topicDirectory: (id) => join(topics, id),
    topicManifest: (id) => join(topics, id, "topic.json"),
  };
}
