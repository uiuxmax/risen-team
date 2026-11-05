#!/usr/bin/env node
// Real-browser acceptance checks against an isolated production workspace.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import sharp from "sharp";
import Database from "better-sqlite3";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "Risen browser Київ "));
const workspaceId = randomUUID();
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ format: "risen-team-project", formatVersion: 1, workspaceId, createdAt: new Date().toISOString() }));
const output = path.resolve("docs/audit/browser-previews");
fs.mkdirSync(output, { recursive: true });
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const serverPath = process.argv.find(arg => arg.startsWith("--server="))?.slice(9) ?? "dist/portable/RisenTeamSchedule/server.js";
const environment = { ...process.env, RISEN_WORKSPACE_PATH: root, HOSTNAME: "127.0.0.1", PORT: String(port) };
delete environment.RISEN_DB_PATH;
const child = spawn(process.execPath, ["--require", path.resolve("native/desktop-shutdown.cjs"), path.resolve(serverPath)], { env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", data => { log += data; });
child.stderr.on("data", data => { log += data; });
const exited = new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
async function request(route) {
  const response = await fetch(base + route);
  assert.equal(response.status, 200);
  return response.json();
}
let browser;
const checks = {};
const pageErrors = [];
try {
  await until(async () => { try { return (await request("/api/health")).workspaceId === workspaceId; } catch { if (child.exitCode !== null) throw new Error(log); return false; } }, "production server readiness");
  const executablePath = process.env.RISEN_TEST_BROWSER ?? [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium",
  ].find(file => fs.existsSync(file));
  assert.ok(executablePath, "Set RISEN_TEST_BROWSER to an installed Chrome/Edge executable.");
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.addInitScript(() => localStorage.setItem("tn:language", "en"));
  const page = await context.newPage();
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(base + "/halls");
  await page.getByRole("button", { name: "Add demo hall", exact: true }).click();
  await page.waitForURL("**/schedule");
  await page.locator('div[role="button"][tabindex="0"]').first().waitFor();
  assert.equal(await page.locator("header img").getAttribute("src"), "/logo-sign.svg");
  assert.equal(await page.locator("header img").evaluate(image => image.complete && image.naturalWidth > 0), true);
  await page.screenshot({ path: path.join(output, "schedule-desktop.png"), fullPage: true });
  checks.demoAndHeaderLogo = true;

  const card = page.locator('div[role="button"][tabindex="0"]').first();
  await card.click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  assert.notEqual(await card.evaluate(element => element.style.boxShadow), "");
  await page.keyboard.press("Delete");
  await page.getByRole("alertdialog").waitFor();
  await page.keyboard.press("Escape");
  checks.cardSelectionAndEscape = true;

  // A browser/OS can cancel a captured pointer (for example during touch scroll).
  // The preview must roll back and subsequent pointer movement must stay inert.
  for (const gesture of ["move", "resize"]) {
    for (const cancellation of ["pointercancel", "lostpointercapture"]) {
      const dragOrigin = await card.boundingBox();
      const target = gesture === "resize" ? card.getByRole("separator") : card;
      const targetBox = await target.boundingBox();
      const dragX = targetBox.x + targetBox.width / 2;
      const dragY = targetBox.y + targetBox.height / 2;
      const property = gesture === "resize" ? "height" : "y";
      await page.mouse.move(dragX, dragY);
      await page.mouse.down();
      await page.mouse.move(dragX, dragY + 50, { steps: 4 });
      await until(async () => Math.abs((await card.boundingBox())[property] - dragOrigin[property]) > 5, `${gesture} preview movement`);
      await target.dispatchEvent(cancellation, { pointerId: 1, pointerType: "mouse", bubbles: true });
      await page.mouse.move(dragX, dragY + 90);
      await page.mouse.up();
      await until(async () => Math.abs((await card.boundingBox())[property] - dragOrigin[property]) < 1, `cancelled ${gesture} rollback`);
      assert.equal(await page.getByRole("dialog").count(), 0);
    }
  }
  checks.cancelledPointerRestoresDrag = true;

  const slot = page.locator(".cursor-copy").first();
  const box = await slot.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30);
  const hint = page.getByRole("button", { name: "+ add class", exact: true });
  await hint.click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  checks.hoverCreationHint = true;

  await page.locator('nav a[href="/settings"]').click();
  const markers = page.getByLabel("Custom time markers", { exact: false });
  await markers.fill("");
  await markers.pressSequentially("15:30, 18:15");
  assert.equal(await markers.inputValue(), "15:30, 18:15");
  await markers.press("Tab");
  await until(async () => (await request("/api/workspace")).state.settings.customMarkers.join(", ") === "15:30, 18:15", "custom marker persistence");
  await markers.fill("24:00"); await markers.press("Tab");
  assert.equal(await markers.getAttribute("aria-invalid"), "true");
  assert.deepEqual((await request("/api/workspace")).state.settings.customMarkers, ["15:30", "18:15"]);
  await markers.fill("15:30, 18:15"); await markers.press("Tab");
  assert.equal(await page.getByRole("group", { name: "Visible weekdays", exact: true }).locator('[aria-pressed="true"]').count(), 6);
  checks.markerTypingValidationPersistence = true;
  checks.weekdayAccessibleState = true;

  await page.locator('nav a[href="/halls"]').click();
  const latestRestore = page.getByRole("button", { name: "Restore this version", exact: true }).first();
  assert.equal(await latestRestore.isEnabled(), true);
  await latestRestore.click(); await page.getByRole("alertdialog").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await latestRestore.evaluate(element => element === document.activeElement), true);
  checks.latestRestoreAndFocusReturn = true;

  await page.goto(base + "/export");
  await page.locator("svg image").first().waitFor();
  const embedded = await page.locator("svg image").first().getAttribute("href");
  assert.ok(embedded.startsWith("data:image/svg+xml;base64,"));
  for (const kind of ["PNG", "PDF", "SVG"]) {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: new RegExp(`^Download ${kind}`) }).click();
    const download = await pending;
    assert.equal(await download.failure(), null);
    const target = path.join(output, `demo.${kind.toLowerCase()}`);
    await download.saveAs(target);
    const bytes = fs.readFileSync(target);
    assert.ok(bytes.length > 1000);
    if (kind === "PNG") {
      assert.deepEqual(await sharp(bytes).metadata().then(({ width, height }) => ({ width, height })), { width: 3360, height: 1760 });
      // Logo red must survive nested SVG image -> browser canvas rasterization.
      const { data, info } = await sharp(bytes).extract({ left: 2944, top: 24, width: 392, height: 1200 }).raw().toBuffer({ resolveWithObject: true });
      let red = 0;
      for (let offset = 0; offset < data.length; offset += info.channels) if (data[offset] > 150 && data[offset + 1] < 95 && data[offset + 2] < 100) red++;
      assert.ok(red > 100, "PNG must include the supplied red logo artwork.");
    } else if (kind === "PDF") {
      assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      assert.ok(bytes.includes(Buffer.from("FontFile2")), "The real PDF must embed the Ukrainian font.");
    } else assert.ok(bytes.toString().includes("data:image/svg+xml;base64,"));
  }
  checks.browserDownloads = { png2x: true, pdfEmbeddedFont: true, svgSelfContained: true };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + "/halls");
  await page.getByRole("button", { name: "Add demo hall", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, "halls-mobile.png"), fullPage: true });
  checks.mobileHallsLayout = true;

  // Two real pages in one browser context share storage, but not recovery slots.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + "/settings");
  const other = await context.newPage();
  other.on("pageerror", error => pageErrors.push(error.message));
  await other.goto(base + "/settings");
  for (const tab of [page, other]) {
    const toggle = tab.getByRole("switch", { name: /^Autosave while editing/ });
    await toggle.waitFor();
    if (await toggle.getAttribute("aria-checked") === "true") await toggle.click();
  }
  await other.getByLabel("Schedule title", { exact: true }).fill("Unsaved browser B");
  await page.getByLabel("Schedule title", { exact: true }).fill("Saved browser A");
  await page.getByRole("button", { name: "Save now", exact: true }).click();
  await until(async () => (await request("/api/workspace")).state.settings.scheduleTitle === "Saved browser A", "tab A save");
  assert.equal(await other.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("tn:recovery:")).some(key => localStorage.getItem(key).includes("Unsaved browser B"))), true);
  await other.getByRole("button", { name: "Save now", exact: true }).click();
  await other.getByRole("alert").filter({ hasText: "changed in another tab" }).waitFor();
  other.once("dialog", dialog => dialog.accept());
  await other.getByRole("alert").filter({ hasText: "changed in another tab" }).getByRole("button", { name: "Refresh", exact: true }).click();
  await until(async () => await other.getByLabel("Schedule title", { exact: true }).inputValue() === "Saved browser A", "conflict reload");
  await other.getByRole("button", { name: "Restore them", exact: true }).waitFor();
  checks.twoTabRecoveryAndConflictReload = true;
  assert.deepEqual(pageErrors, []);

  await browser.close(); browser = null;
  child.stdin.write("shutdown\n");
  const code = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("Shutdown timed out")), 20000).unref())]);
  assert.equal(code, 143);
  const db = new Database(path.join(root, "data/risen-team.db"), { readonly: true });
  try { assert.equal(db.pragma("quick_check", { simple: true }), "ok"); }
  finally { db.close(); }
  checks.gracefulShutdownAndSqliteIntegrity = true;
  const result = { passed: true, checkedAt: new Date().toISOString(), browser: path.basename(executablePath), checks, pageErrors };
  fs.writeFileSync("docs/audit/browser-smoke.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error); console.error(log);
  fs.writeFileSync("docs/audit/browser-smoke.json", JSON.stringify({ passed: false, checkedAt: new Date().toISOString(), checks, error: String(error), pageErrors }, null, 2));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) { child.stdin.write("shutdown\n"); await Promise.race([exited, pause(5000)]); }
  if (child.exitCode !== null) fs.rmSync(root, { recursive: true, force: true });
}
