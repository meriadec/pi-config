import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { openUrl } from "./open-url.ts";
import type { GitHubClient } from "./github.ts";
import type { ExecFn, GitHubNotificationItem } from "./types.ts";

const POLL_MS = 60_000;
const MIN_BODY_ROWS = 1;
const windowId = process.env["WINDOWID"];

type StatusLevel = "info" | "success" | "error" | "muted";

type PiTheme = {
  fg(color: any, text: string): string;
  bold(text: string): string;
};

export class SupervisorComponent implements Component {
  private items: GitHubNotificationItem[] = [];
  private selected = 0;
  private scroll = 0;
  private busy = false;
  private pendingDone = 0;
  private doneQueue: Promise<void> = Promise.resolve();
  private pendingOpens = 0;
  private openQueue: Promise<void> = Promise.resolve();
  private openingIds = new Set<string>();
  private status = "loading…";
  private statusLevel: StatusLevel = "muted";
  private refreshedAt: Date | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private hasLoadedNotifications = false;
  private viewAll = false;

  private readonly tui: TUI;
  private readonly theme: PiTheme;
  private readonly github: GitHubClient;
  private readonly exec: ExecFn;
  private readonly done: () => void;

  constructor(tui: TUI, theme: PiTheme, github: GitHubClient, exec: ExecFn, done: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.github = github;
    this.exec = exec;
    this.done = done;
    setUrgent(false);
    void this.refresh("loading");
    this.pollTimer = setInterval(() => {
      if (this.isBusy()) {
        this.setStatus("poll skipped: busy", "muted");
        return;
      }
      void this.refresh("poll");
    }, POLL_MS);
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
      this.done();
      return;
    }
    if (matchesKey(data, Key.ctrl("z"))) {
      this.suspend();
      return;
    }

    if (matchesKey(data, Key.down) || data === "j") {
      this.move(1);
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.home) || data === "g") {
      this.select(0);
      return;
    }
    if (matchesKey(data, Key.end) || data === "G") {
      this.select(this.items.length - 1);
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
      this.move(this.bodyRows());
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
      this.move(-this.bodyRows());
      return;
    }
    if (data === "r") {
      void this.refresh("manual");
      return;
    }
    if (data === "a") {
      this.toggleViewAll();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "o") {
      void this.openSelected();
      return;
    }
    if (data === "d") {
      this.markSelectedDone();
      return;
    }
  }

  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    const lines: string[] = [];
    const bodyRows = this.bodyRows(height);

    this.clampSelection();
    this.ensureSelectedVisible(bodyRows);

    lines.push(this.renderTitle(width));
    lines.push(this.renderColumnHeader(width));

    if (this.items.length === 0) {
      const empty = this.busy
        ? this.status
        : this.refreshedAt
          ? `No ${this.viewAll ? "notifications" : "unread notifications"}.`
          : "Loading notifications…";
      lines.push(this.dim(truncateToWidth(empty, width)));
      while (lines.length < 2 + bodyRows) lines.push("");
    } else {
      for (let row = 0; row < bodyRows; row++) {
        const item = this.items[this.scroll + row];
        lines.push(item ? this.renderRow(item, this.scroll + row === this.selected, width) : "");
      }
    }

    lines.push(this.renderDetail(width));
    lines.push(this.renderStatus(width));
    lines.push(
      this.dim(
        truncateToWidth(
          "👀 review · ✅ merged/closed · 📝 draft · 🟢 open · 💬 other · j/k move · enter/o open · d done · a all/unread · r refresh · q close",
          width,
        ),
      ),
    );

    return fitLines(lines, width, height);
  }

  invalidate(): void {}

  private async refresh(source: "loading" | "manual" | "poll" | "switch"): Promise<void> {
    const initialStatus =
      source === "loading"
        ? "loading…"
        : source === "switch"
          ? `switching to ${this.viewAll ? "all" : "unread"}…`
          : "refreshing…";
    await this.withBusy(initialStatus, async () => {
      const previousIds = new Set(this.items.map((item) => item.id));
      const notifications = await this.github.listNotifications({ all: this.viewAll });
      const newCount = this.hasLoadedNotifications
        ? notifications.filter((item) => !previousIds.has(item.id)).length
        : 0;
      this.items = notifications;
      this.hasLoadedNotifications = true;
      this.refreshedAt = new Date();
      this.clampSelection();
      this.ensureSelectedVisible(this.bodyRows());
      if (newCount > 0) {
        setUrgent(true);
        this.setStatus(
          `${newCount} new · refreshed ${formatClock(this.refreshedAt)} · ${this.formatCounts()}`,
          "success",
        );
      } else {
        this.setStatus(
          `refreshed ${formatClock(this.refreshedAt)} · ${this.formatCounts()}`,
          "success",
        );
      }
    });
  }

  private openSelected(): void {
    const item = this.items[this.selected];
    if (!item) {
      this.setStatus("nothing to open", "muted");
      return;
    }
    if (this.busy || this.pendingDone > 0) {
      this.setStatus("busy", "muted");
      return;
    }

    this.pendingOpens++;
    this.openingIds.add(item.id);
    this.setStatus(`queued open: ${shortItem(item)} · ${this.pendingOpens} pending`, "muted");
    this.requestRender();
    this.openQueue = this.openQueue.then(() => this.commitOpen(item));
  }

  private async commitOpen(item: GitHubNotificationItem): Promise<void> {
    this.setStatus(`opening: ${shortItem(item)}… · ${this.pendingOpens} pending`, "muted");
    try {
      const htmlUrl = await this.github.resolveHtmlUrl(item);
      const opener = await openUrl(this.exec, htmlUrl);
      this.setStatus(`opened with ${opener}: ${shortItem(item)}`, "success");
    } catch (error) {
      this.setStatus(errorMessage(error), "error");
    } finally {
      this.pendingOpens = Math.max(0, this.pendingOpens - 1);
      this.openingIds.delete(item.id);
      this.requestRender();
    }
  }

  private markSelectedDone(): void {
    const item = this.items[this.selected];
    if (!item) {
      this.setStatus("nothing to mark done", "muted");
      return;
    }

    if (this.busy) {
      this.setStatus("busy", "muted");
      return;
    }

    const originalIndex = this.selected;
    this.items.splice(originalIndex, 1);
    this.pendingDone++;
    this.clampSelection();
    this.ensureSelectedVisible(this.bodyRows());
    this.setStatus(`queued done: ${shortItem(item)} · ${this.pendingDone} pending`, "muted");
    this.requestRender();

    this.doneQueue = this.doneQueue.then(() => this.commitDone(item, originalIndex));
  }

  private async commitDone(item: GitHubNotificationItem, originalIndex: number): Promise<void> {
    this.setStatus(`marking done: ${shortItem(item)}… · ${this.pendingDone} pending`, "muted");
    try {
      await this.github.markDone(item.id);
      this.setStatus(`marked done: ${shortItem(item)}`, "success");
    } catch (error) {
      this.items.splice(Math.min(originalIndex, this.items.length), 0, item);
      this.selected = Math.min(originalIndex, this.items.length - 1);
      this.ensureSelectedVisible(this.bodyRows());
      this.setStatus(errorMessage(error), "error");
    } finally {
      this.pendingDone = Math.max(0, this.pendingDone - 1);
      this.requestRender();
    }
  }

  private async withBusy(initialStatus: string, fn: () => Promise<void>): Promise<void> {
    if (this.isBusy()) {
      this.setStatus("busy", "muted");
      return;
    }

    this.busy = true;
    this.setStatus(initialStatus, "muted");
    try {
      await fn();
    } catch (error) {
      this.setStatus(errorMessage(error), "error");
    } finally {
      this.busy = false;
      this.requestRender();
    }
  }

  private isBusy(): boolean {
    return this.busy || this.pendingDone > 0 || this.pendingOpens > 0;
  }

  private toggleViewAll(): void {
    if (this.isBusy()) {
      this.setStatus("busy", "muted");
      return;
    }
    this.viewAll = !this.viewAll;
    this.hasLoadedNotifications = false;
    this.setStatus(this.viewAll ? "switching to all…" : "switching to unread…", "muted");
    void this.refresh("switch");
  }

  private suspend(): void {
    if (process.platform === "win32") {
      this.setStatus("suspend unsupported on Windows", "error");
      return;
    }

    const suspendKeepAlive = setInterval(() => {}, 2 ** 30);
    const ignoreSigint = () => {};
    process.on("SIGINT", ignoreSigint);
    process.once("SIGCONT", () => {
      clearInterval(suspendKeepAlive);
      process.removeListener("SIGINT", ignoreSigint);
      this.tui.start();
      this.tui.requestRender(true);
    });

    try {
      this.tui.stop();
      process.kill(0, "SIGTSTP");
    } catch (error) {
      clearInterval(suspendKeepAlive);
      process.removeListener("SIGINT", ignoreSigint);
      this.setStatus(errorMessage(error), "error");
    }
  }

  private move(delta: number): void {
    this.select(this.selected + delta);
  }

  private select(index: number): void {
    if (this.items.length === 0) {
      this.selected = 0;
      this.scroll = 0;
    } else {
      this.selected = Math.max(0, Math.min(this.items.length - 1, index));
      this.ensureSelectedVisible(this.bodyRows());
    }
    this.requestRender();
  }

  private clampSelection(): void {
    if (this.items.length === 0) {
      this.selected = 0;
      this.scroll = 0;
      return;
    }
    this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected));
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.items.length - 1)));
  }

  private ensureSelectedVisible(bodyRows: number): void {
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + bodyRows) this.scroll = this.selected - bodyRows + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.items.length - bodyRows)));
  }

  private bodyRows(height = this.tui.terminal.rows): number {
    return Math.max(MIN_BODY_ROWS, height - 5);
  }

  private renderTitle(width: number): string {
    const left = this.theme.fg("accent", this.theme.bold("Supervisor GitHub Inbox"));
    const rightParts = [this.formatCounts()];
    if (this.refreshedAt) rightParts.push(`refreshed ${formatClock(this.refreshedAt)}`);
    if (this.busy) rightParts.push("busy");
    if (this.pendingDone > 0) rightParts.push(`done ${this.pendingDone}`);
    if (this.pendingOpens > 0) rightParts.push(`opening ${this.pendingOpens}`);
    const right = rightParts.join(" · ");
    const spaces = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return truncateToWidth(left + " ".repeat(spaces) + this.dim(right), width);
  }

  private renderColumnHeader(width: number): string {
    return this.dim(
      this.theme.bold(
        truncateToWidth(
          formatColumns(
            {
              signal: "",
              age: "AGE",
              reason: "REASON",
              type: "TYPE",
              repo: "REPO",
              author: "AUTHOR",
              title: "TITLE",
            },
            false,
            width,
          ),
          width,
        ),
      ),
    );
  }

  private renderRow(item: GitHubNotificationItem, selected: boolean, width: number): string {
    const raw = formatColumns(
      {
        signal: notificationSignal(item).emoji,
        age: formatAge(item.updatedAt),
        reason: item.reason,
        type: displaySubjectType(item.subject.type),
        repo: item.repository,
        author: item.author ?? "",
        title: `${this.openingIds.has(item.id) ? "[opening] " : ""}${cleanTitle(item.subject.title)}`,
      },
      selected,
      width,
    );
    const line = truncateToWidth(raw, width);
    if (selected) return this.theme.fg("accent", line);
    return item.unread ? line : this.dim(line);
  }

  private renderDetail(width: number): string {
    const item = this.items[this.selected];
    if (!item) return this.dim(truncateToWidth("No selection", width));
    const signal = notificationSignal(item);
    const readState = item.unread ? "unread" : "read";
    return this.dim(
      truncateToWidth(
        `${signal.emoji} ${signal.label} · ${readState} · ${item.repository} · ${displaySubjectType(item.subject.type)}${item.author ? ` by ${item.author}` : ""} · ${item.reason} · updated ${formatDateTime(item.updatedAt)}`,
        width,
      ),
    );
  }

  private formatCounts(): string {
    return `${this.viewAll ? "all" : "unread"} · ${formatCounts(this.items)}`;
  }

  private renderStatus(width: number): string {
    const line = truncateToWidth(this.status, width);
    if (this.statusLevel === "error") return this.theme.fg("error", line);
    if (this.statusLevel === "success") return this.theme.fg("success", line);
    return this.dim(line);
  }

  private setStatus(status: string, level: StatusLevel): void {
    this.status = status;
    this.statusLevel = level;
    this.requestRender();
  }

  private requestRender(): void {
    this.tui.requestRender();
  }

  private dim(text: string): string {
    return this.theme.fg("dim", text);
  }
}

interface ColumnValues {
  signal: string;
  age: string;
  reason: string;
  type: string;
  repo: string;
  author: string;
  title: string;
}

function formatColumns(values: ColumnValues, selected: boolean, width: number): string {
  const layout = columnLayout(width);
  const prefix = selected ? "› " : "  ";
  return truncateToWidth(
    prefix +
      cell(values.signal, layout.signal) +
      " " +
      cell(values.age, layout.age) +
      " " +
      cell(values.reason, layout.reason) +
      " " +
      cell(values.type, layout.type) +
      " " +
      cell(values.repo, layout.repo) +
      " " +
      cell(values.author, layout.author) +
      " " +
      cell(values.title, layout.title),
    width,
  );
}

function columnLayout(width: number): {
  signal: number;
  age: number;
  reason: number;
  type: number;
  repo: number;
  author: number;
  title: number;
} {
  const prefix = 2;
  const gaps = 6;
  const layout = { signal: 2, age: 4, reason: 16, type: 5, repo: 22, author: 14, title: 10 };

  let overflow =
    prefix +
    gaps +
    layout.signal +
    layout.age +
    layout.reason +
    layout.type +
    layout.repo +
    layout.author +
    layout.title -
    width;
  if (overflow > 0) overflow = shrink(layout, "repo", 12, overflow);
  if (overflow > 0) overflow = shrink(layout, "author", 8, overflow);
  if (overflow > 0) overflow = shrink(layout, "reason", 8, overflow);
  if (overflow > 0) overflow = shrink(layout, "type", 3, overflow);

  layout.title = Math.max(
    1,
    width -
      prefix -
      gaps -
      layout.signal -
      layout.age -
      layout.reason -
      layout.type -
      layout.repo -
      layout.author,
  );
  return layout;
}

function shrink<T extends "repo" | "reason" | "type" | "author">(
  layout: { repo: number; reason: number; type: number; author: number },
  key: T,
  min: number,
  overflow: number,
): number {
  const amount = Math.min(overflow, Math.max(0, layout[key] - min));
  layout[key] -= amount;
  return overflow - amount;
}

function cell(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function fitLines(lines: string[], width: number, height: number): string[] {
  const fitted = lines.slice(0, height).map((line) => truncateToWidth(line, width));
  while (fitted.length < height) fitted.push("");
  return fitted;
}

function displaySubjectType(type: string): string {
  if (type === "PullRequest") return "PR";
  return type;
}

function notificationSignal(item: GitHubNotificationItem): { emoji: string; label: string } {
  if (item.subject.type !== "PullRequest") return { emoji: "💬", label: "notification" };

  const pullRequest = item.pullRequest;
  if (pullRequest?.merged || (pullRequest?.state && pullRequest.state !== "OPEN"))
    return { emoji: "✅", label: "merged/closed" };
  if (pullRequest?.isDraft) return { emoji: "📝", label: "draft" };
  if (item.reason === "review_requested" || pullRequest?.reviewDecision === "REVIEW_REQUIRED") {
    return { emoji: "👀", label: "review needed" };
  }
  return { emoji: "🟢", label: "open PR" };
}

function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

function shortItem(item: GitHubNotificationItem): string {
  return `${item.repository} · ${cleanTitle(item.subject.title)}`;
}

function formatCounts(items: GitHubNotificationItem[]): string {
  const unread = items.filter((item) => item.unread).length;
  return `${items.length} shown · ${unread} unread`;
}

function formatAge(iso: string): string {
  const then = new Date(iso).getTime();
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function setUrgent(urgent: boolean): void {
  if (!windowId) return;
  execFile("xdotool", ["set_window", "--urgency", urgent ? "1" : "0", windowId], () => {});
}

function errorMessage(error: unknown): string {
  return `error: ${error instanceof Error ? error.message : String(error)}`;
}
