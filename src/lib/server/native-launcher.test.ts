import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

describe("native release gate and owned shutdown", () => {
  it("defers macOS termination while an import or server is active", () => {
    const source = fs.readFileSync("native/macos/main.swift", "utf8");
    const delegate = source.slice(source.indexOf("func applicationShouldTerminate("));
    expect(delegate).toMatch(/importing\?\.isRunning\s*==\s*true/);
    expect(delegate).toMatch(/Task\s*\{\s*await stop\(\)\s*\}/);
    expect(delegate).toContain(".terminateCancel");
  });

  it("generates reproducible platform icons from the sign artwork", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "risen-icons-"));
    try {
      const command = ["scripts/generate-native-icons.mjs", directory];
      expect(spawnSync(process.execPath, command, { encoding: "utf8" }).status).toBe(0);
      const ico = fs.readFileSync(path.join(directory, "app.ico"));
      const icns = fs.readFileSync(path.join(directory, "app.icns"));
      const menu = fs.readFileSync(path.join(directory, "menubar.png"));
      expect(ico.readUInt16LE(2)).toBe(1);
      expect(ico.readUInt16LE(4)).toBe(6);
      expect(icns.toString("ascii", 0, 4)).toBe("icns");
      expect(icns.readUInt32BE(4)).toBe(icns.length);
      expect(await sharp(menu).metadata()).toMatchObject({ width: 32, height: 32 });
      const expected = await sharp("assets/logo-sign.svg").resize(32, 32).png().toBuffer();
      expect(menu.equals(expected)).toBe(true);
      for (const name of ["app.ico", "app.icns", "menubar.png"]) {
        expect(fs.readFileSync(path.join("native/assets", name)).equals(fs.readFileSync(path.join(directory, name)))).toBe(true);
      }
      expect(spawnSync(process.execPath, command, { encoding: "utf8" }).status).toBe(0);
      expect(fs.readFileSync(path.join(directory, "app.ico")).equals(ico)).toBe(true);
      expect(fs.readFileSync(path.join(directory, "app.icns")).equals(icns)).toBe(true);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("refuses native compilation without a passing review report", () => {
    const target = process.platform === "win32" ? "win-x64" : `darwin-${process.arch}`;
    if (!["win32", "darwin"].includes(process.platform)) return;
    const result = spawnSync(process.execPath, ["scripts/build-native-release.mjs", `--target=${target}`], { encoding: "utf8", timeout: 20000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Before creating an exe/app");
  });

  it("requests graceful SIGTERM handling through stdin and drains pending work", async () => {
    const child = spawn(process.execPath, ["--require", path.resolve("native/desktop-shutdown.cjs"), "-e",
      "process.on('SIGTERM',()=>{setTimeout(()=>{process.stdout.write('drained');process.exit(0)},30)});process.stdout.write('ready');setInterval(()=>{},1000)"],
      { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const result = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject); child.on("exit", resolve);
    });
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.stdout.on("data", (chunk) => { output += chunk.toString(); if (output.includes("ready")) resolve(); });
    });
    child.stdin.write("shutdown\n");
    expect(await result).toBe(0);
    expect(output).toBe("readydrained");
  });
});
