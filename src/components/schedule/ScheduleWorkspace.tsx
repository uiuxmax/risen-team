"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/components/app/WorkspaceProvider";
import { EditorCanvas } from "@/components/schedule/EditorCanvas";
import { ScheduleSvg } from "@/components/schedule/ScheduleSvg";
import { CopyDayDialog, EventDialog, SnapshotDialog } from "@/components/schedule/dialogs";
import {
  ConflictsPanel,
  EMPTY_FILTERS,
  FiltersPanel,
  TimeMarkersPanel,
  type Filters,
} from "@/components/schedule/EditorSidebar";
import { Button, EmptyState, Modal, SelectInput } from "@/components/ui/controls";
import { type ScheduleEvent } from "@/lib/domain/types";
import { buildScheduleLayout } from "@/lib/schedule/layout";
import { getTheme } from "@/lib/theme/risen-team-dark";
import { timeToMinutes } from "@/lib/schedule/time";
import type { EditorState } from "@/lib/schedule/editor";
import { useI18n } from "@/components/app/LanguageProvider";
import { uuid } from "@/lib/client/api";

const PREVIEW_CANVAS = { width: 1680, height: 880 };

export function ScheduleWorkspace() {
  const { workspace } = useWorkspace();
  return <HallScheduleWorkspace key={`${workspace?.workspaceId ?? "legacy"}:${workspace?.hallId ?? workspace?.activeScheduleId ?? "empty"}`} />;
}

function HallScheduleWorkspace() {
  const router = useRouter();
  const { t, dayName } = useI18n();
  const {
    loading,
    workspace,
    schedule,
    events,
    settings,
    trainers,
    classTypes,
    rooms,
    conflicts,
    dispatch,
    applyTransient,
    commit,
    editorState,
    canUndo,
    canRedo,
    runUndo,
    runRedo,
    saveNow,
    createSnapshot,
    reload,
    toast,
  } = useWorkspace();

  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ mode: "create" | "edit"; draft: Partial<ScheduleEvent> } | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ScheduleEvent | null>(null);
  const [zoom, setZoom] = useState(0.95);
  const [availableWidth, setAvailableWidth] = useState(1500);
  const [previewSidebarOpen, setPreviewSidebarOpen] = useState(false);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const dragBaseRef = useRef<EditorState | null>(null);

  const theme = useMemo(() => getTheme(settings.themeId), [settings.themeId]);

  const labels = useMemo(
    () => ({
      dayName,
      dayShort: (dayOfWeek: number) => t(`dayShort.${dayOfWeek}` as "dayShort.0"),
      legendTitle: t("legend.title"),
      legendSummary: (trainerCount: number, classCount: number) =>
        t("legend.summary", { trainers: trainerCount, classes: classCount }),
    }),
    [dayName, t],
  );

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setAvailableWidth(Math.max(640, Math.floor(width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const windowMinutes = Math.max(60, timeToMinutes(settings.endTime) - timeToMinutes(settings.startTime));
  const bottomLegend = settings.showTrainerLegend && settings.legendPosition === "bottom";
  const verticalFix =
    theme.canvas.padding * 2 + theme.header.height + theme.days.headerHeight + (bottomLegend ? 96 : 0);
  const canvasWidth = Math.max(720, availableWidth - 8);
  const canvasHeight = Math.round(verticalFix + windowMinutes * zoom);

  const editLayout = useMemo(
    () =>
      buildScheduleLayout({
        settings,
        events,
        trainers,
        classTypes,
        rooms,
        theme,
        width: canvasWidth,
        height: canvasHeight,
        metaLabel: settings.effectiveDate ?? undefined,
        labels,
      }),
    [settings, events, trainers, classTypes, rooms, theme, canvasWidth, canvasHeight, labels],
  );

  const previewLayout = useMemo(
    () =>
      buildScheduleLayout({
        settings,
        events,
        trainers,
        classTypes,
        rooms,
        theme,
        width: PREVIEW_CANVAS.width,
        height: PREVIEW_CANVAS.height,
        metaLabel: settings.effectiveDate ?? undefined,
        labels,
      }),
    [settings, events, trainers, classTypes, rooms, theme, labels],
  );

  const activeFilters = filters.trainerId !== "all" || filters.classTypeId !== "all" || filters.day !== "all";
  const visibleEventIds = useMemo(() => {
    const set = new Set<string>();
    for (const event of events) {
      if (filters.trainerId !== "all" && event.trainerId !== filters.trainerId) continue;
      if (filters.classTypeId !== "all" && event.classTypeId !== filters.classTypeId) continue;
      if (filters.day !== "all" && event.dayOfWeek !== Number(filters.day)) continue;
      set.add(event.id);
    }
    return set;
  }, [events, filters]);

  const conflictEventIds = useMemo(() => {
    const set = new Set<string>();
    for (const conflict of conflicts) {
      for (const id of conflict.eventIds) set.add(id);
    }
    return set;
  }, [conflicts]);

  const describe = useCallback(
    (event: ScheduleEvent) => {
      const classType = classTypes.find((item) => item.id === event.classTypeId)?.name ?? t("dialog.classType");
      const trainer = trainers.find((item) => item.id === event.trainerId)?.name ?? t("dialog.trainer");
      return `${classType} (${trainer}) ${dayName(event.dayOfWeek)} ${event.startTime}–${event.endTime}`;
    },
    [classTypes, trainers, t, dayName],
  );

  const selectedEvent = events.find((event) => event.id === selectedId) ?? null;

  const setWorkspaceMode = (nextMode: "edit" | "preview") => {
    setMode(nextMode);
    if (nextMode === "preview") setPreviewSidebarOpen(false);
  };


  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (typing || dialog) return;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "d" && selectedEvent) {
        event.preventDefault();
        dispatch({
          type: "addEvent",
          event: { ...selectedEvent, id: uuid() },
          description: `${t("editor.classDuplicated")}: ${describe(selectedEvent)}`,
        });
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedEvent) {
        event.preventDefault();
        setPendingDelete(selectedEvent);
      }
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [describe, dialog, dispatch, selectedEvent, t]);

  if (loading && !workspace) {
    return <p className="py-16 text-center text-sm text-slate-500">{t("state.loading")}</p>;
  }
  if (!workspace || !schedule) {
    if (workspace?.empty) return <EmptyState title={t("halls.empty")} hint={t("halls.emptyHint")} />;
    return (
      <p className="py-16 text-center text-sm text-slate-400">{t("state.workspaceFailed")}</p>
    );
  }


  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="no-print flex flex-wrap items-center gap-2 rounded-lg border border-[#1d222d] bg-[#0d1016] px-3 py-2">
        <SelectInput
          className="w-auto min-w-[190px]"
          value={schedule.id}
          onChange={(event) => void reload(event.target.value)}
          aria-label={t("halls.select")}
        >
          {workspace.schedules
            .filter((item) => !item.isArchived)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          {workspace.schedules.some((item) => item.isArchived) ? <option disabled>{t("editor.archivedDivider")}</option> : null}
          {workspace.schedules
            .filter((item) => item.isArchived)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({t("editor.archivedSuffix")})
              </option>
            ))}
        </SelectInput>


        <div className="flex items-center gap-2 border-l border-[#242936] pl-2 first:border-l-0 first:pl-0">
          <Button size="sm" variant="outline" onClick={runUndo} disabled={!canUndo} title={t("editor.undoTitle")}>
            {t("editor.undo")}
          </Button>
          <Button size="sm" variant="outline" onClick={runRedo} disabled={!canRedo} title={t("editor.redoTitle")}>
            {t("editor.redo")}
          </Button>
        </div>

        <div className="flex items-center gap-2 border-l border-[#242936] pl-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              setDialog({
                mode: "create",
                draft: {
                  scheduleId: schedule.id,
                  dayOfWeek: settings.visibleDays[0] ?? 0,
                  startTime: settings.startTime,
                },
              })
            }
          >
            {t("editor.addClass")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCopyOpen(true)}>
            {t("editor.copyDay")}
          </Button>
        </div>

        <div className="flex items-center gap-2 border-l border-[#242936] pl-2">
          <Button size="sm" variant="outline" onClick={() => setSnapshotOpen(true)}>
            {t("editor.checkpoint")}
          </Button>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-2 border-l border-[#242936] pl-2">
          <div className="flex items-center gap-1 rounded-md border border-[#242936] p-0.5">
            <Button size="sm" variant={mode === "edit" ? "subtle" : "ghost"} onClick={() => setWorkspaceMode("edit")}>
              {t("editor.modeEdit")}
            </Button>
            <Button size="sm" variant={mode === "preview" ? "subtle" : "ghost"} onClick={() => setWorkspaceMode("preview")}>
              {t("editor.modePreview")}
            </Button>
          </div>
          {mode === "preview" ? (
            <Button size="sm" variant="ghost" onClick={() => setPreviewSidebarOpen((value) => !value)}>
              {previewSidebarOpen ? t("editor.hidePanels") : t("editor.showPanels")}
            </Button>
          ) : null}
        </div>

        {mode === "edit" ? (
          <span className="flex items-center gap-1 border-l border-[#242936] pl-2">
            <Button size="sm" variant="ghost" onClick={() => setZoom((value) => Math.max(0.6, value - 0.1))} title={t("editor.zoomOut")}>
              −
            </Button>
            <span className="w-10 text-center text-[11px] text-slate-500">{Math.round(zoom * 100)}%</span>
            <Button size="sm" variant="ghost" onClick={() => setZoom((value) => Math.min(1.6, value + 0.1))} title={t("editor.zoomIn")}>
              +
            </Button>
          </span>
        ) : null}

        <div className="flex items-center gap-2 border-l border-[#242936] pl-2">
          <Button size="sm" variant="outline" onClick={() => router.push("/export")}>
            {t("editor.exportPrint")}
          </Button>
        </div>
      </div>

      {trainers.length === 0 ? (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-amber-900/50 bg-amber-950/20 px-4 py-3 text-sm text-amber-100">
          <span>{t("editor.noTrainers")}</span>
          <Button variant="primary" onClick={() => router.push("/manage")}>
            {t("editor.openManage")}
          </Button>
        </div>
      ) : null}

      {events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#2a3040] bg-[#0e1118] px-4 py-3 text-xs text-slate-400">
          {t("editor.emptySchedule")}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 xl:flex-row">
        <div className="min-w-0 flex-1">
          {mode === "preview" ? (
            <div ref={wrapperRef} className="overflow-x-auto rounded-lg border border-[#1d222d] bg-[#0a0b0f] p-3">
              <div className="mx-auto w-full">
                <ScheduleSvg layout={previewLayout} fitWidth />
              </div>
              <p className="mt-2 text-center text-[11px] text-slate-500">{t("editor.previewHint")}</p>
            </div>
          ) : (
            <div
              ref={wrapperRef}
              className="overflow-x-auto rounded-lg border border-[#1d222d] bg-[#0a0b0f] p-2"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setSelectedId(null);
              }}
            >
              <EditorCanvas
                layout={editLayout}
                selectedEventId={selectedId}
                dimUnmatched={activeFilters}
                visibleEventIds={visibleEventIds}
                conflictEventIds={conflictEventIds}
                onSelect={setSelectedId}
                onRequestEdit={(event) => setDialog({ mode: "edit", draft: event })}
                onRequestCreate={(dayOfWeek, startTime) =>
                  setDialog({
                    mode: "create",
                    draft: { scheduleId: schedule.id, dayOfWeek, startTime },
                  })
                }
                onDragStart={() => {
                  dragBaseRef.current = editorState;
                }}
                onDragPreview={(eventId, dayOfWeek, startTime) =>
                  applyTransient({ type: "moveEvent", id: eventId, dayOfWeek, startTime })
                }
                onDragCommit={(eventId, dayOfWeek, startTime) => {
                  const base = dragBaseRef.current ?? editorState;
                  const event = base.events.find((item) => item.id === eventId);
                  commit(
                    {
                      type: "moveEvent",
                      id: eventId,
                      dayOfWeek,
                      startTime,
                      label: event
                        ? t("history.moved", {
                            class: describe(event),
                            day: dayName(dayOfWeek),
                            start: startTime,
                            end: "",
                          })
                        : undefined,
                    },
                    base,
                  );
                }}
                onResizePreview={(eventId, endTime) => applyTransient({ type: "resizeEvent", id: eventId, endTime })}
                onResizeCommit={(eventId, endTime) => {
                  const base = dragBaseRef.current ?? editorState;
                  const event = base.events.find((item) => item.id === eventId);
                  commit(
                    {
                      type: "resizeEvent",
                      id: eventId,
                      endTime,
                      label: event
                        ? t("history.resized", { class: describe(event), day: "", start: "", end: endTime })
                        : undefined,
                    },
                    base,
                  );
                }}
                onDragCancel={() => {
                  const base = dragBaseRef.current;
                  if (base) applyTransient({ type: "replace", state: base, description: t("history.cancelled") });
                }}
                onTrainerFilter={(trainerId) =>
                  setFilters((current) => ({
                    ...current,
                    trainerId: current.trainerId === trainerId ? "all" : trainerId,
                  }))
                }
              />
            </div>
          )}
        </div>

        {mode === "edit" || previewSidebarOpen ? (
          <aside className="no-print flex w-full shrink-0 flex-col gap-2.5 xl:w-[310px]">
            <FiltersPanel filters={filters} onChange={setFilters} />
            <TimeMarkersPanel layout={editLayout} />
            <ConflictsPanel onFocusEvent={(eventId) => setSelectedId(eventId)} />

          </aside>
        ) : null}
      </div>

      <EventDialog
        open={dialog !== null}
        mode={dialog?.mode ?? "create"}
        scheduleId={schedule.id}
        initial={dialog?.draft ?? null}
        events={events}
        trainers={trainers}
        classTypes={classTypes}
        rooms={rooms}
        settings={settings}
        onClose={() => setDialog(null)}
        onSave={(event) => {
          if (dialog?.mode === "edit") {
            dispatch({
              type: "updateEvent",
              id: event.id,
              patch: event,
              description: `${t("editor.classUpdated")}: ${describe(event)}`,
            });
            toast(t("editor.classUpdated"), "success");
          } else {
            dispatch({
              type: "addEvent",
              event: { ...event, id: event.id || uuid() },
              description: `${t("editor.classAdded")}: ${describe(event)}`,
            });
            toast(t("editor.classAdded"), "success");
          }
          setSelectedId(event.id);
          setDialog(null);
        }}
        onDuplicate={(event) => {
          dispatch({
            type: "addEvent",
            event: { ...event, id: uuid() },
            description: `${t("editor.classDuplicated")}: ${describe(event)}`,
          });
          toast(t("editor.classDuplicated"), "success");
          setDialog(null);
        }}
        onDelete={(event) => {
          setPendingDelete(event);
          setDialog(null);
        }}
      />

      <CopyDayDialog
        open={copyOpen}
        days={settings.visibleDays}
        onClose={() => setCopyOpen(false)}
        onConfirm={(from, to, copyMode) => {
          const source = events.filter((event) => event.dayOfWeek === from);
          dispatch({
            type: "copyDay",
            fromDay: from,
            toDay: to,
            mode: copyMode,
            newIds: source.map(() => uuid()),
          });
          setCopyOpen(false);
          toast(
            t("toast.copyDayDone", {
              from: dayName(from),
              to: dayName(to),
              mode: copyMode === "replace" ? t("toast.copyDayReplace") : t("toast.copyDayMerge"),
            }),
            "success",
          );
        }}
      />

      <SnapshotDialog
        key={snapshotOpen ? "snapshot-open" : "snapshot-closed"}
        open={snapshotOpen}
        onClose={() => setSnapshotOpen(false)}
        onConfirm={async (description) => {
          return createSnapshot(description);
        }}
      />

      <Modal
        open={pendingDelete !== null}
        alert
        title={t("dialog.deleteTitle")}
        description={pendingDelete ? describe(pendingDelete) : ""}
        onClose={() => setPendingDelete(null)}
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!pendingDelete) return;
                dispatch({
                  type: "deleteEvent",
                  id: pendingDelete.id,
                  label: `${t("history.deleted", { class: describe(pendingDelete), day: "", start: "", end: "" })}`,
                });
                setSelectedId(null);
                setPendingDelete(null);
                toast(t("editor.classDeleted"), "info");
              }}
            >
              {t("dialog.deleteClass")}
            </Button>
          </>
        }
      >
        <p className="text-xs text-slate-400">{t("dialog.deleteHint")}</p>
      </Modal>
    </div>
  );
}
