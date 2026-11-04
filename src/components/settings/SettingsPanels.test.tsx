// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LanguageProvider } from "@/components/app/LanguageProvider";
import { SettingsPanels } from "@/components/settings/SettingsPanels";
import { DEFAULT_SETTINGS } from "@/lib/domain/types";
import { createTranslator } from "@/lib/i18n";

vi.mock("@/components/app/WorkspaceProvider", () => ({useWorkspace: () => ({settings:DEFAULT_SETTINGS,schedule:null,workspace:{schedules:[]},dirty:false,dispatch:vi.fn(),saveNow:vi.fn(),toast:vi.fn(),importBackup:vi.fn(),restoreProjectArchive:vi.fn()})}));
afterEach(() => {cleanup();vi.unstubAllGlobals();localStorage.clear();});
describe("empty project transfer", () => {
  it("keeps JSON import and project-archive restore available before creating a hall", () => {
    vi.stubGlobal("fetch",vi.fn(async () => new Response("{}",{status:200})));
    const t=createTranslator("uk");
    render(<LanguageProvider><SettingsPanels /></LanguageProvider>);
    expect(screen.getByRole("button",{name:t("settings.importBackup")})).toBeTruthy();
    expect(screen.getByRole("button",{name:t("halls.archiveRestore")})).toBeTruthy();
    expect(screen.queryByRole("button",{name:t("settings.saveNow")})).toBeNull();
  });
});
