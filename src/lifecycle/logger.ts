import * as fs from "fs";
import * as path from "path";
import { LifecycleEntry } from "./tracker";

const LOG_PATH = path.resolve(__dirname, "../../lifecycle-log.json");

export function readLog(): LifecycleEntry[] {
  try {
    const raw = fs.readFileSync(LOG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function appendEntry(entry: LifecycleEntry): void {
  const entries = readLog();
  entries.push(entry);
  fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2));
}

export function getLogPath(): string {
  return LOG_PATH;
}
