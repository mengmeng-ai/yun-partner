// Local scheduled tasks — Phase 3, clean-room implementation.
// Plain JSON store under userData. No external cron, no setInterval side
// effects on import: the coordinator calls checkDue() (e.g. once a minute
// and once on unlock) and acts on what it returns.
// Missed tasks: a task whose scheduled time passed while the app was closed
// is reported (up to 7 days back) on unlock via missedSince(lastSeen) —
// the owner decides whether to catch up, matching the public Aivy docs.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type ScheduleAction = 'remind' | 'run';

/** Either a daily time ({minute, hour}) or a repeating interval. */
export type ScheduleSpec = { minute: number; hour: number } | { intervalMinutes: number };

export function isDailySpec(spec: ScheduleSpec): spec is { minute: number; hour: number } {
  return 'hour' in spec;
}

export interface ScheduledTask {
  id: string;
  title: string;
  schedule: ScheduleSpec;
  action: ScheduleAction;
  /** Free-form payload: reminder text, or the command / instruction to run. */
  payload: string;
  enabled: boolean;
  lastRun: string | null; // ISO timestamp of the last time it fired
  /** How many occurrences were missed while the app was closed (7-day window). */
  missed: number;
}

interface StoreFile {
  version: 1;
  tasks: ScheduledTask[];
}

const MISSED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function isDueDaily(task: ScheduledTask, now: Date): boolean {
  if (!isDailySpec(task.schedule)) return false;
  if (now.getHours() !== task.schedule.hour || now.getMinutes() !== task.schedule.minute) return false;
  if (!task.lastRun) return true;
  const last = new Date(task.lastRun);
  // Already fired in this same minute.
  return (
    last.getFullYear() !== now.getFullYear() ||
    last.getMonth() !== now.getMonth() ||
    last.getDate() !== now.getDate() ||
    last.getHours() !== now.getHours() ||
    last.getMinutes() !== now.getMinutes()
  );
}

function isDueInterval(task: ScheduledTask, now: Date): boolean {
  if (isDailySpec(task.schedule)) return false;
  if (!task.lastRun) return true;
  return now.getTime() - new Date(task.lastRun).getTime() >= task.schedule.intervalMinutes * 60_000;
}

export class SchedulerStore {
  constructor(private filePath: string) {}

  private read(): ScheduledTask[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as StoreFile;
      return Array.isArray(raw.tasks) ? raw.tasks : [];
    } catch {
      return [];
    }
  }

  private write(tasks: ScheduledTask[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, tasks } satisfies StoreFile, null, 2), 'utf-8');
  }

  list(): ScheduledTask[] {
    return this.read();
  }

  add(input: {
    title: string;
    schedule: ScheduleSpec;
    action: ScheduleAction;
    payload: string;
  }): ScheduledTask {
    const tasks = this.read();
    const task: ScheduledTask = {
      id: crypto.randomUUID(),
      title: input.title,
      schedule: input.schedule,
      action: input.action,
      payload: input.payload,
      enabled: true,
      lastRun: null,
      missed: 0,
    };
    tasks.push(task);
    this.write(tasks);
    return task;
  }

  remove(id: string): boolean {
    const tasks = this.read();
    const next = tasks.filter((t) => t.id !== id);
    if (next.length === tasks.length) return false;
    this.write(next);
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const tasks = this.read();
    const task = tasks.find((t) => t.id === id);
    if (!task) return false;
    task.enabled = enabled;
    this.write(tasks);
    return true;
  }

  /** Mark a task as having run now (or at `at`). Call after acting on it. */
  markRun(id: string, at: Date = new Date()): boolean {
    const tasks = this.read();
    const task = tasks.find((t) => t.id === id);
    if (!task) return false;
    task.lastRun = at.toISOString();
    task.missed = 0;
    this.write(tasks);
    return true;
  }

  /**
   * Tasks due right now. Does NOT mark them run — the coordinator acts on
   * the returned list, then calls markRun(id) for each one it handled.
   * `missed` here lists tasks whose last scheduled time already passed
   * today (daily) or whose interval already elapsed, so a caller polling
   * less often than every minute still sees them.
   */
  checkDue(now: Date = new Date()): { due: ScheduledTask[]; missed: ScheduledTask[] } {
    const tasks = this.read().filter((t) => t.enabled);
    const due: ScheduledTask[] = [];
    const missed: ScheduledTask[] = [];
    for (const task of tasks) {
      if (isDueDaily(task, now) || isDueInterval(task, now)) {
        due.push(task);
        continue;
      }
      // Overdue but not in this exact minute: daily task whose time today
      // already passed and which has not run today; interval task past due.
      if (isDailySpec(task.schedule)) {
        const todayAt = new Date(now);
        todayAt.setHours(task.schedule.hour, task.schedule.minute, 0, 0);
        if (now.getTime() > todayAt.getTime()) {
          const last = task.lastRun ? new Date(task.lastRun) : null;
          const ranToday =
            last !== null &&
            last.getFullYear() === now.getFullYear() &&
            last.getMonth() === now.getMonth() &&
            last.getDate() === now.getDate() &&
            last.getTime() >= todayAt.getTime();
          if (!ranToday) missed.push(task);
        }
      } else if (task.lastRun && now.getTime() - new Date(task.lastRun).getTime() >= task.schedule.intervalMinutes * 60_000) {
        missed.push(task);
      }
    }
    return { due, missed };
  }

  /**
   * Missed occurrences between `lastSeen` (last time the app was open) and
   * `now`, capped to the last 7 days. Call on unlock; the owner decides
   * whether to catch up. Counts occurrences, not just tasks, and stores the
   * count on each task's `missed` field.
   */
  missedSince(lastSeen: Date, now: Date = new Date()): ScheduledTask[] {
    const windowStart = new Date(Math.max(lastSeen.getTime(), now.getTime() - MISSED_WINDOW_MS));
    const tasks = this.read().filter((t) => t.enabled);
    const result: ScheduledTask[] = [];
    for (const task of tasks) {
      let count = 0;
      if (isDailySpec(task.schedule)) {
        const day = new Date(windowStart);
        day.setHours(0, 0, 0, 0);
        for (let i = 0; i < 8; i++) {
          const at = new Date(day);
          at.setDate(day.getDate() + i);
          at.setHours(task.schedule.hour, task.schedule.minute, 0, 0);
          if (at.getTime() <= windowStart.getTime() || at.getTime() > now.getTime()) continue;
          const last = task.lastRun ? new Date(task.lastRun) : null;
          if (!last || last.getTime() < at.getTime()) count++;
        }
      } else {
        const intervalMs = task.schedule.intervalMinutes * 60_000;
        const last = task.lastRun ? new Date(task.lastRun).getTime() : windowStart.getTime();
        const from = Math.max(last, windowStart.getTime());
        count = Math.floor((now.getTime() - from) / intervalMs);
      }
      if (count > 0) {
        task.missed = count;
        result.push({ ...task });
      }
    }
    if (result.length > 0) {
      const all = this.read();
      for (const hit of result) {
        const t = all.find((x) => x.id === hit.id);
        if (t) t.missed = hit.missed;
      }
      this.write(all);
    }
    return result;
  }
}

/** Default store path helper: <userData>/scheduler.json */
export function defaultSchedulerPath(userDataDir: string): string {
  return path.join(userDataDir, 'scheduler.json');
}
