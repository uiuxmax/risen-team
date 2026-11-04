"use client";

// Bound to the server identity observed by this tab. A restarted launcher can
// serve another project at the same URL; old tabs must not write into it.
let serverWorkspaceId: string | null = null;
export function setApiWorkspaceIdentity(workspaceId?: string): void { serverWorkspaceId = workspaceId ?? null; }

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const method = rest.method ?? (json ? "POST" : "GET");
  const headers = new Headers(rest.headers);
  if (json) headers.set("Content-Type", "application/json");
  if (method !== "GET" && method !== "HEAD" && serverWorkspaceId) headers.set("X-Risen-Workspace-Id", serverWorkspaceId);
  let response: Response;
  try {
    response = await fetch(path, {
      ...rest,
      method,
      headers,
      body: json ? JSON.stringify(json) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError("We could not reach the server. Check your connection and retry.", 0);
  }

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : "The request could not be completed. Please retry.";
    throw new ApiError(message, response.status);
  }
  // A pending migration has no loaded Workspace yet. Other reads (especially
  // health checks) must never silently rebind an existing editor to a new project.
  if (serverWorkspaceId === null && method === "GET" && path.split("?", 1)[0] === "/api/workspace/migration") {
    serverWorkspaceId = payload && typeof payload === "object" && "workspaceId" in payload && typeof payload.workspaceId === "string" ? payload.workspaceId : null;
  }
  return payload as T;
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
