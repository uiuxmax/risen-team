// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LanguageProvider } from "@/components/app/LanguageProvider";
import { SettingsPanels } from "@/components/settings/SettingsPanels";
import { DEFAULT_SETTINGS } from "@/lib/domain/types";
import { createTranslator } from "@/lib/i18n";

const {dispatch}=vi.hoisted(()=>({dispatch:vi.fn()}));
vi.mock("@/components/app/WorkspaceProvider",()=>({useWorkspace:()=>({
  settings:{...DEFAULT_SETTINGS},schedule:{id:"hall",name:"Зал"},workspace:{schedules:[]},dirty:false,
  dispatch,saveNow:vi.fn(),toast:vi.fn(),importBackup:vi.fn(),restoreProjectArchive:vi.fn(),
})}));
afterEach(()=>{cleanup();dispatch.mockClear();vi.unstubAllGlobals();localStorage.clear();});

describe("schedule theme picker",()=>{
  it("allows choosing a style through its multicolour preview or keyboard-friendly select",()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response("{}",{status:200})));
    const t=createTranslator("uk");
    render(<LanguageProvider><SettingsPanels /></LanguageProvider>);
    const picker=screen.getByLabelText(t("settings.theme")) as HTMLSelectElement;
    expect(Array.from(picker.options).map(option=>option.value)).toEqual(["risen-team-dark","risen-carbon","risen-crimson","risen-signal"]);
    expect(screen.getByRole("button",{name:/Оригінальна/}).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button",{name:/Карбон/}));
    expect(dispatch).toHaveBeenLastCalledWith({type:"updateSettings",patch:{themeId:"risen-carbon"},description:undefined});
    fireEvent.change(picker,{target:{value:"risen-signal"}});
    expect(dispatch).toHaveBeenLastCalledWith({type:"updateSettings",patch:{themeId:"risen-signal"},description:undefined});
  });
});
