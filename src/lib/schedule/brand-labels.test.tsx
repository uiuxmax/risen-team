import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleSvg } from "@/components/schedule/ScheduleSvg";
import { createDemoHallSnapshot } from "@/lib/schedule/demo-hall";
import { buildScheduleLayout } from "@/lib/schedule/layout";
import { brandLabels, estimateLabelWidth, fitLabelToWidth } from "@/lib/schedule/brand-labels";
import { getTheme, THEME_OPTIONS } from "@/lib/theme/risen-team-dark";

describe("long brand labels in schedule exports", () => {
  it("preserves short labels and avoids incomplete surrogate characters when shortening", () => {
    expect(fitLabelToWidth("RISEN TEAM", 300, 18, 2)).toBe("RISEN TEAM");
    const result = fitLabelToWidth("🥊🥊🥊🥊🥊🥊", 40, 18, 2);
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(estimateLabelWidth(result, 18, 2)).toBeLessThanOrEqual(40);
    expect(fitLabelToWidth("TITLE", 0, 18, 2)).toBe("");
    expect(fitLabelToWidth("TITLE", 1, 18, 2)).toBe("");
  });

  it.each(THEME_OPTIONS)("keeps text-only fallback labels inside the $id brand panel and retains the full accessible text", ({ id }) => {
    const demo = createDemoHallSnapshot();
    const layout = buildScheduleLayout({ ...demo, theme: getTheme(id), width: 1680, height: 880 });
    const labels = brandLabels(layout);
    expect(labels.subtitle.text).not.toBe(labels.subtitle.fullText);
    expect(labels.subtitle.text.endsWith("…")).toBe(true);
    for (const label of [labels.title, labels.subtitle]) {
      expect(estimateLabelWidth(label.text, label.fontSize, label.letterSpacing)).toBeLessThanOrEqual(labels.width);
    }
    const markup = renderToStaticMarkup(<ScheduleSvg layout={{ ...layout, settings: { ...layout.settings, logoDataUrl: null } }} />);
    expect(markup).toContain(`<title>${labels.subtitle.fullText}</title>`);
    expect(markup).toContain(`aria-label="${labels.subtitle.fullText}"`);
    expect(markup).toContain(labels.subtitle.text);
    expect(markup).toMatch(/clip-path="url\(#brand-label-/);
  });
});
