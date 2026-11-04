import { readJson, withMutationApi } from "@/lib/server/api";
import { deleteRoom, upsertRoom } from "@/lib/server/admin";
import { hallsEnabled } from "@/lib/server/halls";
import { AppError } from "@/lib/server/workspace";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withMutationApi(request, async () => {
    if (hallsEnabled()) throw new AppError("Керуйте незалежними залами в розділі «Зали».",410);
    return upsertRoom(await readJson(request));
  });
}

export async function DELETE(request: Request) {
  return withMutationApi(request, async () => {
    if (hallsEnabled()) throw new AppError("Керуйте незалежними залами в розділі «Зали».",410);
    return deleteRoom(new URL(request.url).searchParams.get("id") ?? "");
  });
}
