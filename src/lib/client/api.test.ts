import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, setApiWorkspaceIdentity } from "@/lib/client/api";

afterEach(() => {setApiWorkspaceIdentity();vi.unstubAllGlobals();});
describe("tab project identity", () => {
  it("retains the loaded editor identity across health and migration reads from another project", async () => {
    const identities: (string|null)[]=[];
    vi.stubGlobal("fetch",vi.fn(async (_url:string,init:RequestInit) => {
      if(init.method === "PUT") identities.push(new Headers(init.headers).get("x-risen-workspace-id"));
      return new Response(JSON.stringify({workspaceId:"project-b"}),{status:200});
    }));
    setApiWorkspaceIdentity("project-a");
    await apiRequest("/api/health");
    await apiRequest("/api/workspace/migration");
    await apiRequest("/api/workspace/state",{method:"PUT",json:{}});
    expect(identities).toEqual(["project-a"]);
    setApiWorkspaceIdentity("project-b");
    await apiRequest("/api/workspace/state",{method:"PUT",json:{}});
    expect(identities).toEqual(["project-a","project-b"]);
  });

  it("binds a first-load pending migration before confirming it", async () => {
    let sent:string|null=null;
    vi.stubGlobal("fetch",vi.fn(async (_url:string,init:RequestInit) => {
      if(init.method === "POST") sent=new Headers(init.headers).get("x-risen-workspace-id");
      return new Response(JSON.stringify({workspaceId:"pending-project"}),{status:200});
    }));
    await apiRequest("/api/workspace/migration");
    await apiRequest("/api/workspace/migration",{json:{confirmed:true}});
    expect(sent).toBe("pending-project");
  });
});
