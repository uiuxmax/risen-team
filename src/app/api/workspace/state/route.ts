import { hallsEnabled, saveHallState } from "@/lib/server/halls";
import { readJson, withMutationApi } from "@/lib/server/api";
import { saveScheduleState } from "@/lib/server/workspace";
import { normalizeLegacyLogoDataUrl } from "@/lib/server/assets";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  return withMutationApi(request, async () => {
    const body = await readJson(request);
    if (body && typeof body === "object" && "settings" in body && body.settings && typeof body.settings === "object" && "logoDataUrl" in body.settings && typeof body.settings.logoDataUrl === "string") {
      body.settings.logoDataUrl = await normalizeLegacyLogoDataUrl(body.settings.logoDataUrl);
    }
    return hallsEnabled() ? saveHallState(body) : saveScheduleState(body);
  });
}
