import { hallsEnabled, hallAction } from "@/lib/server/halls";
import { readJson, withMutationApi } from "@/lib/server/api";
import { scheduleAction } from "@/lib/server/admin";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withMutationApi(request, async () => hallsEnabled() ? hallAction(await readJson(request)) : scheduleAction(await readJson(request)));
}
