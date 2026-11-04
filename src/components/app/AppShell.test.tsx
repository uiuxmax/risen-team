// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AppShell } from "@/components/app/AppShell";
import { LanguageProvider } from "@/components/app/LanguageProvider";
import { DEFAULT_SETTINGS } from "@/lib/domain/types";
import { getTheme } from "@/lib/theme/risen-team-dark";

const { state } = vi.hoisted(() => ({ state: { themeId: "risen-team-dark" } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/schedule" }));
vi.mock("@/components/app/WorkspaceProvider", () => ({ useWorkspace: () => ({
  settings: { ...DEFAULT_SETTINGS, themeId: state.themeId },
  saveStatus: "saved", savedAt: null, dirty: false, mutationBusy: false,
  toasts: [], recovery: null, reload: vi.fn(), runUndo: vi.fn(), runRedo: vi.fn(),
}) }));
afterEach(() => { cleanup(); localStorage.clear(); });

describe("application navigation and theme", () => {
  it("uses the supplied sign as the header logo", () => {
    const { container } = render(<LanguageProvider><AppShell>Content</AppShell></LanguageProvider>);
    const brand = container.querySelector('header a[href="/schedule"]');
    expect(brand?.querySelector("img")?.getAttribute("src")).toBe("/logo-sign.svg");
    expect(brand?.textContent).not.toContain("RT");
    expect(brand?.getAttribute("aria-label")).toContain("Risen Team");
  });
  it("orders the main navigation and exposes one visible save status", () => {
    render(<LanguageProvider><AppShell><div>Schedule content</div></AppShell></LanguageProvider>);
    const links = screen.getByRole("navigation").querySelectorAll("a");
    expect(Array.from(links, link => link.getAttribute("href"))).toEqual(["/schedule", "/halls", "/manage", "/settings"]);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").className).not.toContain("hidden");
  });

  it.each(["risen-team-dark", "risen-carbon", "risen-crimson", "risen-signal"])("applies %s to shared interface surfaces", themeId => {
    state.themeId = themeId;
    const { container } = render(<LanguageProvider><AppShell>Content</AppShell></LanguageProvider>);
    const shell = container.querySelector<HTMLElement>("[data-theme]")!;
    expect(shell.dataset.theme).toBe(themeId);
    expect(shell.style.getPropertyValue("--ui-background")).toBe(getTheme(themeId).canvas.background);
    expect(shell.style.getPropertyValue("--ui-radius")).toBe(`${getTheme(themeId).cards.radius}px`);
  });
});
