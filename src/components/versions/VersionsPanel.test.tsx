// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LanguageProvider } from "@/components/app/LanguageProvider";
import { VersionsPanel } from "@/components/versions/VersionsPanel";
import { createTranslator } from "@/lib/i18n";

const { restoreVersion } = vi.hoisted(() => ({ restoreVersion: vi.fn(async () => {}) }));
vi.mock("@/components/app/WorkspaceProvider", () => ({ useWorkspace: () => ({
  versions: [{ id: "newest", source: "manual", description: "Saved checkpoint", createdAt: "2026-11-01T10:00:00Z" }],
  dirty: true, restoreVersion, createSnapshot: vi.fn(), toast: vi.fn(),
}) }));
afterEach(() => { cleanup(); localStorage.clear(); restoreVersion.mockClear(); });

it("restores the latest checkpoint after edits that have no newer snapshot", async () => {
  localStorage.setItem("tn:language", "en");
  const t = createTranslator("en");
  render(<LanguageProvider><VersionsPanel /></LanguageProvider>);
  const restore = screen.getByRole("button", { name: t("versions.restore") }) as HTMLButtonElement;
  expect(restore.disabled).toBe(false);
  fireEvent.click(restore);
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: t("versions.restoreAction") }));
  await waitFor(() => expect(restoreVersion).toHaveBeenCalledWith("newest"));
});
