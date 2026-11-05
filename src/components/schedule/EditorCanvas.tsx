"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScheduleEvent } from "@/lib/domain/types";
import type { ScheduleLayout } from "@/lib/schedule/layout";
import { minutesToTime, timeToMinutes } from "@/lib/schedule/time";
import { boundsFromSettings, computePlacement, computeResizeEnd, snappedMinutes } from "@/lib/schedule/placement";
import { useI18n } from "@/components/app/LanguageProvider";
import { brandLabels } from "@/lib/schedule/brand-labels";

interface DragSession {
  kind: "move" | "resize";
  eventId: string;
  event: ScheduleEvent;
  startedAt: { x: number; y: number };
  grabOffsetY: number;
  moved: boolean;
  latest: { dayOfWeek: number; startTime: string; endTime: string };
}

export interface EditorCanvasProps {
  layout: ScheduleLayout;
  selectedEventId: string | null;
  dimUnmatched: boolean;
  visibleEventIds: Set<string>;
  conflictEventIds: Set<string>;
  onSelect: (eventId: string | null) => void;
  onRequestEdit: (event: ScheduleEvent) => void;
  onRequestCreate: (dayOfWeek: number, startTime: string) => void;
  onDragStart: () => void;
  onDragPreview: (eventId: string, dayOfWeek: number, startTime: string) => void;
  onDragCommit: (eventId: string, dayOfWeek: number, startTime: string) => void;
  onResizePreview: (eventId: string, endTime: string) => void;
  onResizeCommit: (eventId: string, endTime: string) => void;
  onDragCancel: () => void;
  onTrainerFilter?: (trainerId: string) => void;
}

export function EditorCanvas(props: EditorCanvasProps) {
  const {
    layout,
    selectedEventId,
    dimUnmatched,
    visibleEventIds,
    conflictEventIds,
    onSelect,
    onRequestEdit,
    onRequestCreate,
    onDragStart,
    onDragPreview,
    onDragCommit,
    onResizePreview,
    onResizeCommit,
    onDragCancel,
    onTrainerFilter,
  } = props;

  const { t, dayName } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  // The dragged event id doubles as the "is dragging" flag: null when idle,
  // set while a drag/resize session is past its activation threshold. Render
  // reads only this state — never the live drag ref.
  const [draggingEventId, setDraggingEventId] = useState<string | null>(null);

  const snap = layout.settings.snapMinutes;
  const theme = layout.theme;
  const fittedBrand = brandLabels(layout);
  // One shared bounds object for hover maths, drag preview, drag commit and resize.
  const bounds = useMemo(() => boundsFromSettings(layout.settings), [layout.settings]);

  const dayBounds = useMemo(
    () => layout.days.map((day) => ({ dayOfWeek: day.dayOfWeek, left: day.x, right: day.x + day.width })),
    [layout.days],
  );

  const minutesAt = useCallback(
    (clientY: number, offsetY = 0) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return layout.startMinutes;
      const y = clientY - rect.top - offsetY;
      return snappedMinutes(layout.yToMinutes(y), bounds);
    },
    [layout, bounds],
  );

  /** Duration of the event currently being dragged (kept constant while moving). */
  const durationOf = useCallback((event: ScheduleEvent) => {
    return Math.max(5, timeToMinutes(event.endTime) - timeToMinutes(event.startTime));
  }, []);

  const dayAt = useCallback(
    (clientX: number, fallback: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return fallback;
      const x = clientX - rect.left;
      const found = dayBounds.find((bounds) => x >= bounds.left && x < bounds.right);
      return found ? found.dayOfWeek : fallback;
    },
    [dayBounds],
  );

  const cancelDrag = useCallback(() => {
    const session = dragRef.current;
    if (!session) return;
    dragRef.current = null;
    setDraggingEventId(null);
    // A press below the move threshold never established a rollback state.
    if (session.moved) onDragCancel();
  }, [onDragCancel]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragRef.current) return;
      cancelDrag();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cancelDrag]);

  const beginMove = (event: ScheduleEvent, nativeEvent: React.PointerEvent<HTMLElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const card = layout.cards.find((item) => item.id === event.id);
    if (!card) return;
    const grabOffsetY = nativeEvent.clientY - rect.top - card.y;
    dragRef.current = {
      kind: "move",
      eventId: event.id,
      event,
      startedAt: { x: nativeEvent.clientX, y: nativeEvent.clientY },
      grabOffsetY,
      moved: false,
      latest: { dayOfWeek: event.dayOfWeek, startTime: event.startTime, endTime: event.endTime },
    };
    onSelect(event.id);
    nativeEvent.currentTarget.setPointerCapture(nativeEvent.pointerId);
  };

  const beginResize = (event: ScheduleEvent, nativeEvent: React.PointerEvent<HTMLElement>) => {
    nativeEvent.stopPropagation();
    dragRef.current = {
      kind: "resize",
      eventId: event.id,
      event,
      startedAt: { x: nativeEvent.clientX, y: nativeEvent.clientY },
      grabOffsetY: 0,
      moved: true,
      latest: { dayOfWeek: event.dayOfWeek, startTime: event.startTime, endTime: event.endTime },
    };
    setDraggingEventId(event.id);
    onDragStart();
    nativeEvent.currentTarget.setPointerCapture(nativeEvent.pointerId);
  };

  const handlePointerMove = (nativeEvent: React.PointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session) return;
    const travel = Math.abs(nativeEvent.clientX - session.startedAt.x) + Math.abs(nativeEvent.clientY - session.startedAt.y);
    if (!session.moved && travel < 5) return;

    if (!session.moved) {
      session.moved = true;
      setDraggingEventId(session.eventId);
      onDragStart();
    }

    if (session.kind === "move") {
      const dayOfWeek = dayAt(nativeEvent.clientX, session.event.dayOfWeek);
      // Preview and commit both come from computePlacement: identical result, and the
      // event can never be pushed past the schedule end.
      const placement = computePlacement(
        minutesAt(nativeEvent.clientY, session.grabOffsetY),
        durationOf(session.event),
        bounds,
      );
      session.latest = { dayOfWeek, startTime: placement.startTime, endTime: placement.endTime };
      onDragPreview(session.eventId, dayOfWeek, placement.startTime);
    } else {
      const endTime = computeResizeEnd(
        minutesAt(nativeEvent.clientY),
        timeToMinutes(session.event.startTime),
        bounds,
      );
      session.latest = { ...session.latest, endTime };
      onResizePreview(session.eventId, endTime);
    }
  };

  const handlePointerUp = (nativeEvent: React.PointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session) return;
    dragRef.current = null;
    setDraggingEventId(null);

    if (!session.moved) {
      onRequestEdit(session.event);
      return;
    }

    if (session.kind === "move") {
      // The committed start is the clamped preview position.
      const placement = computePlacement(
        timeToMinutes(session.latest.startTime),
        durationOf(session.event),
        bounds,
      );
      onDragCommit(session.eventId, session.latest.dayOfWeek, placement.startTime);
    } else {
      onResizeCommit(session.eventId, session.latest.endTime);
    }
    nativeEvent.stopPropagation();
  };

  // Hover "+" affordance — positioned imperatively so hovering never re-renders the grid.
  const handleDayPointerMove = (event: React.PointerEvent<HTMLDivElement>, dayOfWeek: number) => {
    const ghost = ghostRef.current;
    if (!ghost) return;
    const minutes = minutesAt(event.clientY);
    const column = layout.days.find((item) => item.dayOfWeek === dayOfWeek);
    ghost.dataset.day = String(dayOfWeek);
    ghost.dataset.time = minutesToTime(minutes);
    ghost.style.opacity = "1";
    ghost.style.pointerEvents = "auto";
    if (column) {
      ghost.style.left = `${column.x}px`;
      ghost.style.width = `${Math.max(24, column.width)}px`;
    }
    ghost.style.transform = `translateY(${layout.timeToY(minutes)}px)`;
  };

  const hideGhost = () => {
    if (ghostRef.current && document.activeElement !== ghostRef.current) {
      ghostRef.current.style.opacity = "0";
      ghostRef.current.style.pointerEvents = "none";
    }
  };

  const createdFromGhost = () => {
    const ghost = ghostRef.current;
    if (!ghost) return;
    const day = Number(ghost.dataset.day ?? layout.days[0]?.dayOfWeek ?? 0);
    const time = ghost.dataset.time ?? layout.settings.startTime;
    hideGhost();
    // New classes also respect the window so they can never be created out of range.
    onRequestCreate(day, computePlacement(timeToMinutes(time), 60, bounds).startTime);
  };

  const markerColor = (kind: "boundary" | "generated" | "custom") =>
    kind === "custom" ? theme.timeAxis.customColor : kind === "boundary" ? theme.timeAxis.boundaryColor : theme.timeAxis.labelColor;

  return (
    <div
      ref={containerRef}
      className="relative select-none"
      style={{ width: layout.width, height: layout.height, background: theme.canvas.background }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onSelect(null);
      }}
    >
      {/* Right-hand brand panel: logo area on top, trainer list below */}
      <div
        className="absolute rounded-lg"
        style={{
          left: layout.brand.rect.x,
          top: layout.brand.rect.y,
          width: layout.brand.rect.width,
          height: layout.brand.rect.height,
          background: theme.brand.background,
          border: `1px solid ${theme.brand.border}`,
        }}
      >
        <div
          className="absolute flex items-center justify-center overflow-hidden"
          style={{
            left: layout.brand.logoArea.x - layout.brand.rect.x,
            top: layout.brand.logoArea.y - layout.brand.rect.y,
            width: layout.brand.logoArea.width,
            height: layout.brand.logoArea.height,
          }}
        >
          {layout.brand.showLogo && layout.settings.logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={layout.settings.logoDataUrl}
              alt={layout.title}
              className="shrink-0 object-contain"
              style={{
                width: Math.max(20, layout.brand.logoArea.height - theme.brand.logoPadding * 2),
                height: Math.max(20, layout.brand.logoArea.width - theme.brand.logoPadding * 2),
                maxWidth: "none",
                transform: "rotate(-90deg)",
              }}
            />
          ) : layout.brand.showLogo ? (
            <div className="flex flex-col items-center gap-1 text-center" style={{ width: fittedBrand.width }}>
              <span
                className="block w-full overflow-hidden whitespace-nowrap font-black uppercase"
                title={fittedBrand.title.fullText}
                aria-label={fittedBrand.title.fullText}
                style={{ fontSize: theme.brand.titleSize, letterSpacing: 2, color: theme.brand.titleColor }}
              >
                {fittedBrand.title.text}
              </span>
              <span
                className="block w-full overflow-hidden whitespace-nowrap uppercase"
                title={fittedBrand.subtitle.fullText}
                aria-label={fittedBrand.subtitle.fullText}
                style={{ fontSize: theme.brand.subtitleSize, letterSpacing: 1.6, color: theme.brand.subtitleColor }}
              >
                {fittedBrand.subtitle.text}
              </span>
              <span className="mt-1 h-[3px] w-12 rounded" style={{ background: theme.days.accent }} />
            </div>
          ) : null}
        </div>
      </div>

      {/* compact header row: subtitle + effective date (brand mark lives on the right) */}
      <div className="absolute flex items-center justify-between gap-3" style={{ left: layout.header.x, top: layout.header.y, width: layout.header.width }}>
        <p
          className="truncate font-bold uppercase"
          style={{ fontSize: theme.header.subtitleSize + 2, letterSpacing: 2.2, color: theme.header.titleColor }}
        >
          {layout.subtitle}
        </p>
        {layout.metaLabel ? (
          <span className="shrink-0" style={{ fontSize: theme.header.metaSize, color: theme.header.metaColor }}>
            {layout.metaLabel}
          </span>
        ) : null}
      </div>

      {/* time axis */}
      <div className="absolute top-0" style={{ left: layout.timeAxis.x, width: layout.timeAxis.width, height: layout.timeAxis.height }}>
        {layout.markers.map((marker) => (
          <span
            key={`axis-${marker.minutes}-${marker.kind}`}
            className="absolute right-3 -translate-y-1/2 font-medium"
            style={{ top: marker.y, fontSize: theme.timeAxis.labelSize, color: markerColor(marker.kind) }}
          >
            {marker.label}
          </span>
        ))}
      </div>

      {/* day headers */}
      {layout.days.map((day) => (
        <div
          key={`header-${day.dayOfWeek}`}
          className="absolute flex flex-col items-center justify-center"
          style={{ left: day.x, top: layout.dayHeader.y, width: day.width, height: layout.dayHeader.height }}
        >
          <span
            className="font-bold uppercase"
            style={{
              fontSize: theme.days.labelSize,
              letterSpacing: theme.days.letterSpacing,
              color: day.isWeekend ? theme.days.weekendColor : theme.days.color,
            }}
            title={dayName(day.dayOfWeek)}
          >
            {dayName(day.dayOfWeek)}
          </span>
          <span
            className="absolute bottom-0 rounded"
            style={{ left: 6, right: 6, height: 2, background: theme.days.accent, opacity: day.isWeekend ? 0.45 : 0.85 }}
          />
        </div>
      ))}

      {/* grid */}
      <div className="absolute" style={{ left: layout.body.x, top: layout.body.y, width: layout.body.width, height: layout.body.height }}>
        {layout.markers.map((marker) => (
          <div
            key={`line-${marker.minutes}-${marker.kind}`}
            className="absolute left-0 right-0"
            style={{
              top: marker.y - layout.body.y,
              borderTop: `1px ${marker.kind === "custom" ? "dashed" : "solid"} ${
                marker.kind === "custom"
                  ? theme.grid.customLine
                  : marker.kind === "boundary"
                    ? theme.grid.hourStrong
                    : theme.grid.line
              }`,
            }}
          />
        ))}
        <div
          className="absolute -bottom-px left-0 right-0"
          style={{ borderTop: `1px solid ${theme.grid.verticalStrong}` }}
        />
      </div>

      {layout.days.map((day) => (
        <div
          key={`column-${day.dayOfWeek}`}
          className="absolute"
          style={{
            left: day.x,
            top: layout.dayHeader.y,
            width: day.width,
            height: layout.body.y + layout.body.height - layout.dayHeader.y,
            borderLeft: `1px solid ${theme.grid.verticalStrong}`,
            background: day.accent ? "rgba(255,255,255,0.012)" : "transparent",
          }}
        />
      ))}
      <div
        className="absolute"
        style={{
          left: layout.body.x + layout.body.width,
          top: layout.dayHeader.y,
          height: layout.body.y + layout.body.height - layout.dayHeader.y,
          borderLeft: `1px solid ${theme.grid.verticalStrong}`,
        }}
      />

      {/* clickable day slots */}
      {layout.days.map((day) => (
        <div
          key={`slot-${day.dayOfWeek}`}
          className="absolute cursor-copy"
          style={{ left: day.x + 1, top: layout.body.y, width: Math.max(10, day.width - 1), height: layout.body.height }}
          onPointerMove={(event) => handleDayPointerMove(event, day.dayOfWeek)}
          onPointerLeave={(event) => {
            if (event.relatedTarget === ghostRef.current) return;
            hideGhost();
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            if (dragRef.current) return;
            onSelect(null);
          }}
          onClick={(event) => {
            event.stopPropagation();
            const minutes = minutesAt(event.clientY);
            onRequestCreate(day.dayOfWeek, minutesToTime(minutes));
          }}
        />
      ))}

      {/* hover "+" ghost */}
      <button
        type="button"
        ref={ghostRef}
        className="absolute z-20 flex items-center justify-center rounded border border-dashed border-rose-500/60 bg-rose-500/10 text-[10px] font-semibold text-rose-200 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
        style={{ left: layout.days[0]?.x ?? layout.body.x, width: layout.days[0]?.width ?? layout.body.width, height: 18, top: 0, transform: `translateY(${layout.body.y}px)`, opacity: 0, pointerEvents: "none" }}
        onClick={createdFromGhost}
        onFocus={(event) => {
          event.currentTarget.style.opacity = "1";
          event.currentTarget.style.pointerEvents = "auto";
        }}
        onBlur={() => {
          if (ghostRef.current) {
            ghostRef.current.style.opacity = "0";
            ghostRef.current.style.pointerEvents = "none";
          }
        }}
        onPointerLeave={hideGhost}
      >
        {t("editor.addClassHint")}
      </button>

      {/* event cards */}
      {layout.cards.map((card) => {
        const isSelected = card.id === selectedEventId;
        const dimmed = dimUnmatched && !visibleEventIds.has(card.id);
        const hasConflict = conflictEventIds.has(card.id);
        return (
          <div
            key={card.id}
            role="button"
            tabIndex={0}
            aria-label={t("editor.conflictAria", {
              className: card.className,
              trainerName: card.trainerName,
              start: card.event.startTime,
              end: card.event.endTime,
            })}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              beginMove(card.event, event);
            }}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={cancelDrag}
            onLostPointerCapture={cancelDrag}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(card.id);
                onRequestEdit(card.event);
              }
            }}
            className={`group absolute z-10 flex flex-col overflow-hidden text-left transition-opacity ${
              draggingEventId === card.id ? "cursor-grabbing" : "cursor-grab"
            } ${dimmed ? "opacity-25" : "opacity-100"}`}
            style={{
              left: card.x,
              top: card.y,
              width: card.width,
              height: card.height,
              background: card.colors.background,
              border: `1px solid ${isSelected ? "#f8fafc" : card.colors.border}`,
              boxShadow: isSelected ? "0 0 0 2px rgba(248,250,252,0.25)" : undefined,
              borderRadius: theme.cards.radius,
              touchAction: "none",
            }}
          >
            <span className="absolute left-0 top-0 h-full w-[3.5px]" style={{ background: card.colors.accent }} />
            <span className="flex flex-col gap-0.5 pl-2.5 pr-4 pt-1">
              <span
                className="truncate font-bold leading-tight"
                style={{ color: card.colors.title, fontSize: card.density === "full" ? 15 : card.density === "compact" ? 12 : 11 }}
              >
                {card.density === "tiny" ? card.shortName : card.className}
              </span>
              {card.density !== "tiny" && card.height > 30 ? (
                <span className="truncate leading-tight" style={{ color: card.colors.meta, fontSize: 11 }}>
                  {card.timeLabel}
                </span>
              ) : null}
              {card.density === "full" && card.height > 52 ? (
                <span className="truncate leading-tight font-semibold" style={{ color: card.colors.trainer, fontSize: 11 }}>
                  {card.trainerName}
                </span>
              ) : null}
              {card.density === "full" && card.height > 68 && card.roomName ? (
                <span className="truncate leading-tight" style={{ color: card.colors.meta, fontSize: 10, opacity: 0.85 }}>
                  {card.roomName}
                </span>
              ) : null}
              {card.notes && card.height > 96 ? (
                <span className="truncate leading-tight" style={{ color: card.colors.meta, fontSize: 10, opacity: 0.7 }}>
                  {card.notes}
                </span>
              ) : null}
            </span>
            {hasConflict ? (
              <span
                className="absolute right-1 top-1 rounded px-1 text-[10px] font-bold text-amber-950"
                style={{ background: "#fbbf24" }}
                title={t("editor.conflictBadge")}
              >
                !
              </span>
            ) : null}
            <span
              role="separator"
              aria-label={t("editor.resizeHandle")}
              className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize opacity-0 group-hover:opacity-100"
              style={{ background: card.colors.accent }}
              onPointerDown={(event) => beginResize(card.event, event)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={cancelDrag}
              onLostPointerCapture={cancelDrag}
            />
          </div>
        );
      })}

      {/* trainer list inside the right brand panel */}
      {layout.brand.showLegend ? (
        <div
          className="absolute rounded-lg border-t"
          style={{
            left: layout.brand.legendArea.x,
            top: layout.brand.legendArea.y,
            width: layout.brand.legendArea.width,
            height: layout.brand.legendArea.height,
            borderColor: theme.brand.border,
          }}
        >
          <div
            className="absolute left-4 text-[10px] font-bold tracking-[0.16em]"
            style={{ top: 12, color: theme.brand.legendTitle }}
          >
            {t("legend.title")}
          </div>
          {layout.brand.items.map((item) => (
            <button
              key={item.trainerId}
              type="button"
              onClick={() => onTrainerFilter?.(item.trainerId)}
              title={onTrainerFilter ? t("legend.filterHint", { name: item.name }) : item.name}
              className="absolute flex h-7 items-center gap-2.5 pr-4 text-left"
              style={{ left: 16, top: item.y - layout.brand.legendArea.y - 18, width: layout.brand.legendArea.width - 16 }}
            >
              <span className="h-[10px] w-[10px] shrink-0 rounded-sm ring-1 ring-white/10" style={{ background: item.color }} />
              <span
                className="truncate font-semibold text-slate-100"
                style={{ fontSize: theme.brand.itemSize }}
              >
                {item.name}
              </span>
              <span className="ml-auto tabular-nums text-[10px] text-slate-500">{item.count > 0 ? item.count : "—"}</span>
            </button>
          ))}
          <div
            className="absolute bottom-3 left-4 text-[10px]"
            style={{ color: theme.brand.muted }}
          >
            {t("legend.summary", { trainers: layout.brand.items.length, classes: layout.columns.length })}
          </div>
        </div>
      ) : null}

      {layout.bottomLegend ? (
        <div
          className="absolute flex flex-wrap items-center gap-x-5 rounded-lg px-3 py-2"
          style={{
            left: layout.bottomLegend.rect.x,
            top: layout.bottomLegend.rect.y,
            width: layout.bottomLegend.rect.width,
            background: theme.brand.background,
            border: `1px solid ${theme.brand.border}`,
          }}
        >
          {layout.brand.items.map((item) => (
            <span key={item.trainerId} className="flex items-center gap-2">
              <span className="h-[9px] w-[9px] rounded-sm" style={{ background: item.color }} />
              <span className="text-[13px] font-semibold text-slate-100">{item.name}</span>
              <span className="text-[10px] text-slate-500">{item.count > 0 ? item.count : "—"}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
