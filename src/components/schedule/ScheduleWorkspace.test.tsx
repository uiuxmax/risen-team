// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LanguageProvider } from "@/components/app/LanguageProvider";
import { ScheduleWorkspace } from "@/components/schedule/ScheduleWorkspace";
import { EditorCanvas, type EditorCanvasProps } from "@/components/schedule/EditorCanvas";
import { createDemoHallSnapshot } from "@/lib/schedule/demo-hall";
import { buildScheduleLayout } from "@/lib/schedule/layout";
import { getTheme } from "@/lib/theme/risen-team-dark";
import { createTranslator } from "@/lib/i18n";

const { context } = vi.hoisted(() => ({ context: { value: {} as Record<string, unknown> } }));
vi.mock("@/components/app/WorkspaceProvider", () => ({ useWorkspace: () => context.value }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/schedule/EditorSidebar", () => ({
  EMPTY_FILTERS: { trainerId: "all", classTypeId: "all", day: "all" },
  FiltersPanel: () => null, TimeMarkersPanel: () => null, ConflictsPanel: () => null,
}));
vi.mock("@/components/schedule/dialogs", () => ({ EventDialog: () => null, CopyDayDialog: () => null, SnapshotDialog: () => null }));

const demo = createDemoHallSnapshot();
const layout = buildScheduleLayout({ ...demo, theme: getTheme(demo.settings.themeId), width: 1200, height: 900 });
const t = createTranslator("en");

beforeEach(() => {
  localStorage.setItem("tn:language", "en");
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  context.value = { ...demo, loading: false, workspace: { schedules: [demo.schedule], activeScheduleId: demo.schedule.id },
    conflicts: [], editorState: demo, dispatch: vi.fn(), applyTransient: vi.fn(), commit: vi.fn(),
    canUndo: false, canRedo: false, runUndo: vi.fn(), runRedo: vi.fn(), saveNow: vi.fn(), createSnapshot: vi.fn(), reload: vi.fn(), toast: vi.fn(),
  };
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe("schedule pointer selection", () => {
  it("keeps a card selected through pointerdown bubbling so keyboard deletion targets it", () => {
    render(<LanguageProvider><ScheduleWorkspace /></LanguageProvider>);
    const card = screen.getAllByRole("button", { name: /08:00.*09:00/ })[0];
    fireEvent.pointerDown(card.firstElementChild!, { button: 0, clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("clears the selection when pressing the canvas surround", () => {
    render(<LanguageProvider><ScheduleWorkspace /></LanguageProvider>);
    const card = screen.getAllByRole("button", { name: /08:00.*09:00/ })[0];
    fireEvent.pointerDown(card, { button: 0, clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerDown(card.parentElement!.parentElement!, { button: 0 });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

function renderCanvas() {
  const props: EditorCanvasProps = {
    layout, selectedEventId: null, dimUnmatched: false, visibleEventIds: new Set(), conflictEventIds: new Set(),
    onSelect: vi.fn(), onRequestCreate: vi.fn(), onRequestEdit: vi.fn(), onDragStart: vi.fn(), onDragPreview: vi.fn(),
    onDragCommit: vi.fn(), onResizePreview: vi.fn(), onResizeCommit: vi.fn(), onDragCancel: vi.fn(),
  };
  const view = render(<LanguageProvider><EditorCanvas {...props} /></LanguageProvider>);
  return { ...view, props };
}

describe("add-class hover hint", () => {
  it("creates a class at the hovered weekday and snapped time when the hint is clicked", () => {
    const { container, props } = renderCanvas();
    const day = layout.days[2];
    const slot = container.querySelectorAll(".cursor-copy")[2];
    fireEvent.pointerMove(slot, { clientY: layout.timeToY(15 * 60 + 30), clientX: day.x + 20 });
    const hint = screen.getByText(t("editor.addClassHint"));
    fireEvent.click(hint);
    expect(props.onRequestCreate).toHaveBeenCalledExactlyOnceWith(day.dayOfWeek, "15:30");
  });

  it("offers a focusable native button that keyboard activation can use without prior hovering", () => {
    const { props } = renderCanvas();
    const hint = screen.getByRole("button", { name: t("editor.addClassHint") }) as HTMLButtonElement;
    expect(hint.tagName).toBe("BUTTON");
    expect(hint.tabIndex).toBe(0);
    hint.focus();
    expect(document.activeElement).toBe(hint);
    // Native button keyboard activation dispatches a click with detail=0.
    fireEvent.click(hint, { detail: 0 });
    expect(props.onRequestCreate).toHaveBeenCalledExactlyOnceWith(layout.days[0].dayOfWeek, demo.settings.startTime);
  });
});
