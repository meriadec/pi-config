import { Input, type Component, type Focusable } from "@earendil-works/pi-tui";

export interface StandardTextEntryOptions {
  readonly initialValue?: string;
  /** Replace pasted line breaks with spaces instead of removing them. */
  readonly lineBreaks?: "remove" | "space";
}

/** Reusable single-line text entry that keeps the standard Pi TUI editing behavior. */
export class StandardTextEntry implements Component, Focusable {
  private readonly input = new Input();
  private readonly lineBreaks: "remove" | "space";
  private disposed = false;

  constructor(options: StandardTextEntryOptions = {}) {
    this.lineBreaks = options.lineBreaks ?? "remove";
    const initialValue = this.normalize(options.initialValue ?? "");
    if (initialValue.length > 0) this.input.handleInput(initialValue);
  }

  get focused(): boolean {
    return !this.disposed && this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = !this.disposed && value;
  }

  getValue(): string {
    return this.input.getValue();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    this.input.handleInput(this.normalize(data));
  }

  render(width: number): string[] {
    return this.input.render(width);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.input.focused = false;
  }

  private normalize(value: string): string {
    return this.lineBreaks === "space" ? value.replace(/\r\n?|\n|\u2028|\u2029/g, " ") : value;
  }
}
