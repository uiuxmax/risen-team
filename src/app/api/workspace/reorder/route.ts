import { hallsEnabled, reorderHallCatalog } from "@/lib/server/halls";
import { readJson, withMutationApi } from "@/lib/server/api";
import { reorderEntities } from "@/lib/server/admin";

export const dynamic = "force-dynamic";

/**
 * Atomic batch reorder (`{ entity, order }`).
 *
 * A drag/move of one row used to be two independent requests (two `sortOrder`
 * writes), which could partially fail and leave ambiguous ordering. The UI
 * still submits a single move; the whole list order is applied in one
 * transaction — all rows or none.
 */
export async function POST(request: Request) {
  return withMutationApi(request, async () => hallsEnabled() ? reorderHallCatalog(new URL(request.url).searchParams.get("hallId") ?? "", await readJson(request)) : reorderEntities(await readJson(request)));
}
