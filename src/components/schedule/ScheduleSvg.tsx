import { useId, type Ref } from "react";
import type { ScheduleLayout } from "@/lib/schedule/layout";
import { truncate, wrapText } from "@/lib/schedule/layout";
import { brandLabels } from "@/lib/schedule/brand-labels";

/**
 * Dedicated export renderer.
 *
 * Everything is expressed with SVG presentation attributes (no CSS classes, no
 * foreignObject), which keeps the same markup usable for:
 *   • on-screen preview
 *   • PNG rasterisation at 1x/2x/3x/4x
 *   • vector PDF export through jsPDF + svg2pdf.js
 */

interface ScheduleSvgProps {
  layout: ScheduleLayout;
  svgRef?: Ref<SVGSVGElement>;
  /** Extra text shown in the header (effective date, page info…). */
  metaLabel?: string;
  titleOverride?: string;
  subtitleOverride?: string;
  /**
   * Scale the drawing to the container width (on-screen preview only).
   * Exports always render at the layout's intrinsic size.
   */
  fitWidth?: boolean;
}

export function ScheduleSvg({ layout, svgRef, metaLabel, titleOverride, subtitleOverride, fitWidth = false }: ScheduleSvgProps) {
  const { theme } = layout;
  const title = titleOverride ?? layout.title;
  const subtitle = subtitleOverride ?? layout.subtitle;
  const meta = metaLabel ?? layout.metaLabel;
  const font = theme.fonts.family;
  const fittedBrand = brandLabels(layout);
  const brandClipId = `brand-label-${useId().replace(/:/g, "")}`;

  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      width={fitWidth ? "100%" : layout.width}
      height={fitWidth ? undefined : layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={`${title} weekly training schedule`}
      style={fitWidth ? { display: "block", width: "100%", height: "auto" } : { display: "block" }}
    >
      <title>{`${title} — ${subtitle}`}</title>
      <rect
        x={0}
        y={0}
        width={layout.width}
        height={layout.height}
        rx={theme.canvas.radius}
        fill={theme.canvas.background}
      />
      <rect
        x={0.5}
        y={0.5}
        width={layout.width - 1}
        height={layout.height - 1}
        rx={theme.canvas.radius}
        fill="none"
        stroke={theme.canvas.border}
        strokeWidth={1}
      />

      {/* Right-hand brand panel: logo area (top). Trainer list is rendered in the
          same panel further below so the composition matches the reference. */}
      <g>
        <rect
          x={layout.brand.rect.x}
          y={layout.brand.rect.y}
          width={layout.brand.rect.width}
          height={layout.brand.rect.height}
          rx={8}
          fill={theme.brand.background}
          stroke={theme.brand.border}
          strokeWidth={1}
        />
        {layout.brand.showLogo && layout.settings.logoDataUrl ? (
          <image
            href={layout.settings.logoDataUrl}
            x={layout.brand.logoArea.x + layout.brand.logoArea.width / 2 - Math.max(20, layout.brand.logoArea.height - theme.brand.logoPadding * 2) / 2}
            y={layout.brand.logoArea.y + layout.brand.logoArea.height / 2 - Math.max(20, layout.brand.logoArea.width - theme.brand.logoPadding * 2) / 2}
            width={Math.max(20, layout.brand.logoArea.height - theme.brand.logoPadding * 2)}
            height={Math.max(20, layout.brand.logoArea.width - theme.brand.logoPadding * 2)}
            preserveAspectRatio="xMidYMid meet"
            transform={`rotate(-90 ${layout.brand.logoArea.x + layout.brand.logoArea.width / 2} ${layout.brand.logoArea.y + layout.brand.logoArea.height / 2})`}
          />
        ) : layout.brand.showLogo ? (
          <g>
            <defs><clipPath id={brandClipId}><rect
              x={layout.brand.logoArea.x + theme.brand.logoPadding}
              y={layout.brand.logoArea.y}
              width={fittedBrand.width}
              height={layout.brand.logoArea.height}
            /></clipPath></defs>
            <text
              x={layout.brand.logoArea.x + layout.brand.logoArea.width / 2}
              y={layout.brand.logoArea.y + layout.brand.logoArea.height / 2 - 4}
              fill={theme.brand.titleColor}
              fontSize={theme.brand.titleSize}
              fontFamily={font}
              fontWeight={800}
              letterSpacing={2}
              textAnchor="middle"
              clipPath={`url(#${brandClipId})`}
              aria-label={fittedBrand.title.fullText}
            >
              <title>{fittedBrand.title.fullText}</title>
              {fittedBrand.title.text}
            </text>
            <text
              x={layout.brand.logoArea.x + layout.brand.logoArea.width / 2}
              y={layout.brand.logoArea.y + layout.brand.logoArea.height / 2 + 14}
              fill={theme.brand.subtitleColor}
              fontSize={theme.brand.subtitleSize}
              fontFamily={font}
              letterSpacing={1.6}
              textAnchor="middle"
              clipPath={`url(#${brandClipId})`}
              aria-label={fittedBrand.subtitle.fullText}
            >
              <title>{fittedBrand.subtitle.fullText}</title>
              {fittedBrand.subtitle.text}
            </text>
            <rect
              x={layout.brand.logoArea.x + layout.brand.logoArea.width / 2 - 26}
              y={layout.brand.logoArea.y + layout.brand.logoArea.height / 2 + 26}
              width={52}
              height={3}
              rx={1.5}
              fill={theme.days.accent}
            />
          </g>
        ) : null}
        <line
          x1={layout.brand.rect.x + 1}
          y1={layout.brand.legendArea.y}
          x2={layout.brand.rect.x + layout.brand.rect.width - 1}
          y2={layout.brand.legendArea.y}
          stroke={theme.brand.border}
          strokeWidth={1}
        />
      </g>

      {/* Compact header row: subtitle + effective date only. The brand mark lives in
          the right-hand panel, so the grid keeps the maximum height. */}
      <g>
        <text
          x={layout.header.x}
          y={layout.header.y + theme.header.subtitleSize + 12}
          fill={theme.header.titleColor}
          fontSize={theme.header.subtitleSize + 2}
          fontFamily={font}
          fontWeight={700}
          letterSpacing={2.2}
        >
          {subtitle.toUpperCase()}
        </text>
        {meta ? (
          <text
            x={layout.header.x + layout.header.width}
            y={layout.header.y + theme.header.subtitleSize + 12}
            fill={theme.header.metaColor}
            fontSize={theme.header.metaSize}
            fontFamily={font}
            textAnchor="end"
          >
            {meta}
          </text>
        ) : null}
      </g>

      {layout.days.map((day) => (
        <g key={`day-bg-${day.dayOfWeek}`}>
          <rect
            x={day.x}
            y={layout.body.y}
            width={day.width}
            height={layout.body.height}
            fill={day.accent ? "#0c0e14" : "#0a0c11"}
          />
        </g>
      ))}

      {/* Vertical column separators */}
      {layout.days.map((day) => (
        <line
          key={`day-line-${day.dayOfWeek}`}
          x1={day.x}
          y1={layout.dayHeader.y}
          x2={day.x}
          y2={layout.body.y + layout.body.height}
          stroke={theme.grid.verticalStrong}
          strokeWidth={1}
        />
      ))}
      <line
        x1={layout.days[layout.days.length - 1]?.x + (layout.days[layout.days.length - 1]?.width ?? 0)}
        y1={layout.dayHeader.y}
        x2={layout.days[layout.days.length - 1]?.x + (layout.days[layout.days.length - 1]?.width ?? 0)}
        y2={layout.body.y + layout.body.height}
        stroke={theme.grid.verticalStrong}
        strokeWidth={1}
      />

      {/* Time markers */}
      {layout.markers.map((marker) => (
        <g key={`marker-${marker.minutes}-${marker.kind}`}>
          <line
            x1={layout.timeAxis.x + layout.timeAxis.width - 6}
            y1={marker.y}
            x2={layout.body.x + layout.body.width}
            y2={marker.y}
            stroke={
              marker.kind === "custom"
                ? theme.grid.customLine
                : marker.kind === "boundary"
                  ? theme.grid.hourStrong
                  : theme.grid.line
            }
            strokeWidth={marker.kind === "custom" ? 1.2 : 1}
            strokeDasharray={marker.kind === "custom" ? "5 4" : undefined}
          />
          <text
            x={layout.timeAxis.x + layout.timeAxis.width - 12}
            y={marker.y + 4}
            fill={
              marker.kind === "custom"
                ? theme.timeAxis.customColor
                : marker.kind === "boundary"
                  ? theme.timeAxis.boundaryColor
                  : theme.timeAxis.labelColor
            }
            fontSize={theme.timeAxis.labelSize}
            fontFamily={font}
            fontWeight={marker.kind === "boundary" ? 700 : 500}
            textAnchor="end"
          >
            {marker.label}
          </text>
        </g>
      ))}

      {/* Day headers */}
      <line
        x1={layout.timeAxis.x}
        y1={layout.dayHeader.y + layout.dayHeader.height}
        x2={layout.body.x + layout.body.width}
        y2={layout.dayHeader.y + layout.dayHeader.height}
        stroke={theme.days.divider}
        strokeWidth={1}
      />
      {layout.days.map((day) => (
        <g key={`day-header-${day.dayOfWeek}`}>
          <text
            x={day.x + day.width / 2}
            y={layout.dayHeader.y + layout.dayHeader.height / 2 + 5}
            fill={day.isWeekend ? theme.days.weekendColor : theme.days.color}
            fontSize={theme.days.labelSize}
            fontFamily={font}
            fontWeight={700}
            letterSpacing={theme.days.letterSpacing}
            textAnchor="middle"
          >
            {day.label.toUpperCase()}
          </text>
          <rect
            x={day.x + 6}
            y={layout.dayHeader.y + layout.dayHeader.height - 3}
            width={Math.max(0, day.width - 12)}
            height={2}
            rx={1}
            fill={theme.days.accent}
            opacity={day.isWeekend ? 0.45 : 0.85}
          />
        </g>
      ))}

      {/* Event cards */}
      {layout.cards.map((card) => (
        <SvgCard key={card.id} card={card} font={font} radius={theme.cards.radius} paddingX={theme.cards.paddingX} />
      ))}

      {/* Trainer list — directly below the logo inside the right panel */}
      {layout.brand.showLegend ? renderBrandLegend(layout, font) : null}
      {layout.bottomLegend ? renderBottomLegend(layout, font) : null}
    </svg>
  );
}

function SvgCard({
  card,
  font,
  radius,
  paddingX,
}: {
  card: ScheduleLayout["cards"][number];
  font: string;
  radius: number;
  paddingX: number;
}) {
  const titleSize = card.density === "full" ? 15 : card.density === "compact" ? 12 : 11;
  const metaSize = card.density === "full" ? 11 : 10;
  const textX = card.x + paddingX + 4;
  const maxChars = Math.max(3, Math.floor((card.width - paddingX * 2 - 8) / (titleSize * 0.58)));

  const titleLines =
    card.height > 74 && card.density === "full"
      ? wrapText(card.className, maxChars, 2)
      : [truncate(card.className, maxChars)];

  const showTime = card.density !== "tiny" && card.height > 30;
  const showTrainer = card.density === "full" && card.height > 52;
  const showRoom = card.density === "full" && card.height > 68 && Boolean(card.roomName);

  let cursorY = card.y + titleSize + (card.density === "tiny" ? 3 : 5);

  return (
    <g>
      <rect
        x={card.x}
        y={card.y}
        width={card.width}
        height={card.height}
        rx={radius}
        fill={card.colors.background}
        stroke={card.colors.border}
        strokeWidth={1}
      />
      <rect x={card.x} y={card.y} width={3.5} height={card.height} rx={1.75} fill={card.colors.accent} />
      {titleLines.map((line, index) => (
        <text
          key={`title-${index}`}
          x={textX}
          y={cursorY + index * (titleSize + 2)}
          fill={card.colors.title}
          fontSize={titleSize}
          fontFamily={font}
          fontWeight={700}
          letterSpacing={0.2}
        >
          {line}
        </text>
      ))}
      {(() => {
        const element: React.ReactElement[] = [];
        let y = cursorY + (titleLines.length - 1) * (titleSize + 2);
        if (showTime) {
          y += metaSize + 3;
          element.push(
            <text key="time" x={textX} y={y} fill={card.colors.meta} fontSize={metaSize} fontFamily={font}>
              {card.timeLabel}
            </text>,
          );
        }
        if (showTrainer) {
          y += metaSize + 2;
          element.push(
            <text
              key="trainer"
              x={textX}
              y={y}
              fill={card.colors.trainer}
              fontSize={metaSize}
              fontFamily={font}
              fontWeight={600}
            >
              {truncate(card.trainerName, maxChars)}
            </text>,
          );
        }
        if (showRoom && card.roomName) {
          y += metaSize + 2;
          element.push(
            <text
              key="room"
              x={textX}
              y={y}
              fill={card.colors.meta}
              fontSize={metaSize - 1}
              fontFamily={font}
              opacity={0.85}
            >
              {truncate(card.roomName, maxChars)}
            </text>,
          );
        }
        if (card.notes && card.height > 96) {
          y += metaSize + 2;
          element.push(
            <text key="notes" x={textX} y={y} fill={card.colors.meta} fontSize={metaSize - 1} fontFamily={font} opacity={0.7}>
              {truncate(card.notes, maxChars * 2)}
            </text>,
          );
        }
        return element;
      })()}
    </g>
  );
}

function renderBrandLegend(layout: ScheduleLayout, font: string) {
  const { theme, brand } = layout;
  const { legendArea } = brand;
  return (
    <g>
      <text
        x={legendArea.x + 16}
        y={brand.legendTitleY}
        fill={theme.brand.legendTitle}
        fontSize={theme.brand.legendTitleSize}
        fontFamily={font}
        letterSpacing={1.6}
        fontWeight={700}
      >
        {layout.labels.legendTitle}
      </text>
      {brand.items.map((item) => (
        <g key={item.trainerId}>
          <rect
            x={legendArea.x + 16}
            y={item.y - 9}
            width={Math.max(theme.brand.swatch, 10)}
            height={Math.max(theme.brand.swatch, 10)}
            rx={2}
            fill={item.color}
          />
          <text
            x={legendArea.x + 33}
            y={item.y}
            fill="#f2f4f9"
            fontSize={theme.brand.itemSize}
            fontFamily={font}
            fontWeight={600}
          >
            {truncate(item.name, Math.floor((legendArea.width - 64) / (theme.brand.itemSize * 0.6)))}
          </text>
          <text
            x={legendArea.x + legendArea.width - 16}
            y={item.y}
            fill={theme.brand.muted}
            fontSize={theme.brand.itemSize - 2}
            fontFamily={font}
            textAnchor="end"
          >
            {item.count > 0 ? `${item.count}` : "—"}
          </text>
        </g>
      ))}
      <text
        x={legendArea.x + 16}
        y={brand.summaryY}
        fill={theme.brand.muted}
        fontSize={theme.brand.legendTitleSize}
        fontFamily={font}
      >
        {layout.labels.legendSummary(brand.items.length, layout.columns.length)}
      </text>
    </g>
  );
}

function renderBottomLegend(layout: ScheduleLayout, font: string) {
  const legend = layout.bottomLegend;
  if (!legend) return null;
  const { theme } = layout;
  const cellWidth = legend.rect.width / legend.columns;
  return (
    <g>
      <rect
        x={legend.rect.x}
        y={legend.rect.y}
        width={legend.rect.width}
        height={legend.rect.height}
        rx={8}
        fill={theme.brand.background}
        stroke={theme.brand.border}
        strokeWidth={1}
      />
      {layout.brand.items.map((item, index) => {
        const column = index % legend.columns;
        const row = Math.floor(index / legend.columns);
        const x = legend.rect.x + 16 + column * cellWidth;
        const y = legend.rect.y + 20 + row * (theme.brand.itemHeight - 4);
        return (
          <g key={item.trainerId}>
            <rect x={x} y={y - theme.brand.swatch + 1} width={theme.brand.swatch} height={theme.brand.swatch} rx={2} fill={item.color} />
            <text x={x + 16} y={y} fill="#f2f4f9" fontSize={theme.brand.itemSize} fontFamily={font} fontWeight={600}>
              {truncate(item.name, 18)}
            </text>
            <text
              x={x + cellWidth - 24}
              y={y}
              fill={theme.brand.muted}
              fontSize={theme.brand.itemSize - 2}
              fontFamily={font}
              textAnchor="end"
            >
              {item.count > 0 ? `${item.count}` : "—"}
            </text>
          </g>
        );
      })}
    </g>
  );
}
