// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { LanguageProvider, useI18n } from "@/components/app/LanguageProvider";
import { WorkspaceProvider, useWorkspace } from "@/components/app/WorkspaceProvider";
import { DEFAULT_SETTINGS, type Workspace } from "@/lib/domain/types";
import { encodeRecoverySnapshot } from "@/lib/schedule/autosave";

const schedule = { id: "s1", name: "Schedule", status: "draft" as const, isActive: true, isArchived: false, publishedAt: null, updatedAt: "2024-01-01T00:00:00.000Z" };
function fixture(): Workspace {
  return { schedules: [schedule], activeScheduleId: "s1", trainers: [], classTypes: [], rooms: [], versions: [], state: { schedule, events: [], settings: { ...DEFAULT_SETTINGS, autosave: false } } };
}
function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let workspace: ReturnType<typeof useWorkspace>;
let language: ReturnType<typeof useI18n>;
function Probe() {
  const currentWorkspace = useWorkspace();
  const currentLanguage = useI18n();
  useEffect(() => { workspace = currentWorkspace; language = currentLanguage; });
  return <div>{currentWorkspace.settings.scheduleTitle}</div>;
}
async function mount() {
  render(<LanguageProvider><WorkspaceProvider><Probe /></WorkspaceProvider></LanguageProvider>);
  await waitFor(() => expect(workspace.workspace).not.toBeNull());
}
function edit(title: string) {
  act(() => workspace.dispatch({ type: "updateSettings", patch: { scheduleTitle: title } }));
}
function recoverySlots(prefix: string) {
  return Object.keys(localStorage).filter(key => key === prefix || key.startsWith(`${prefix}:`));
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WorkspaceProvider persistence integration", () => {
  it("keeps two tabs' independent recovery copies when one tab saves", async () => {
    const sessions: Record<string, ReturnType<typeof useWorkspace>> = {};
    function Session({ id }: { id: string }) {
      const value = useWorkspace();
      useEffect(() => { sessions[id] = value; });
      return null;
    }
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => init.method === "PUT"
      ? response({ savedAt: new Date().toISOString(), versionCreated: null, revision: 1 })
      : response({ ...fixture(), workspaceId: "p", hallId: "s1", revision: 0 })));
    render(<LanguageProvider><WorkspaceProvider><Session id="a" /></WorkspaceProvider><WorkspaceProvider><Session id="b" /></WorkspaceProvider></LanguageProvider>);
    await waitFor(() => expect(sessions.a?.workspace && sessions.b?.workspace).toBeTruthy());
    act(() => sessions.b.dispatch({ type: "updateSettings", patch: { scheduleTitle: "Unsaved in B" } }));
    act(() => sessions.a.dispatch({ type: "updateSettings", patch: { scheduleTitle: "Saved in A" } }));
    const snapshots = () => Object.keys(localStorage).filter(key => key.startsWith("tn:recovery:p:s1")).map(key => JSON.parse(localStorage.getItem(key)!));
    expect(snapshots().map(item => item.settings.scheduleTitle).sort()).toEqual(["Saved in A", "Unsaved in B"]);
    await act(async () => { expect(await sessions.a.saveNow()).toBe(true); });
    expect(snapshots().map(item => item.settings.scheduleTitle)).toEqual(["Unsaved in B"]);
    cleanup();
    await mount();
    expect(workspace.recovery?.settings.scheduleTitle).toBe("Unsaved in B");
  });

  it("loads the latest hall after a 409 without losing the local recovery or retrying the stale write", async () => {
    let reads = 0;
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url}`);
      if (init.method === "PUT") return response({ error: "Changed in another tab" }, 409);
      return response({ ...fixture(), workspaceId: "p", hallId: "s1", revision: reads++ ? 1 : 0,
        state: { ...fixture().state, settings: { ...fixture().state.settings, scheduleTitle: reads > 1 ? "Latest server" : "Original" } } });
    }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await mount();
    edit("My conflicting edits");
    await act(async () => { expect(await workspace.saveNow()).toBe(false); });
    await act(async () => { expect(await workspace.reload()).toBe(true); });
    expect(workspace.settings.scheduleTitle).toBe("Latest server");
    expect(workspace.recovery?.settings.scheduleTitle).toBe("My conflicting edits");
    expect(requests).toEqual(["GET /api/workspace", "PUT /api/workspace/state", "GET /api/workspace"]);
    expect(Object.keys(localStorage).some(key => key.startsWith("tn:recovery:p:s1") && localStorage.getItem(key)?.includes("My conflicting edits"))).toBe(true);
  });

  it("keeps the conflicting editor open when reloading is cancelled", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => init.method === "PUT"
      ? response({ error: "Changed in another tab" }, 409) : response({ ...fixture(), hallId: "s1", revision: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await mount(); edit("Keep this edit");
    await act(async () => { await workspace.saveNow(); });
    await act(async () => { expect(await workspace.reload("s2")).toBe(false); });
    expect(workspace.settings.scheduleTitle).toBe("Keep this edit");
    expect(workspace.dirty).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses to replace conflicting edits when their recovery cannot be stored", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => init.method === "PUT"
      ? response({ error: "Changed in another tab" }, 409) : response({ ...fixture(), hallId: "s1", revision: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await mount(); edit("Only editor copy");
    await act(async () => { await workspace.saveNow(); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage full", "QuotaExceededError"); });
    await act(async () => { expect(await workspace.reload()).toBe(false); });
    expect(workspace.settings.scheduleTitle).toBe("Only editor copy");
    expect(workspace.dirty).toBe(true);
    expect(workspace.loadError).toBe(workspace.t("recovery.storageUnavailable"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["trainer","class"])("saves pending edits before deleting a %s, then replaces events/revision/undo", async entity => {
    const initial:Workspace={...fixture(),hallId:"s1",workspaceId:"p",revision:4,trainers:[{id:"t",name:"Trainer",active:true,color:"#112233",sortOrder:0}],classTypes:[{id:"c",name:"Class",shortName:"C",active:true,defaultDuration:60,sortOrder:0,trainerIds:["t"]}],state:{...fixture().state,events:[{id:"e",scheduleId:"s1",trainerId:"t",classTypeId:"c",dayOfWeek:3,startTime:"10:00",endTime:"11:00"}]}};
    const after:Workspace={...initial,revision:6,trainers:entity === "trainer" ? [] : initial.trainers,classTypes:entity === "class" ? [] : initial.classTypes.map(type=>({...type,trainerIds:[]})),state:{...initial.state,settings:{...initial.state.settings,scheduleTitle:"Pending"},events:[]}};
    const requests:string[]=[];let reads=0;
    vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
      requests.push(`${init.method} ${url}`);
      if(init.method === "PUT")return response({savedAt:new Date().toISOString(),versionCreated:null,revision:5});
      if(init.method === "DELETE")return response({deactivated:false,deletedEvents:1,revision:6});
      return response(++reads===1 ? initial : after);
    }));
    vi.spyOn(window,"confirm").mockReturnValue(true);
    await mount();edit("Pending");
    await act(async()=>expect(await (entity === "trainer" ? workspace.removeTrainer("t") : workspace.removeClassType("c"))).toBe(true));
    expect(requests).toEqual(["GET /api/workspace","PUT /api/workspace/state",`DELETE /api/workspace/${entity === "trainer" ? "trainers?id=t" : "class-types?id=c"}&hallId=s1&revision=5`,"GET /api/workspace?scheduleId=s1"]);
    expect(workspace.events).toEqual([]);
    expect(workspace.workspace?.revision).toBe(6);
    expect(workspace.dirty).toBe(false);
    act(()=>workspace.runUndo());
    expect(workspace.events).toEqual([]);
    expect(recoverySlots("tn:recovery:p:s1")).toEqual([]);
  });

  it("does not delete or discard dirty edits when save before catalog deletion fails", async()=>{
    const requests:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
      requests.push(`${init.method} ${url}`);
      return init.method === "PUT" ? response({error:"Disk unavailable"},503) : response({...fixture(),hallId:"s1",revision:0});
    }));
    vi.spyOn(window,"confirm").mockReturnValue(true);
    await mount();edit("Pending");
    await act(async()=>expect(await workspace.removeTrainer("t")).toBe(false));
    expect(requests.some(value=>value.startsWith("DELETE"))).toBe(false);
    expect(workspace.settings.scheduleTitle).toBe("Pending");
    expect(workspace.dirty).toBe(true);
  });

  it("does not announce catalog deletion success when the committed data cannot be reloaded", async()=>{
    let reads=0;
    vi.stubGlobal("fetch",vi.fn(async(_url:string,init:RequestInit)=>init.method === "DELETE" ? response({deactivated:false}) : ++reads===1 ? response({...fixture(),hallId:"s1",revision:0}) : response({error:"Reload unavailable"},503)));
    await mount();
    await act(async()=>expect(await workspace.removeClassType("c")).toBe(false));
    expect(workspace.toasts.some(toast=>toast.kind==="success")).toBe(false);
    expect(workspace.loadError).toBe("Reload unavailable");
  });
  it("does not report a demo as opened when creation succeeds but loading its data fails", async () => {
    const requests:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async (url:string,init:RequestInit)=>{
      requests.push(`${init.method} ${url}`);
      if(init.method === "POST") return response({activeScheduleId:"demo-created"});
      if(url.includes("demo-created"))return response({error:"Read unavailable. Refresh to retry."},503);
      return response({...fixture(),workspaceId:"project-a",hallId:"s1",revision:0});
    }));
    await mount();
    let opened=true;
    await act(async()=>{opened=await workspace.scheduleAction("template");});
    expect(opened).toBe(false);
    expect(workspace.workspace?.hallId).toBe("s1");
    expect(workspace.loadError).toBe("Read unavailable. Refresh to retry.");
    expect(workspace.toasts.some(toast=>toast.kind==="success")).toBe(false);
    expect(requests).toEqual(["GET /api/workspace","POST /api/workspace/schedules","GET /api/workspace?scheduleId=demo-created"]);
  });

  it("does not announce a restore as displayed when its follow-up load fails", async () => {
    let reads=0;
    vi.stubGlobal("fetch",vi.fn(async (_url:string,init:RequestInit)=>{
      if(init.method === "POST")return response({scheduleId:"s1"});
      return ++reads===1 ? response(fixture()) : response({error:"Read unavailable"},503);
    }));
    await mount();
    await act(async()=>{await expect(workspace.restoreVersion("version")).rejects.toThrow(/завантажити/);});
    expect(workspace.loadError).toBe("Read unavailable");
    expect(workspace.toasts.some(toast=>toast.kind==="success")).toBe(false);
    expect(workspace.mutationBusy).toBe(false);
  });

  it("retries a previously failed save before reloading instead of trapping the editor permanently", async () => {
    let writes=0;
    const requests:string[]=[];
    vi.spyOn(window,"confirm").mockReturnValue(true);
    vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
      requests.push(`${init.method} ${url}`);
      if(init.method==="PUT")return ++writes===1 ? response({error:"Temporary save failure"},503) : response({savedAt:new Date().toISOString(),versionCreated:null});
      if(url.includes("s2"))return response({...fixture(),activeScheduleId:"s2",state:{...fixture().state,schedule:{...schedule,id:"s2"},settings:{...fixture().state.settings,scheduleTitle:"Hall two"}}});
      return response(fixture());
    }));
    await mount();
    edit("Keep before switching");
    await act(async()=>{expect(await workspace.saveNow()).toBe(false);});
    await act(async()=>{expect(await workspace.reload("s2")).toBe(true);});
    expect(workspace.settings.scheduleTitle).toBe("Hall two");
    expect(requests).toEqual(["GET /api/workspace","PUT /api/workspace/state","PUT /api/workspace/state","GET /api/workspace?scheduleId=s2"]);
  });

  it.each(["import","archive"])("does not signal successful %s display when refreshing committed data fails",async operation=>{
    let reads=0;
    vi.stubGlobal("fetch",vi.fn(async(_url:string,init:RequestInit)=>{
      if(init.method==="POST")return response({schedules:1,events:0,mode:"replace"});
      return ++reads===1 ? response(fixture()) : response({error:"Refresh unavailable"},503);
    }));
    await mount();
    await act(async()=>{
      if(operation==="import")await expect(workspace.importBackup({},"merge")).rejects.toThrow(/завантажити/);
      else expect(await workspace.restoreProjectArchive("example")).toBe(false);
    });
    expect(workspace.loadError).toBe("Refresh unavailable");
    expect(workspace.toasts.some(toast=>toast.kind==="success")).toBe(false);
  });
  it("cancels a hall switch with autosave disabled without writing or losing edits", async () => {
    const current = { ...fixture(), workspaceId: "project-a", hallId: "s1", revision: 0 };
    const fetchMock = vi.fn(async () => response(current));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await mount();
    edit("Local hall A");
    await act(async () => { await workspace.reload("s2"); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(workspace.settings.scheduleTitle).toBe("Local hall A");
    expect(workspace.workspace?.hallId).toBe("s1");
    expect(recoverySlots("tn:recovery:project-a:s1")).toHaveLength(1);
    expect(localStorage.getItem("tn:recovery:s1")).toBeNull();
  });

  it("ignores a slow hall response after a newer hall has opened", async () => {
    const gate = deferred<Response>();
    const makeHall = (id: string): Workspace => ({ ...fixture(), hallId:id, workspaceId:"p", revision:0, activeScheduleId:id, state:{ ...fixture().state, schedule:{...schedule,id,name:id} } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("s2") ? gate.promise : response(makeHall(url.includes("s3") ? "s3" : "s1"))));
    await mount();
    let slow!: Promise<boolean>;
    act(() => { slow=workspace.reload("s2"); });
    await act(async () => { await workspace.reload("s3"); });
    expect(workspace.workspace?.hallId).toBe("s3");
    await act(async () => { gate.resolve(response(makeHall("s2"))); await slow; });
    expect(workspace.workspace?.hallId).toBe("s3");
  });

  it("blocks edits during a hall load and clears the previous hall undo stack", async () => {
    const gate=deferred<Response>();
    const first={...fixture(),workspaceId:"p",hallId:"s1",revision:0};
    const second={...fixture(),workspaceId:"p",hallId:"s2",revision:0,activeScheduleId:"s2",state:{...fixture().state,schedule:{...schedule,id:"s2"},settings:{...DEFAULT_SETTINGS,autosave:false,scheduleTitle:"Hall two"}}};
    vi.stubGlobal("fetch",vi.fn(async (url:string,init:RequestInit) => {
      if (init.method === "PUT") return response({savedAt:new Date().toISOString(),versionCreated:null,revision:1});
      return url.includes("s2") ? gate.promise : response(first);
    }));
    await mount();
    edit("Hall one edit");
    await act(async () => { await workspace.saveNow(); });
    expect(workspace.canUndo).toBe(true);
    let pending!:Promise<boolean>;
    act(() => { pending=workspace.reload("s2"); });
    await waitFor(() => expect(workspace.loading).toBe(true));
    edit("Must be blocked");
    expect(workspace.settings.scheduleTitle).toBe("Hall one edit");
    await act(async () => { gate.resolve(response(second)); await pending; });
    expect(workspace.settings.scheduleTitle).toBe("Hall two");
    expect(workspace.canUndo).toBe(false);
    act(() => workspace.runUndo());
    expect(workspace.settings.scheduleTitle).toBe("Hall two");
  });

  it("chains writes using the revision returned by the preceding save", async () => {
    const revisions: number[]=[];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method !== "PUT") return response({...fixture(),hallId:"s1",workspaceId:"p",revision:7});
      const body=JSON.parse(String(init.body)); revisions.push(body.revision);
      return response({savedAt:new Date().toISOString(),versionCreated:null,revision:body.revision+1});
    }));
    await mount();
    edit("One");
    await act(async () => { await workspace.saveNow(); });
    edit("Two");
    await act(async () => { await workspace.saveNow(); });
    expect(revisions).toEqual([7,8]);
  });

  it("keeps unsaved edits and does not reload when language changes", async () => {
    const fetchMock = vi.fn(async () => response(fixture()));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    edit("Unsaved title");
    act(() => language.setLanguage(language.language === "en" ? "uk" : "en"));
    await act(async () => { await Promise.resolve(); });
    expect(workspace.settings.scheduleTitle).toBe("Unsaved title");
    expect(workspace.dirty).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts schedule mutation when saving dirty edits fails", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url}`);
      if (init.method === "PUT") return response({ error: "save failed" }, 500);
      return response(fixture());
    }));
    await mount();
    edit("Unsaved title");
    let ok = true;
    await act(async () => { ok = await workspace.scheduleAction("rename", { id: "s1", name: "New" }); });
    expect(ok).toBe(false);
    expect(requests).toEqual(["GET /api/workspace", "PUT /api/workspace/state"]);
    expect(workspace.settings.scheduleTitle).toBe("Unsaved title");
    expect(workspace.dirty).toBe(true);
  });

  it("flushes edits before a schedule mutation and blocks edits until it finishes", async () => {
    const gate = deferred<Response>();
    const requests: string[] = [];
    const saved = fixture();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url}`);
      if (init.method === "PUT") {
        const body = JSON.parse(String(init.body));
        saved.state.settings = body.settings;
        return response({ savedAt: new Date().toISOString(), versionCreated: null });
      }
      if (url === "/api/workspace/schedules") return gate.promise;
      return response(saved);
    }));
    await mount();
    edit("Before mutation");
    let pending!: Promise<boolean>;
    act(() => { pending = workspace.scheduleAction("rename", { id: "s1", name: "New" }); });
    await waitFor(() => expect(requests).toContain("POST /api/workspace/schedules"));
    expect(requests.slice(0, 3)).toEqual(["GET /api/workspace", "PUT /api/workspace/state", "POST /api/workspace/schedules"]);
    expect(workspace.mutationBusy).toBe(true);
    edit("Blocked edit");
    expect(workspace.settings.scheduleTitle).toBe("Before mutation");
    await act(async () => { gate.resolve(response({ activeScheduleId: "s1" })); expect(await pending).toBe(true); });
    expect(workspace.mutationBusy).toBe(false);
    expect(workspace.settings.scheduleTitle).toBe("Before mutation");
  });

  it("retains newer local recovery while an older save completes", async () => {
    const gate = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => init.method === "PUT" ? gate.promise : response(fixture())));
    await mount();
    edit("First edit");
    let pending!: Promise<boolean>;
    act(() => { pending = workspace.saveNow(); });
    await waitFor(() => expect(workspace.saveStatus).toBe("saving"));
    edit("Newer edit");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    await act(async () => { gate.resolve(response({ savedAt: new Date().toISOString(), versionCreated: null })); expect(await pending).toBe(true); });
    const key = recoverySlots("tn:recovery:s1")[0];
    const recovery = JSON.parse(localStorage.getItem(key) ?? "null");
    expect(recovery.settings.scheduleTitle).toBe("Newer edit");
    expect(remove).not.toHaveBeenCalledWith(key);
    expect(workspace.dirty).toBe(true);
  });

  it("keeps an unanswered recovery copy available after workspace load", async () => {
    const snapshot = encodeRecoverySnapshot({ scheduleId: "s1", clientUpdatedAt: Date.now(), events: [], settings: { ...fixture().state.settings, scheduleTitle: "Recover me" }, description: "" });
    localStorage.setItem("tn:recovery:s1", JSON.stringify(snapshot));
    vi.stubGlobal("fetch", vi.fn(async () => response(fixture())));
    await mount();
    expect(workspace.recovery?.settings.scheduleTitle).toBe("Recover me");
    expect(recoverySlots("tn:recovery:s1")).toHaveLength(1);
    cleanup();
    await mount();
    expect(workspace.recovery?.settings.scheduleTitle).toBe("Recover me");
  });

  it("preserves a recovery accepted during an older save when storage is full", async () => {
    const candidate = encodeRecoverySnapshot({ scheduleId: "s1", clientUpdatedAt: Date.now(), events: [], settings: { ...fixture().state.settings, scheduleTitle: "Sole durable recovery" }, description: "" });
    const raw = JSON.stringify(candidate);
    localStorage.setItem("tn:recovery:s1", raw);
    const gate = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => init.method === "PUT" ? gate.promise : response(fixture())));
    await mount(); edit("Older submitted edit");
    let saving!: Promise<boolean>;
    act(() => { saving = workspace.saveNow(); });
    await waitFor(() => expect(workspace.saveStatus).toBe("saving"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage full", "QuotaExceededError"); });
    act(() => workspace.acceptRecovery());
    await act(async () => { gate.resolve(response({ savedAt: new Date().toISOString(), versionCreated: null })); await saving; });
    expect(workspace.settings.scheduleTitle).toBe("Sole durable recovery");
    expect(workspace.dirty).toBe(true);
    expect(localStorage.getItem("tn:recovery:s1")).toBe(raw);
  });

  it("removes stale local recovery after undo returns to saved state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(fixture())));
    await mount();
    edit("Temporary edit");
    expect(recoverySlots("tn:recovery:s1")).toHaveLength(1);
    act(() => workspace.runUndo());
    expect(workspace.settings.scheduleTitle).toBe(DEFAULT_SETTINGS.scheduleTitle);
    expect(recoverySlots("tn:recovery:s1")).toEqual([]);
  });
  it("waits for an in-flight save before importing and blocks edits until reload", async () => {
    const saveGate = deferred<Response>();
    const importGate = deferred<Response>();
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url}`);
      if (init.method === "PUT") return saveGate.promise;
      if (url === "/api/workspace/backup") return importGate.promise;
      return response(fixture());
    }));
    await mount();
    edit("Existing edit");
    let save!: Promise<boolean>;
    act(() => { save = workspace.saveNow(); });
    await waitFor(() => expect(requests).toContain("PUT /api/workspace/state"));
    let importing!: Promise<unknown>;
    act(() => { importing = workspace.importBackup({ backup: "sample" }, "replace"); });
    expect(workspace.mutationBusy).toBe(true);
    edit("Blocked edit");
    expect(workspace.settings.scheduleTitle).toBe("Existing edit");
    expect(requests).not.toContain("POST /api/workspace/backup");
    await act(async () => { saveGate.resolve(response({ savedAt: new Date().toISOString(), versionCreated: null })); await save; });
    await waitFor(() => expect(requests).toContain("POST /api/workspace/backup"));
    await act(async () => { importGate.resolve(response({ schedules: 1, events: 0, mode: "replace" })); await importing; });
    expect(workspace.mutationBusy).toBe(false);
    expect(requests.at(-1)).toBe("GET /api/workspace");
  });

  it("locks the editor during version restore after waiting for in-flight saves", async () => {
    const saveGate = deferred<Response>();
    const restoreGate = deferred<Response>();
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url}`);
      if (init.method === "PUT") return saveGate.promise;
      if (url === "/api/workspace/versions") return restoreGate.promise;
      return response(fixture());
    }));
    await mount();
    edit("Existing edit");
    let save!: Promise<boolean>;
    act(() => { save = workspace.saveNow(); });
    await waitFor(() => expect(requests).toContain("PUT /api/workspace/state"));
    let restoring!: Promise<void>;
    act(() => { restoring = workspace.restoreVersion("v1"); });
    expect(workspace.mutationBusy).toBe(true);
    expect(requests).not.toContain("POST /api/workspace/versions");
    edit("Blocked edit");
    expect(workspace.settings.scheduleTitle).toBe("Existing edit");
    await act(async () => { saveGate.resolve(response({ savedAt: new Date().toISOString(), versionCreated: null })); await save; });
    await waitFor(() => expect(requests).toContain("POST /api/workspace/versions"));
    edit("Blocked again");
    expect(workspace.settings.scheduleTitle).toBe("Existing edit");
    await act(async () => { restoreGate.resolve(response({ scheduleId: "s1" })); await restoring; });
    expect(workspace.mutationBusy).toBe(false);
    expect(requests.at(-1)).toBe("GET /api/workspace?scheduleId=s1");
  });

});
