import type { ClassType, Room, ScheduleEvent, ScheduleSettings, Trainer } from "@/lib/domain/types";
import { cardColors, type CardColors } from "@/lib/theme/color";
import type { ScheduleTheme } from "@/lib/theme/risen-team-dark";
import { compileEvents, type CompiledEvent } from "@/lib/schedule/overlap";
import { buildMarkers, timeToMinutes, type Marker } from "@/lib/schedule/time";
import { DEFAULT_LOGO_DATA_URL } from "@/lib/branding/default-logo";

/**
 * Schedule layout engine.
 *
 * Pure function: (data + settings + theme + target box) → geometry.
 * Both the interactive editor (absolute positioned DOM) and the SVG export
 * renderer consume this model, so preview/export can never drift from the
 * editor. Nothing here knows about React.
 *
 * Composition (matching the Risen Team reference):
 *   LEFT   time axis
 *   CENTER weekly day columns
 *   RIGHT  brand panel: logo on top, trainer legend directly below
 */

export interface DayColumn {
  dayOfWeek: number;
  label: string;
  shortLabel: string;
  isWeekend: boolean;
  x: number;
  width: number;
  accent: boolean;
}

export interface LayoutMarker extends Marker {
  y: number;
}

export type CardDensity = "full" | "compact" | "tiny";

export interface LayoutCard {
  id: string;
  event: ScheduleEvent;
  x: number;
  y: number;
  width: number;
  height: number;
  lane: number;
  lanes: number;
  dayOfWeek: number;
  density: CardDensity;
  colors: CardColors;
  className: string;
  shortName: string;
  trainerName: string;
  trainerColor: string;
  roomName: string | null;
  timeLabel: string;
  notes: string | null;
}

export interface LegendItem {
  trainerId: string;
  name: string;
  color: string;
  initials: string;
  count: number;
}

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrandPanel {
  rect: LayoutRect;
  logoArea: LayoutRect;
  legendArea: LayoutRect;
  legendTitleY: number;
  items: (LegendItem & { y: number })[];
  summaryY: number;
  showLogo: boolean;
  showLegend: boolean;
}

export interface ScheduleLayout {
  width: number;
  height: number;
  theme: ScheduleTheme;
  settings: ScheduleSettings;
  labels: LayoutLabels;
  /** Compact header row above the grid (never a large standalone title block). */
  header: LayoutRect;
  title: string;
  subtitle: string;
  metaLabel: string;
  timeAxis: LayoutRect;
  dayHeader: { y: number; height: number };
  body: LayoutRect;
  days: DayColumn[];
  markers: LayoutMarker[];
  cards: LayoutCard[];
  /** Right-hand brand panel: logo (top) + trainer legend (below). */
  brand: BrandPanel;
  /** Legend drawn under the grid when the user chooses the "bottom" position. */
  bottomLegend: { rect: LayoutRect; columns: number } | null;
  columns: CompiledEvent[];
  pxPerMinute: number;
  startMinutes: number;
  endMinutes: number;
  timeToY: (minutes: number) => number;
  yToMinutes: (y: number) => number;
}

export interface LayoutLabels {
  /** Weekday label for a day index (0 = Monday) in the active interface language. */
  dayName: (dayOfWeek: number) => string;
  /** Short weekday label (e.g. "MON" / "ПН"). */
  dayShort: (dayOfWeek: number) => string;
  legendTitle: string;
  legendSummary: (trainers: number, classes: number) => string;
}

const DEFAULT_LABELS: LayoutLabels = {
  dayName: (dayOfWeek) => ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][dayOfWeek] ?? "?",
  dayShort: (dayOfWeek) => ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"][dayOfWeek] ?? "?",
  legendTitle: "TRAINERS",
  legendSummary: (trainers, classes) => `${trainers} trainers · ${classes} classes weekly`,
};

export interface LayoutInput {
  settings: ScheduleSettings;
  events: ScheduleEvent[];
  trainers: Trainer[];
  classTypes: ClassType[];
  rooms: Room[];
  theme: ScheduleTheme;
  width: number;
  height: number;
  /** Optional label shown in the header (e.g. "З 1 вересня"). */
  metaLabel?: string;
  /** Localised text used by the renderer (defaults to English). */
  labels?: LayoutLabels;
}

export function buildScheduleLayout(input: LayoutInput): ScheduleLayout {
  const { settings, theme } = input;
  const labels = input.labels ?? DEFAULT_LABELS;
  const trainersById = new Map(input.trainers.map((trainer) => [trainer.id, trainer]));
  const classTypesById = new Map(input.classTypes.map((classType) => [classType.id, classType]));
  const roomsById = new Map(input.rooms.map((room) => [room.id, room]));

  const width = Math.max(560, Math.round(input.width));
  const height = Math.max(360, Math.round(input.height));
  const padding = theme.canvas.padding;

  const brandWidth = theme.brand.width;
  const contentLeft = padding;
  const brandRect: LayoutRect = {
    x: width - padding - brandWidth,
    y: padding,
    width: brandWidth,
    height: height - padding * 2,
  };

  const header: LayoutRect = {
    x: contentLeft,
    y: padding,
    width: brandRect.x - theme.brand.gap - contentLeft,
    height: theme.header.height,
  };

  const timeAxis: LayoutRect = {
    x: contentLeft,
    y: 0,
    width: theme.timeAxis.width,
    height,
  };
  const daysLeft = timeAxis.x + timeAxis.width;
  const daysRight = brandRect.x - theme.brand.gap;
  const visibleDays = [...settings.visibleDays].sort((a, b) => a - b);
  const dayCount = Math.max(1, visibleDays.length);
  const dayWidth = Math.max(40, (daysRight - daysLeft) / dayCount);

  const dayHeaderY = header.y + header.height + 4;
  const startMinutes = timeToMinutes(settings.startTime);
  const endMinutes = timeToMinutes(settings.endTime);
  const windowMinutes = Math.max(60, endMinutes - startMinutes);

  const columns = compileEvents(input.events, visibleDays);
  const legendItems = buildLegendItems(input.trainers, columns);
  const showLegendRight = settings.showTrainerLegend && settings.legendPosition === "right";
  const showLegendBottom = settings.showTrainerLegend && settings.legendPosition === "bottom";

  const legendRows = Math.max(1, Math.ceil(legendItems.length / 2)) * theme.brand.itemHeight;
  const bottomLegendRows = showLegendBottom ? Math.max(1, Math.ceil(legendItems.length / 6)) : 0;
  const bottomLegendHeight = showLegendBottom ? bottomLegendRows * (theme.brand.itemHeight - 4) + 26 : 0;

  const bodyTop = dayHeaderY + theme.days.headerHeight;
  const bodyBottom = height - padding - bottomLegendHeight;
  const bodyHeight = Math.max(140, bodyBottom - bodyTop);
  const pxPerMinute = bodyHeight / windowMinutes;

  const days: DayColumn[] = visibleDays.map((dayOfWeek, index) => ({
    dayOfWeek,
    label: labels.dayName(dayOfWeek),
    shortLabel: labels.dayShort(dayOfWeek),
    isWeekend: dayOfWeek >= 5,
    x: daysLeft + index * dayWidth,
    width: dayWidth,
    accent: index % 2 === 1,
  }));

  const markers: LayoutMarker[] = buildMarkers(settings).map((marker) => ({
    ...marker,
    y: bodyTop + (marker.minutes - startMinutes) * pxPerMinute,
  }));

  const body: LayoutRect = { x: daysLeft, y: bodyTop, width: daysRight - daysLeft, height: bodyHeight };
  const timeToY = (minutes: number) => bodyTop + (minutes - startMinutes) * pxPerMinute;

  const cards: LayoutCard[] = columns.map((compiled) => {
    const event = compiled.event;
    const trainer = trainersById.get(event.trainerId);
    const classType = classTypesById.get(event.classTypeId);
    const room = event.roomId ? roomsById.get(event.roomId) : undefined;
    const day = days.find((column) => column.dayOfWeek === event.dayOfWeek) ?? days[0];
    const laneWidth = day.width / compiled.lanes;
    const cardHeight = Math.max(16, compiled.durationMinutes * pxPerMinute - theme.cards.gap);
    const cardWidth = laneWidth - theme.cards.gap;
    // Trainer colour is an identity signal in every theme and export format.
    const colors = cardColors(trainer?.color ?? "#94a3b8", {
      card: theme.cards.cardSurface,
      text: theme.cards.cardText,
      muted: theme.cards.cardMuted,
    });

    const density: CardDensity =
      cardHeight < 34 || cardWidth < 78 ? "tiny" : cardHeight < 54 || cardWidth < 120 ? "compact" : "full";

    return {
      id: event.id,
      event,
      x: day.x + compiled.lane * laneWidth + theme.cards.gap / 2,
      y: timeToY(compiled.startMinutes) + theme.cards.gap / 2,
      width: cardWidth,
      height: cardHeight,
      lane: compiled.lane,
      lanes: compiled.lanes,
      dayOfWeek: event.dayOfWeek,
      density,
      colors,
      className: classType?.name ?? "Class",
      shortName: classType?.shortName ?? classType?.name ?? "Class",
      trainerName: trainer?.name ?? "—",
      trainerColor: trainer?.color ?? "#94a3b8",
      roomName: room?.name ?? null,
      timeLabel: `${event.startTime}–${event.endTime}`,
      notes: event.notes ?? null,
    };
  });

  const legendPadding = 16;
  const legendTitleOffset = 18;
  const firstItemOffset = 42;
  const legendSummarySpace = 24;
  const minimumLogoArea = Math.max(120, Math.round(brandRect.height * 0.28));
  const maxLegendHeight = Math.max(72, brandRect.height - minimumLogoArea - theme.brand.gap);
  const estimatedRows = showLegendRight ? Math.max(1, legendItems.length) : 0;
  const desiredLegendHeight = showLegendRight
    ? legendPadding * 2 + legendTitleOffset + estimatedRows * theme.brand.itemHeight + legendSummarySpace
    : 0;
  const legendHeight = showLegendRight ? Math.min(maxLegendHeight, Math.max(96, desiredLegendHeight)) : 0;
  const legendArea: LayoutRect = {
    x: brandRect.x,
    y: brandRect.y + brandRect.height - legendHeight,
    width: brandRect.width,
    height: legendHeight,
  };
  const logoArea: LayoutRect = {
    x: brandRect.x,
    y: brandRect.y,
    width: brandRect.width,
    height: Math.max(0, legendArea.y - brandRect.y - (showLegendRight ? theme.brand.gap : 0)),
  };

  const legendTitleY = legendArea.y + legendTitleOffset;
  const firstItemY = legendArea.y + firstItemOffset;
  const summaryY = legendArea.y + legendArea.height - 13;
  const maxItems = showLegendRight
    ? Math.max(1, Math.floor(Math.max(0, summaryY - firstItemY - 10) / theme.brand.itemHeight) + 1)
    : legendItems.length;
  const items = legendItems.slice(0, maxItems).map((item, index) => ({ ...item, y: firstItemY + index * theme.brand.itemHeight }));

  const brand: BrandPanel = {
    rect: brandRect,
    logoArea,
    legendArea,
    legendTitleY,
    items,
    summaryY,
    showLogo: settings.showLogo,
    showLegend: showLegendRight,
  };

  return {
    width,
    height,
    theme,
    // A rendering fallback keeps built-in branding out of user databases and
    // portable backups; exports embed the artwork without network requests.
    settings: { ...settings, logoDataUrl: settings.logoDataUrl || DEFAULT_LOGO_DATA_URL },
    labels,
    header,
    title: settings.scheduleTitle,
    subtitle: settings.scheduleSubtitle,
    metaLabel: input.metaLabel ?? "",
    timeAxis,
    dayHeader: { y: dayHeaderY, height: theme.days.headerHeight },
    body,
    days,
    markers,
    cards,
    brand,
    bottomLegend: showLegendBottom
      ? { rect: { x: contentLeft, y: bodyBottom + 8, width: daysRight - contentLeft, height: bottomLegendHeight - 8 }, columns: 6 }
      : null,
    columns,
    pxPerMinute,
    startMinutes,
    endMinutes,
    timeToY,
    yToMinutes: (y) => startMinutes + (y - bodyTop) / pxPerMinute,
  };
}

/**
 * Trainer legend ordering: trainers that actually teach this week come first
 * (busiest first), then the remaining active trainers by their manual order.
 * Inactive trainers only appear when they are still referenced by the schedule.
 */
export function buildLegendItems(columns: CompiledEvent[], trainers: Trainer[]): LegendItem[];
export function buildLegendItems(trainers: Trainer[], columns: CompiledEvent[]): LegendItem[];
export function buildLegendItems(first: Trainer[] | CompiledEvent[], second: CompiledEvent[] | Trainer[]): LegendItem[] {
  const trainers = (Array.isArray(first) && first.length > 0 && "color" in (first[0] as object) ? first : second) as Trainer[];
  const columns = (Array.isArray(first) && first.length > 0 && "color" in (first[0] as object) ? second : first) as CompiledEvent[];

  const counts = new Map<string, number>();
  for (const column of columns) {
    counts.set(column.event.trainerId, (counts.get(column.event.trainerId) ?? 0) + 1);
  }

  return [...trainers]
    .filter((trainer) => trainer.active || (counts.get(trainer.id) ?? 0) > 0)
    .sort((a, b) => {
      const aCount = counts.get(a.id) ?? 0;
      const bCount = counts.get(b.id) ?? 0;
      const aUsed = aCount > 0 ? 0 : 1;
      const bUsed = bCount > 0 ? 0 : 1;
      if (aUsed !== bUsed) return aUsed - bUsed;
      if (aCount !== bCount) return bCount - aCount;
      return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
    })
    .map((trainer) => ({
      trainerId: trainer.id,
      name: trainer.name,
      color: trainer.color,
      initials: initialsOf(trainer),
      count: counts.get(trainer.id) ?? 0,
    }));
}

export function initialsOf(trainer: Trainer): string {
  if (trainer.initials) return trainer.initials;
  return trainer.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** Word-wrapping helper used by the SVG renderer (SVG has no auto layout). */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length + 1) {
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(1, maxChars - 1))}…`;
  }
  return lines;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}
