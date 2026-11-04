import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleSvg } from "@/components/schedule/ScheduleSvg";
import { DEFAULT_SETTINGS } from "@/lib/domain/types";
import { buildScheduleLayout } from "@/lib/schedule/layout";
import { getTheme, THEME_OPTIONS } from "@/lib/theme/risen-team-dark";

function layout(logoDataUrl: string | null = null, showLogo = true, themeId = "risen-team-dark") {
  return buildScheduleLayout({ settings: { ...DEFAULT_SETTINGS, logoDataUrl, showLogo },
    events: [], trainers: [], classTypes: [], rooms: [], theme: getTheme(themeId), width: 1680, height: 880 });
}

describe("bundled default Risen Team artwork", () => {
  it.each(THEME_OPTIONS)("embeds the supplied full logo in $id exports without external resources or persisted branding", ({ id }) => {
    const input = { ...DEFAULT_SETTINGS };
    const result = layout(input.logoDataUrl, true, id);
    const markup = renderToStaticMarkup(<ScheduleSvg layout={result} />);
    const image = markup.match(/<image[^>]*href="(data:image\/svg\+xml;base64,[^"]+)"/);
    expect(image, "The export must contain the actual bundled artwork").not.toBeNull();
    const artwork = Buffer.from(image![1].split(",")[1], "base64").toString("utf8");
    expect(artwork).toBe(fs.readFileSync("assets/logo-full.svg", "utf8"));
    expect(input.logoDataUrl).toBeNull();
  });

  it("respects a custom logo and the hide-logo setting", () => {
    const custom = "data:image/png;base64,custom";
    expect(renderToStaticMarkup(<ScheduleSvg layout={layout(custom)} />)).toContain(`href="${custom}"`);
    expect(renderToStaticMarkup(<ScheduleSvg layout={layout(null, false)} />)).not.toContain("<image");
  });
});
