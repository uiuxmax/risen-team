import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { closeDatabaseForTests } from "@/db";
import { ensureSeeded } from "@/lib/server/seed";
import { exportBackup, importBackup, scheduleAction } from "@/lib/server/admin";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "risen-archived-backup-"));
const previousDbPath = process.env.RISEN_DB_PATH;
beforeAll(() => {
  process.env.RISEN_DB_PATH = path.join(tempDir, "workspace.db");
  ensureSeeded();
});
afterAll(() => {
  closeDatabaseForTests();
  if (previousDbPath === undefined) delete process.env.RISEN_DB_PATH;
  else process.env.RISEN_DB_PATH = previousDbPath;
  fs.rmSync(tempDir, { recursive: true, force: true });
});
it("round-trips an all-archived workspace through replace import without activating an archived schedule", async () => {
  for (const schedule of exportBackup().schedules) await scheduleAction({ action: "archive", id: schedule.id });
  const backup = exportBackup();
  expect(backup.schedules.every(schedule => schedule.isArchived && !schedule.isActive)).toBe(true);
  expect(() => importBackup(backup, "replace")).not.toThrow();
  const { exportedAt: _beforeAt, ...before } = backup;
  const { exportedAt: _afterAt, ...after } = exportBackup();
  expect(after).toEqual(before);
});
