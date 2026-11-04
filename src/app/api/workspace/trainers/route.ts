import { hallsEnabled, mutateHallCatalog, deleteHallCatalog } from "@/lib/server/halls";
import { readJson, withMutationApi } from "@/lib/server/api";
import { deleteTrainer, upsertTrainer } from "@/lib/server/admin";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withMutationApi(request, async () => hallsEnabled() ? mutateHallCatalog(new URL(request.url).searchParams.get("hallId") ?? "", "trainers", await readJson(request)) : upsertTrainer(await readJson(request)));
}

export async function DELETE(request: Request) {
  return withMutationApi(request, async () => hallsEnabled() ? deleteHallCatalog(new URL(request.url).searchParams.get("hallId") ?? "", "trainers", new URL(request.url).searchParams.get("id") ?? "", Number(new URL(request.url).searchParams.get("revision") ?? "NaN")) : deleteTrainer(new URL(request.url).searchParams.get("id") ?? ""));
}
