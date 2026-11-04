import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DatabaseMigrationError } from "@/db/migrations";
import { AppError } from "@/lib/server/workspace";
import { HallMigrationRequiredError } from "@/db/hall-migration";
import { configuredWorkspaceRoot, readProjectManifest } from "@/db/paths";

/**
 * API helpers.
 *
 * This product is used by a single operator, so there is no sign-in step and no
 * session requirement. Every handler still goes through the same error funnel so
 * the user never sees a raw technical error.
 */

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof HallMigrationRequiredError) {
    return NextResponse.json({error:error.message,code:error.code},{status:409});
  }
  // DatabaseMigrationError deliberately contains a safe operator-facing
  // message while retaining its technical diagnostic only for server logs/tests.
  // Reuse the normal API error shape; no migration-specific UI is introduced.
  if (error instanceof DatabaseMigrationError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  if (error instanceof AppError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const path = first?.path?.join(" ") ?? "";
    const message = first ? `${path ? `${path}: ` : ""}${first.message}` : "The data could not be validated.";
    return NextResponse.json({ error: message }, { status: 422 });
  }
  const message = error instanceof Error ? error.message : "Something went wrong.";
  console.error("[api]", message);
  return NextResponse.json(
    { error: `${message} Your edits are still stored locally — please retry.` },
    { status: 500 },
  );
}

export async function withApi<T>(handler: () => Promise<T>): Promise<NextResponse> {
  try {
    const result = await handler();
    return NextResponse.json(result ?? { ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Reject cross-origin browser writes before a local workspace can be changed. */
export async function withMutationApi<T>(request: Request, handler: () => Promise<T>): Promise<NextResponse> {
  return withApi(async () => {
    const origin = request.headers.get("origin");
    // Next may synthesize request.url using its internal host. The incoming Host
    // retains the browser's actual loopback port, including a launcher/test port.
    const requestUrl = new URL(request.url);
    const host = request.headers.get("host") ?? requestUrl.host;
    const expectedOrigin = new URL(`${requestUrl.protocol}//${host}`).origin;
    const hostname = new URL(expectedOrigin).hostname;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname) || origin !== null && origin !== expectedOrigin) {
      throw new AppError("Запит з іншого сайту відхилено. Повторіть дію у вікні програми.", 403);
    }
    // JSON bodies require a non-simple content type, preventing text/plain form
    // submissions from reaching the unauthenticated loopback server. DELETE
    // carries no body and is protected by the origin check and browser preflight.
    if (request.method !== "DELETE") {
      const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        throw new AppError("Очікується запит у форматі JSON. Повторіть дію у вікні програми.", 415);
      }
    }
    const workspaceRoot = configuredWorkspaceRoot();
    if (workspaceRoot && request.headers.get("x-risen-workspace-id") !== readProjectManifest(workspaceRoot).workspaceId) {
      throw new AppError("Відкрито інший проєкт. Оновіть вкладку перед редагуванням. Локальні правки залишаються у попередньому проєкті.", 409);
    }
    return handler();
  });
}
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError("The request body could not be read. Please retry.", 400);
  }
}
