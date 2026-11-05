// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HallsPanel } from "@/components/halls/HallsPanel";
import { LanguageProvider } from "@/components/app/LanguageProvider";
import { createTranslator } from "@/lib/i18n";

const mocks=vi.hoisted(()=>({push:vi.fn(),action:vi.fn(),save:vi.fn(),api:vi.fn(),dirty:false,autosave:true,savedAutosave:true,halls:[] as import("@/lib/domain/types").Schedule[]}));
vi.mock("next/navigation",()=>({useRouter:()=>({push:mocks.push})}));
vi.mock("@/lib/client/api",()=>({apiRequest:mocks.api}));
vi.mock("@/components/app/WorkspaceProvider",()=>({useWorkspace:()=>({workspace:{schedules:mocks.halls,state:{settings:{autosave:mocks.savedAutosave}}},settings:{autosave:mocks.autosave},schedule:null,loading:false,reload:vi.fn(),scheduleAction:mocks.action,saveNow:mocks.save,dirty:mocks.dirty,toast:vi.fn()})}));
beforeEach(()=>{mocks.action.mockResolvedValue(true);mocks.save.mockResolvedValue(true);mocks.api.mockResolvedValue({preview:{requiresConfirmation:false},backup:{halls:[]}});mocks.halls=[];mocks.dirty=false;mocks.autosave=true;mocks.savedAutosave=true;});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();});

describe("demo hall entry point",()=>{
  it("adds the example through an explicit action and opens its ready schedule",async()=>{
    render(<LanguageProvider><HallsPanel /></LanguageProvider>);
    const t=createTranslator("uk");
    fireEvent.click(screen.getByRole("button",{name:t("halls.addDemo")}));
    await waitFor(()=>expect(mocks.push).toHaveBeenCalledWith("/schedule"));
    expect(mocks.action).toHaveBeenCalledExactlyOnceWith("template");
    expect(screen.getByText(t("halls.demoHint"))).toBeTruthy();
  });
  it("stays on the hall list when the server declines creation",async()=>{
    mocks.action.mockResolvedValue(false);
    render(<LanguageProvider><HallsPanel /></LanguageProvider>);
    const button=screen.getByRole("button",{name:createTranslator("uk")("halls.addDemo")}) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(()=>expect(button.disabled).toBe(false));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.action).toHaveBeenCalledExactlyOnceWith("template");
  });

  it.each([
    {action:"create",button:"halls.create"},
    {action:"rename",button:"common.edit"},
    {action:"duplicate",button:"halls.duplicate"},
  ] as const)("submits the $action hall name through its native form",async({action,button})=>{
    mocks.halls=[{id:"hall-one",name:"Main hall",updatedAt:"2026-11-03T10:00:00.000Z",status:"draft",isActive:false,isArchived:false,publishedAt:null}];
    render(<LanguageProvider><HallsPanel /></LanguageProvider>);
    const t=createTranslator("uk");
    fireEvent.click(screen.getByRole("button",{name:t(button)}));
    const input=screen.getByRole("textbox",{name:t("halls.name")}) as HTMLInputElement;
    fireEvent.change(input,{target:{value:"  Test hall  "}});
    const form=input.form!;
    const submit=screen.getByRole("button",{name:t("common.save")}) as HTMLButtonElement;
    expect(submit.type).toBe("submit");
    expect(submit.form).toBe(form);
    fireEvent.submit(form);
    await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.action).toHaveBeenCalledExactlyOnceWith(action,{id:action==="create"?undefined:"hall-one",sourceId:action==="create"?undefined:"hall-one",name:"Test hall",withoutEvents:false});
  });

  it("keeps the hall form inert and prevents duplicate submits while saving",async()=>{
    let finish!:(result:boolean)=>void;
    mocks.action.mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
    render(<LanguageProvider><HallsPanel /></LanguageProvider>);
    const t=createTranslator("uk");
    fireEvent.click(screen.getByRole("button",{name:t("halls.create")}));
    const input=screen.getByRole("textbox",{name:t("halls.name")}) as HTMLInputElement;
    fireEvent.change(input,{target:{value:"Pending hall"}});
    fireEvent.submit(input.form!);
    const dialog=screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    expect(input.closest("[inert]")).not.toBeNull();
    expect((screen.getByRole("button",{name:t("common.close")}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(input.form!);
    expect(mocks.action).toHaveBeenCalledTimes(1);
    await act(async()=>{finish(false);});
    expect(dialog.getAttribute("aria-busy")).toBe("false");
  });
});

describe("hall export and duplicate safeguards",()=>{
  const hall={id:"hall-one",name:"Main hall",updatedAt:"2026-11-03T10:00:00.000Z",status:"draft" as const,isActive:false,isArchived:false,publishedAt:null};
  beforeEach(()=>{mocks.halls=[{...hall}];});

  it("keeps edits unsaved when export is declined after disabling autosave in this session",async()=>{
    mocks.dirty=true;mocks.autosave=false;mocks.savedAutosave=true;
    const confirm=vi.spyOn(window,"confirm").mockReturnValue(false);
    render(<LanguageProvider><HallsPanel /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button",{name:createTranslator("uk")("halls.export")}));
    await waitFor(()=>expect(confirm).toHaveBeenCalledOnce());
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.api.mock.calls.some(([url])=>String(url).includes("/backup"))).toBe(false);
  });

  it.each([false,true])("uses live autosave=%s and exports only after a successful save",async autosave=>{
    mocks.dirty=true;mocks.autosave=autosave;mocks.savedAutosave=!autosave;
    const confirm=vi.spyOn(window,"confirm").mockReturnValue(true);
    const createObjectURL=vi.fn(()=>"blob:hall-export");
    vi.stubGlobal("URL",{createObjectURL,revokeObjectURL:vi.fn()});
    vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(()=>{});
    render(<LanguageProvider><HallsPanel /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button",{name:createTranslator("uk")("halls.export")}));
    await waitFor(()=>expect(createObjectURL).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledTimes(autosave?0:1);
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.api).toHaveBeenCalledWith("/api/workspace/backup?hallId=hall-one");
  });

  it("does not export a stale server snapshot when saving fails",async()=>{
    mocks.dirty=true;mocks.save.mockResolvedValue(false);
    render(<LanguageProvider><HallsPanel /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button",{name:createTranslator("uk")("halls.export")}));
    await waitFor(()=>expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.api.mock.calls.some(([url])=>String(url).includes("/backup"))).toBe(false);
  });

  it.each(["uk","en"] as const)("submits the default duplicate name within the 80-character contract (%s)",async language=>{
    localStorage.setItem("tn:language",language);
    mocks.halls=[{...hall,name:"З".repeat(80)}];
    render(<LanguageProvider><HallsPanel /></LanguageProvider>);
    const t=createTranslator(language);
    fireEvent.click(screen.getByRole("button",{name:t("halls.duplicate")}));
    const input=screen.getByRole("textbox",{name:t("halls.name")}) as HTMLInputElement;
    expect(input.value.length).toBeLessThanOrEqual(80);
    expect(input.value.endsWith(` — ${t("settings.duplicate")}`)).toBe(true);
    const name=input.value;
    fireEvent.submit(input.form!);
    await waitFor(()=>expect(mocks.action).toHaveBeenCalledWith("duplicate",expect.objectContaining({name})));
  });
});
