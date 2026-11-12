/** Option C: remember long-lived processes so none is forgotten. Pure state, no I/O. */
export interface TrackedProcess {
  pid: number;
  label: string;
  command: string;
  startedAt: number;
  exitedAt?: number;
}

const LONG_LIVED =
  /\b(dev|serve|start|watch|storybook|vite|next|nodemon|tail -f|docker compose up)\b/;

export function looksLongLived(command: string): boolean {
  return LONG_LIVED.test(command);
}

export class ProcessRegistry {
  private readonly items = new Map<number, TrackedProcess>();

  register(p: Omit<TrackedProcess, "exitedAt">): void {
    this.items.set(p.pid, { ...p });
  }

  markExited(pid: number, at: number): void {
    const p = this.items.get(pid);
    if (p) p.exitedAt = at;
  }

  alive(): TrackedProcess[] {
    return [...this.items.values()].filter((p) => p.exitedAt === undefined);
  }

  /** Short note appended to the agent turn end. Empty when nothing is alive. */
  endOfTurnNote(now: number): string {
    const alive = this.alive();
    if (alive.length === 0) return "";
    const lines = alive.map(
      (p) => `- pid ${p.pid} ${p.label} (up ${Math.round((now - p.startedAt) / 60_000)} min)`,
    );
    return `${alive.length} background process(es) still running:\n${lines.join("\n")}\nStop them if no longer needed.`;
  }
}
