import { describeLeftovers, type TaggedProcess } from "./procscan.ts";
import { mayStartBackground } from "./registry.ts";

/**
 * Option C: tell the thread about processes that outlive the turn. The scan reads /proc for
 * each process of the user, so it runs only after a bash command that may have started one.
 */
export class LeftoverWatch {
  private seen = false;
  private announced = "";
  private readonly scan: () => Promise<TaggedProcess[]>;
  private readonly announce: (note: string) => void;

  constructor(scan: () => Promise<TaggedProcess[]>, announce: (note: string) => void) {
    this.scan = scan;
    this.announce = announce;
  }

  noteBashCommand(command: string): void {
    if (mayStartBackground(command)) this.seen = true;
  }

  async onAgentEnd(): Promise<void> {
    if (!this.seen) return;
    const found = await this.scan().catch(() => []);
    this.seen = found.length > 0;
    const note = describeLeftovers(found);
    if (note === this.announced) return;
    this.announced = note;
    if (note) this.announce(note);
  }
}
