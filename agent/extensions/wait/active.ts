/** Waits that block a tool call now. In memory only: a wait ends with its turn. */
export interface ActiveWait {
  id: string;
  label: string;
  controller: AbortController;
}

export class ActiveWaits {
  private readonly items = new Map<string, ActiveWait>();
  private seq = 0;

  /** The wait aborts when `parent` aborts (the Stop button) or when `cancel` runs. */
  start(label: string, parent?: AbortSignal): ActiveWait {
    const controller = new AbortController();
    parent?.addEventListener("abort", () => controller.abort(), { once: true });
    if (parent?.aborted) controller.abort();
    const item = { id: `w${++this.seq}`, label, controller };
    this.items.set(item.id, item);
    return item;
  }

  finish(id: string): void {
    this.items.delete(id);
  }

  cancel(id: string): boolean {
    const item = this.items.get(id);
    item?.controller.abort();
    return item !== undefined;
  }

  cancelAll(): void {
    for (const i of this.items.values()) i.controller.abort();
  }

  list(): ActiveWait[] {
    return [...this.items.values()];
  }
}
