// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HallsPanel } from "@/components/halls/HallsPanel";
import { LanguageProvider } from "@/components/app/LanguageProvider";
import { createTranslator } from "@/lib/i18n";

const mocks=vi.hoisted(()=>({push:vi.fn(),action:vi.fn(),halls:[] as import("@/lib/domain/types").Schedule[]}));
vi.mock("next/navigation",()=>({useRouter:()=>({push:mocks.push})}));
vi.mock("@/lib/client/api",()=>({apiRequest:vi.fn(async()=>({preview:{requiresConfirmation:false}}))}));
vi.mock("@/components/app/WorkspaceProvider",()=>({useWorkspace:()=>({workspace:{schedules:mocks.halls},schedule:null,loading:false,reload:vi.fn(),scheduleAction:mocks.action,saveNow:vi.fn(),dirty:false,toast:vi.fn()})}));
beforeEach(()=>{mocks.action.mockResolvedValue(true);mocks.halls=[];});
afterEach(()=>{cleanup();vi.clearAllMocks();localStorage.clear();});

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
