import { execFile } from "node:child_process";

const windowId = process.env["WINDOWID"];

export function setDesktopUrgent(urgent: boolean): void {
  if (!windowId) return;

  execFile("xdotool", ["set_window", "--urgency", urgent ? "1" : "0", windowId], () => {});
}
