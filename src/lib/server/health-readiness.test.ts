import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  run: vi.fn(), seed: vi.fn(), manifest: vi.fn(), root: vi.fn(),
}));
vi.mock("@/db", () => ({
  getDb: () => ({ run: probe.run, $client: { pragma: () => 1 } }), resolveDatabasePath: () => "/test/data/risen-team.db",
}));
vi.mock("@/lib/server/seed", () => ({ ensureSeeded: probe.seed }));
vi.mock("@/db/paths", () => ({ configuredWorkspaceRoot: probe.root, readProjectManifest: probe.manifest }));
import { GET, APP_IDENTITY, LAUNCHER_PROTOCOL_VERSION } from "@/app/api/health/route";
import { LATEST_SCHEMA_VERSION } from "@/db/migrations";

beforeEach(() => {
  vi.clearAllMocks();
  probe.root.mockReturnValue("/test");
  probe.manifest.mockReturnValue({ workspaceId: "f3bb9a97-f11f-4ee8-b091-efc43638ea40" });
  probe.run.mockImplementation(() => undefined);
});

describe("launcher readiness identity", () => {
  it("returns exact project identity and independent protocol/schema versions after storage initialization", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, app: APP_IDENTITY, protocolVersion: LAUNCHER_PROTOCOL_VERSION,
      schemaVersion: LATEST_SCHEMA_VERSION, workspaceId: "f3bb9a97-f11f-4ee8-b091-efc43638ea40" });
    expect(probe.run).toHaveBeenCalledOnce();
  });

  it("does not create or open a database when the selected project manifest cannot be read", async () => {
    probe.manifest.mockImplementationOnce(() => { throw new Error("Missing project manifest"); });
    const response = await GET();
    expect(response.status).toBe(500);
    expect((await response.json()).ok).toBe(false);
    expect(probe.run).not.toHaveBeenCalled();
  });

  it("never reports readiness if database initialization fails", async () => {
    probe.run.mockImplementationOnce(() => { throw new Error("Schema requires migration"); });
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, app: APP_IDENTITY, error: "Schema requires migration" });
    expect(probe.seed).not.toHaveBeenCalled();
  });
});
