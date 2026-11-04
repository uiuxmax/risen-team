"use client";

import { useMemo, useState } from "react";
import { useWorkspace } from "@/components/app/WorkspaceProvider";
import { Button, Chip, EmptyState, Field, Panel, SelectInput, TextInput } from "@/components/ui/controls";
import { useI18n } from "@/components/app/LanguageProvider";
import { buildMarkers, nextMarkerSuggestion, timeToMinutes } from "@/lib/schedule/time";
import type { ScheduleLayout } from "@/lib/schedule/layout";

export interface Filters {
  trainerId: string;
  classTypeId: string;
  day: string;
}

export const EMPTY_FILTERS: Filters = { trainerId: "all", classTypeId: "all", day: "all" };

export function FiltersPanel({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (filters: Filters) => void;
}) {
  const { t, dayName } = useI18n();
  const { trainers, classTypes, settings } = useWorkspace();
  const active = filters.trainerId !== "all" || filters.classTypeId !== "all" || filters.day !== "all";

  return (
    <Panel
      title={t("filters.title")}
      aside={
        active ? (
          <Button size="sm" variant="ghost" onClick={() => onChange(EMPTY_FILTERS)}>
            {t("filters.reset")}
          </Button>
        ) : (
          <Chip tone="neutral">{t("filters.viewOnly")}</Chip>
        )
      }
    >
      <div className="grid grid-cols-1 gap-3">
        <Field label={t("filters.trainer")}>
          <SelectInput value={filters.trainerId} onChange={(event) => onChange({ ...filters, trainerId: event.target.value })}>
            <option value="all">{t("filters.allTrainers")}</option>
            {trainers.map((trainer) => (
              <option key={trainer.id} value={trainer.id}>
                {trainer.name}
                {trainer.active ? "" : ` (${t("common.inactive")})`}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label={t("filters.classType")}>
          <SelectInput
            value={filters.classTypeId}
            onChange={(event) => onChange({ ...filters, classTypeId: event.target.value })}
          >
            <option value="all">{t("filters.allClasses")}</option>
            {classTypes.map((classType) => (
              <option key={classType.id} value={classType.id}>
                {classType.name}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label={t("filters.day")}>
          <SelectInput value={filters.day} onChange={(event) => onChange({ ...filters, day: event.target.value })}>
            <option value="all">{t("filters.allDays")}</option>
            {settings.visibleDays.map((day) => (
              <option key={day} value={String(day)}>
                {dayName(day)}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>
      <p className="mt-3 text-[11px] text-slate-500">{t("filters.hint")}</p>
    </Panel>
  );
}

export function TimeMarkersPanel({ layout }: { layout: ScheduleLayout }) {
  const { t } = useI18n();
  const { settings, dispatch, toast } = useWorkspace();
  const [custom, setCustom] = useState("");
  const markers = useMemo(() => buildMarkers(settings), [settings]);
  const suggestion = useMemo(() => {
    const last = markers[markers.length - 2] ?? markers[0];
    return last ? nextMarkerSuggestion(last.label, "below", markers, settings.snapMinutes) : "12:30";
  }, [markers, settings.snapMinutes]);

  return (
    <Panel
      title={t("markers.title")}
      aside={<Chip tone="neutral">{t("markers.visible", { count: layout.markers.length })}</Chip>}
    >
      <p className="text-[11px] text-slate-500">{t("markers.hint")}</p>
      <div className="mt-3 max-h-52 overflow-y-auto rounded-md border border-[#1c212c]">
        {markers.map((marker) => (
          <div
            key={`${marker.minutes}-${marker.kind}`}
            className="flex items-center justify-between gap-2 border-b border-[#161a23] px-2.5 py-1.5 last:border-b-0"
          >
            <span className="flex items-center gap-2">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background:
                    marker.kind === "custom" ? "#facc15" : marker.kind === "boundary" ? "#d3d9e6" : "#4b5364",
                }}
              />
              <span className="font-mono text-xs text-slate-200">{marker.label}</span>
              <span className="text-[10px] uppercase tracking-wide text-slate-500">
                {marker.kind === "custom"
                  ? t("markers.kindCustom")
                  : marker.kind === "boundary"
                    ? t("markers.kindBoundary")
                    : t("markers.kindGrid")}
              </span>
            </span>
            <span className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                title={t("markers.addAbove")}
                onClick={() => {
                  const value = nextMarkerSuggestion(marker.label, "above", markers, settings.snapMinutes);
                  dispatch({ type: "addMarker", time: value });
                }}
              >
                ↑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title={t("markers.addBelow")}
                onClick={() => {
                  const value = nextMarkerSuggestion(marker.label, "below", markers, settings.snapMinutes);
                  dispatch({ type: "addMarker", time: value });
                }}
              >
                ↓
              </Button>
              {marker.kind === "custom" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  title={t("markers.hide")}
                  onClick={() => dispatch({ type: "removeMarker", time: marker.label })}
                >
                  ✕
                </Button>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-end gap-2">
        <Field label={t("markers.addCustom")} className="flex-1">
          <TextInput
            type="time"
            step={300}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="15:45"
          />
        </Field>
        <Button
          variant="outline"
          onClick={() => {
            if (!custom) return;
            if (timeToMinutes(custom) <= timeToMinutes(settings.startTime) || timeToMinutes(custom) >= timeToMinutes(settings.endTime)) {
              toast(t("markers.outsideWindow"), "warning");
              return;
            }
            dispatch({ type: "addMarker", time: custom });
            setCustom("");
          }}
        >
          {t("common.add")}
        </Button>
      </div>
      <Button size="sm" variant="subtle" className="mt-2" onClick={() => dispatch({ type: "addMarker", time: suggestion })}>
        {t("markers.quickAdd", { time: suggestion })}
      </Button>
    </Panel>
  );
}

export function ConflictsPanel({ onFocusEvent }: { onFocusEvent: (eventId: string) => void }) {
  const { t } = useI18n();
  const { conflicts } = useWorkspace();
  const errors = conflicts.filter((conflict) => conflict.severity === "error");
  const warnings = conflicts.filter((conflict) => conflict.severity === "warning");

  if (conflicts.length === 0) {
    return (
      <Panel title={t("conflicts.title")}>
        <div className="flex items-center gap-2 rounded-md border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-300">
          {t("conflicts.none")}
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title={t("conflicts.title")}
      aside={
        <span className="flex gap-1">
          {errors.length > 0 ? <Chip tone="danger">{t("conflicts.errors", { count: errors.length })}</Chip> : null}
          {warnings.length > 0 ? <Chip tone="warning">{t("conflicts.warnings", { count: warnings.length })}</Chip> : null}
        </span>
      }
    >
      <ul className="max-h-64 space-y-1.5 overflow-y-auto">
        {[...errors, ...warnings].map((conflict) => (
          <li key={conflict.id}>
            <button
              type="button"
              onClick={() => onFocusEvent(conflict.eventIds[0])}
              className="w-full rounded-md border border-[#1e232e] px-2.5 py-1.5 text-left text-xs text-slate-300 hover:border-[#333a4b]"
            >
              <span
                className={`mr-1.5 font-semibold ${conflict.severity === "error" ? "text-rose-400" : "text-amber-400"}`}
              >
                {conflict.severity === "error" ? t("common.error") : t("common.warning")}
              </span>
              {conflict.message}
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function DuplicateToolsPanel({
  onCopyDay,
  onDuplicateSchedule,
  onCreateSchedule,
}: {
  onCopyDay: () => void;
  onDuplicateSchedule: () => void;
  onCreateSchedule: () => void;
}) {
  const { t } = useI18n();
  const { events, settings } = useWorkspace();
  return (
    <Panel title={t("duplicate.title")}>
      <div className="flex flex-col gap-2">
        <Button variant="outline" onClick={onCopyDay}>
          {t("duplicate.copyDay")}
        </Button>
        <Button variant="outline" onClick={onDuplicateSchedule}>
          {t("duplicate.duplicateWeek")}
        </Button>
        <Button variant="outline" onClick={onCreateSchedule}>
          {t("duplicate.createEmpty")}
        </Button>
        <p className="text-[11px] text-slate-500">
          {t("duplicate.summary", { count: events.length, days: settings.visibleDays.length })}
        </p>
      </div>
    </Panel>
  );
}

export function EmptyTrainerNotice({ onGo }: { onGo: () => void }) {
  const { t } = useI18n();
  return (
    <EmptyState
      title={t("manage.trainersEmpty")}
      hint={t("manage.trainersEmptyHint")}
      action={
        <Button variant="primary" className="mt-2" onClick={onGo}>
          {t("editor.openManage")}
        </Button>
      }
    />
  );
}
