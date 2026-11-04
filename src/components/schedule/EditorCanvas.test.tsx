// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { EditorCanvas, type EditorCanvasProps } from "@/components/schedule/EditorCanvas";
import { ScheduleSvg } from "@/components/schedule/ScheduleSvg";
import { LanguageProvider } from "@/components/app/LanguageProvider";
import { buildScheduleLayout } from "@/lib/schedule/layout";
import { createDemoHallSnapshot } from "@/lib/schedule/demo-hall";
import { getTheme, THEME_OPTIONS } from "@/lib/theme/risen-team-dark";
import { DEFAULT_LOGO_DATA_URL } from "@/lib/branding/default-logo";

afterEach(cleanup);

function renderPair(themeId: string, logo: string | null, showLogo = true) {
  const demo = createDemoHallSnapshot();
  const layout = buildScheduleLayout({
    ...demo, settings: { ...demo.settings, logoDataUrl: logo, showLogo },
    theme: getTheme(themeId), width: 1200, height: 900,
  });
  const props: EditorCanvasProps = {
    layout, selectedEventId: null, dimUnmatched: false, visibleEventIds: new Set(), conflictEventIds: new Set(),
    onSelect: vi.fn(), onRequestCreate: vi.fn(), onRequestEdit: vi.fn(), onDragStart: vi.fn(), onDragPreview: vi.fn(),
    onDragCommit: vi.fn(), onResizePreview: vi.fn(), onResizeCommit: vi.fn(), onDragCancel: vi.fn(),
  };
  const view = render(<LanguageProvider><EditorCanvas {...props} /><ScheduleSvg layout={layout} /></LanguageProvider>);
  return { ...view, layout };
}

const customLogo = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjAwIDEwMCI+PHJlY3Qgd2lkdGg9IjEyMDAiIGhlaWdodD0iMTAwIi8+PC9zdmc+";

describe.each(THEME_OPTIONS)("editor/export logo box parity for $id", ({ id }) => {
  it.each([null, customLogo])("gives the default or custom logo the same centered rotated box as SVG export (%s)", logo => {
    const { container, layout } = renderPair(id, logo);
    const editorImage = container.querySelector("img")!;
    const exportedImage = container.querySelector("svg image")!;
    expect(editorImage.getAttribute("src")).toBe(logo ?? DEFAULT_LOGO_DATA_URL);
    expect(exportedImage.getAttribute("href")).toBe(editorImage.getAttribute("src"));
    expect(editorImage.style.width).toBe(`${exportedImage.getAttribute("width")}px`);
    expect(editorImage.style.height).toBe(`${exportedImage.getAttribute("height")}px`);
    // Tailwind's image reset must not clamp the pre-rotation width to the rail.
    expect(editorImage.style.maxWidth).toBe("none");
    expect(editorImage.classList.contains("shrink-0")).toBe(true);
    expect(editorImage.classList.contains("object-contain")).toBe(true);
    expect(editorImage.style.transform).toBe("rotate(-90deg)");

    const editorBox = editorImage.parentElement!;
    expect(editorBox.classList.contains("items-center")).toBe(true);
    expect(editorBox.classList.contains("justify-center")).toBe(true);
    const editorCenterX = layout.brand.rect.x + Number.parseFloat(editorBox.style.left) + Number.parseFloat(editorBox.style.width) / 2;
    const editorCenterY = layout.brand.rect.y + Number.parseFloat(editorBox.style.top) + Number.parseFloat(editorBox.style.height) / 2;
    const exportCenterX = Number(exportedImage.getAttribute("x")) + Number(exportedImage.getAttribute("width")) / 2;
    const exportCenterY = Number(exportedImage.getAttribute("y")) + Number(exportedImage.getAttribute("height")) / 2;
    expect(editorCenterX).toBeCloseTo(exportCenterX);
    expect(editorCenterY).toBeCloseTo(exportCenterY);
    expect(exportedImage.getAttribute("transform")).toBe(`rotate(-90 ${editorCenterX} ${editorCenterY})`);
  });
});

it.each([null, customLogo])("suppresses both default and custom logo artwork when disabled (%s)", logo => {
  const { container } = renderPair("risen-team-dark", logo, false);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg image")).toBeNull();
});
