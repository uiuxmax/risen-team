import { hallsEnabled, mutateHallCatalog, deleteHallCatalog } from "@/lib/server/halls";
import { readJson, withMutationApi } from "@/lib/server/api";
import { deleteClassType, upsertClassType } from "@/lib/server/admin";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withMutationApi(request, async () => hallsEnabled() ? mutateHallCatalog(new URL(request.url).searchParams.get("hallId") ?? "", "class_types", await readJson(request)) : upsertClassType(await readJson(request)));
}

export async function DELETE(request: Request) {
  return withMutationApi(request, async () => hallsEnabled() ? deleteHallCatalog(new URL(request.url).searchParams.get("hallId") ?? "", "class_types", new URL(request.url).searchParams.get("id") ?? "", Number(new URL(request.url).searchParams.get("revision") ?? "NaN")) : deleteClassType(new URL(request.url).searchParams.get("id") ?? ""));
}
