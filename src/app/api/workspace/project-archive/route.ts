import { errorResponse, withMutationApi } from "@/lib/server/api";
import { exportProjectArchive, restoreProjectArchive, MAX_ARCHIVE_COMPRESSED } from "@/lib/server/project-archive";
import { AppError } from "@/lib/server/workspace";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const bytes = await exportProjectArchive();
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/gzip",
      "Content-Disposition": 'attachment; filename="risen-team-project.risen-project.gz"', "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  return withMutationApi(request, async () => {
    const maximumBody = Math.ceil(MAX_ARCHIVE_COMPRESSED / 3) * 4 + 100;
    if (Number(request.headers.get("content-length")) > maximumBody) throw new AppError("Архів завеликий.", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new AppError("Відсутній архів.", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maximumBody) { await reader.cancel(); throw new AppError("Архів завеликий.", 413); }
      chunks.push(value);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new AppError("Некоректний запит відновлення.", 400); }
    if (!body || typeof body !== "object" || !("archiveBase64" in body) || typeof body.archiveBase64 !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.archiveBase64)) throw new AppError("Некоректний архів.", 422);
    return restoreProjectArchive(Buffer.from(body.archiveBase64, "base64"));
  });
}
