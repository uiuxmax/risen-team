// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { LanguageProvider } from "@/components/app/LanguageProvider";
import { SettingsPanels } from "@/components/settings/SettingsPanels";
import { DEFAULT_SETTINGS } from "@/lib/domain/types";
import { createTranslator } from "@/lib/i18n";

const { dispatch, context } = vi.hoisted(() => ({ dispatch: vi.fn(), context: { value: {} as Record<string, unknown> } }));
vi.mock("@/components/app/WorkspaceProvider", () => ({ useWorkspace: () => context.value }));
vi.mock("@/lib/client/api", () => ({ apiRequest: vi.fn(async () => ({ backups: [] })) }));
const t = createTranslator("en");

beforeEach(() => {
  localStorage.setItem("tn:language", "en");
  context.value = {
    settings: { ...DEFAULT_SETTINGS, customMarkers: ["09:00"], visibleDays: [0, 2] },
    schedule: { id: "hall", name: "Hall" }, workspace: { schedules: [] }, dirty: false,
    dispatch, saveNow: vi.fn(), toast: vi.fn(), importBackup: vi.fn(), restoreProjectArchive: vi.fn(),
  };
});
afterEach(() => { cleanup(); localStorage.clear(); dispatch.mockClear(); });

function markers() { return screen.getByLabelText(new RegExp(t("settings.customMarkers"))) as HTMLInputElement; }
function renderSettings() { return render(<LanguageProvider><SettingsPanels /></LanguageProvider>); }

describe("custom time marker editing", () => {
  it("keeps partial time and comma input until blur, then commits the complete list", () => {
    renderSettings();
    const input = markers();
    for (const value of ["1", "15:", "15:30,", "15:30, 18:", "15:30, 18:15"]) {
      fireEvent.change(input, { target: { value } });
      expect(input.value).toBe(value);
      expect(dispatch).not.toHaveBeenCalled();
    }
    fireEvent.blur(input);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ patch: { customMarkers: ["15:30", "18:15"] } }));
  });

  it.each(["15:", "24:00", "15:30,", "15:30,,18:15", "09:60"])("rejects %s without persisting a partial list", value => {
    renderSettings();
    const input = markers();
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    expect(dispatch).not.toHaveBeenCalled();
    expect(input.value).toBe(value);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toMatch(/HH:mm/);
  });

  it("allows clearing all custom markers", () => {
    renderSettings();
    fireEvent.change(markers(), { target: { value: " " } });
    fireEvent.blur(markers());
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ patch: { customMarkers: [] } }));
  });

  it("discards a previous hall's uncommitted draft when switching halls", () => {
    const view = renderSettings();
    fireEvent.change(markers(), { target: { value: "18:" } });
    context.value = { ...context.value, schedule: { id: "another-hall" }, settings: { ...DEFAULT_SETTINGS, customMarkers: ["11:00"] } };
    view.rerender(<LanguageProvider><SettingsPanels /></LanguageProvider>);
    expect(markers().value).toBe("11:00");
  });

  it("replaces a draft when restored settings change the saved markers", () => {
    const view = renderSettings();
    fireEvent.change(markers(), { target: { value: "18:" } });
    context.value = { ...context.value, settings: { ...DEFAULT_SETTINGS, customMarkers: ["12:30"] } };
    view.rerender(<LanguageProvider><SettingsPanels /></LanguageProvider>);
    expect(markers().value).toBe("12:30");
  });

  it("lets a user correct an invalid draft and saves only the corrected times", () => {
    renderSettings();
    fireEvent.change(markers(), { target: { value: "18:" } });
    fireEvent.blur(markers());
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.change(markers(), { target: { value: "18:15, 19:30" } });
    fireEvent.blur(markers());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ patch: { customMarkers: ["18:15", "19:30"] } }));
  });
});

it("exposes selected weekdays and their group to assistive technology", () => {
  renderSettings();
  const group = screen.getByRole("group", { name: t("settings.visibleWeekdays") });
  const buttons = within(group).getAllByRole("button");
  expect(buttons).toHaveLength(7);
  expect(buttons.map(button => button.getAttribute("aria-pressed"))).toEqual(["true", "false", "true", "false", "false", "false", "false"]);
  fireEvent.click(buttons[1]);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ patch: { visibleDays: [0, 1, 2] } }));
});
