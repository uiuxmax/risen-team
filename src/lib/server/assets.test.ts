import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeLogoDataUrl, MAX_LOGO_BYTES, normalizeLegacyLogoDataUrl, normalizeLogoDataUrl, readLogoDataUrl, storeLogoDataUrl } from "@/lib/server/assets";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
const temporary: string[] = [];
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "risen-assets-")); temporary.push(root); return root; }
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe("portable immutable logo files", () => {
  it("rasterizes legacy SVG logos once into portable immutable PNG resources", async () => {
    const root = fixture();
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="48" height="24" fill="#ff0000"/></svg>').toString("base64")}`;
    const reference = await normalizeLogoDataUrl(root, svg);
    expect(reference).toMatch(/^assets\/logos\/[a-f0-9]{64}\.png$/);
    expect(readLogoDataUrl(root, reference)).toBe(await normalizeLegacyLogoDataUrl(svg));
    expect(await normalizeLogoDataUrl(root, reference)).toBe(reference);
  });
  it("refuses legacy SVG external reads, entity declarations, active content and encoded URLs before installing files", async () => {
    const root = fixture();
    for (const content of [
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///private/secret"/></svg>',
      '<!DOCTYPE svg [<!ENTITY test SYSTEM "file:///private/secret">]><svg xmlns="http://www.w3.org/2000/svg"/>',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect style="fill:u&#114;l(https://example.com/private.svg)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="999999" height="999999"/>',
    ]) {
      await expect(normalizeLogoDataUrl(root, `data:image/svg+xml;base64,${Buffer.from(content).toString("base64")}`)).rejects.toThrow();
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("round-trips logos across project directories and deduplicates without deleting history assets", () => {
    const source = fixture(), destination = fixture();
    const reference = storeLogoDataUrl(source, png);
    expect(storeLogoDataUrl(source, png)).toBe(reference);
    expect(readLogoDataUrl(source, reference)).toBe(png);
    expect(storeLogoDataUrl(destination, readLogoDataUrl(source, reference))).toBe(reference);
    expect(fs.readdirSync(path.join(source, "assets/logos"))).toHaveLength(1);
  });
  it("refuses path traversal, active formats, spoofed MIME, truncated and oversized content", () => {
    const root = fixture();
    expect(() => readLogoDataUrl(root, "../../secrets")).toThrow("reference");
    expect(() => decodeLogoDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toThrow();
    expect(() => decodeLogoDataUrl(png.replace("image/png", "image/jpeg"))).toThrow("media type");
    expect(() => decodeLogoDataUrl("data:image/png;base64,aHRtbA==")).toThrow();
    expect(() => decodeLogoDataUrl(`data:image/png;base64,${"A".repeat(MAX_LOGO_BYTES * 2)}`)).toThrow("limit");
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("detects missing or corrupt files instead of silently losing the saved logo", () => {
    const root = fixture(), reference = storeLogoDataUrl(root, png);
    fs.writeFileSync(path.join(root, reference), "corrupt");
    expect(() => readLogoDataUrl(root, reference)).toThrow("corrupted");
    expect(() => storeLogoDataUrl(root, png)).toThrow("corrupted");
    fs.unlinkSync(path.join(root, reference));
    expect(() => readLogoDataUrl(root, reference)).toThrow();
  });
});
