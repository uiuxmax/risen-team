"use client";

import { useMemo, useRef, useState } from "react";
import { useWorkspace } from "@/components/app/WorkspaceProvider";
import { ScheduleSvg } from "@/components/schedule/ScheduleSvg";
import { Button, Chip, EmptyState, Field, Panel, SelectInput, TextInput } from "@/components/ui/controls";
import { buildScheduleLayout } from "@/lib/schedule/layout";
import { getTheme } from "@/lib/theme/risen-team-dark";
import { computeExportDimensions, formatBytes, type ExportOrientation, type ExportPaper, type ExportScale } from "@/lib/export/dimensions";
import { exportPdfFile, exportPngFile, exportSvgFile, PDF_FONT_NAME } from "@/lib/export/client-export";
import { useI18n } from "@/components/app/LanguageProvider";

export function ExportStudio() {
  const { workspace } = useWorkspace();
  return <HallExportStudio key={`${workspace?.workspaceId ?? "legacy"}:${workspace?.hallId ?? workspace?.activeScheduleId ?? "empty"}`} />;
}

function HallExportStudio() {
  const { t, dayName } = useI18n();
  const { settings, events, trainers, classTypes, rooms, dispatch, toast, schedule } = useWorkspace();
  const svgRef = useRef<SVGSVGElement>(null);
  const pdfSvgRef = useRef<SVGSVGElement>(null);

  const [paper, setPaper] = useState<ExportPaper>(settings.exportPaper);
  const [orientation, setOrientation] = useState<ExportOrientation>(settings.exportOrientation);
  const [scale, setScale] = useState<ExportScale>(settings.exportScale);
  const [customWidth, setCustomWidth] = useState(settings.customExportWidth);
  const [customHeight, setCustomHeight] = useState(settings.customExportHeight);
  const [busy, setBusy] = useState<string | null>(null);

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
  const dimensions = useMemo(
    () => computeExportDimensions({ paper, orientation, scale, customWidth, customHeight }),
    [paper, orientation, scale, customWidth, customHeight],
  );

  // PDF output uses a theme whose font family is the font embedded in the document,
  // which keeps Ukrainian text selectable, searchable and sharp.
  const pdfTheme = useMemo(
    () => ({ ...theme, fonts: { family: PDF_FONT_NAME, display: PDF_FONT_NAME } }),
    [theme],
  );

  const layout = useMemo(
    () =>
      buildScheduleLayout({
        settings,
        events,
        trainers,
        classTypes,
        rooms,
        theme,
        width: dimensions.width,
        height: dimensions.height,
        metaLabel: settings.effectiveDate ?? undefined,
        labels,
      }),
    [settings, events, trainers, classTypes, rooms, theme, dimensions.width, dimensions.height, labels],
  );

  const pdfLayout = useMemo(
    () =>
      buildScheduleLayout({
        settings,
        events,
        trainers,
        classTypes,
        rooms,
        theme: pdfTheme,
        width: dimensions.width,
        height: dimensions.height,
        metaLabel: settings.effectiveDate ?? undefined,
        labels,
      }),
    [settings, events, trainers, classTypes, rooms, pdfTheme, dimensions.width, dimensions.height, labels],
  );

  const fileBase = `${settings.scheduleTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "schedule"}-${paper === "original" ? "sheet" : paper}${orientation === "portrait" ? "-portrait" : ""}`;

  const run = async (kind: "png" | "pdf" | "svg") => {
    const svg = svgRef.current;
    if (!svg) {
      toast(t("toast.exportNotReady"), "error");
      return;
    }
    setBusy(kind);
    try {
      if (kind === "png") {
        const result = await exportPngFile(svg, dimensions, `${fileBase}-${scale}x.png`, theme.canvas.background);
        toast(
          t("toast.pngDone", {
            width: dimensions.pixelWidth,
            height: dimensions.pixelHeight,
            size: formatBytes(result.bytes),
          }),
          "success",
        );
      } else if (kind === "svg") {
        await exportSvgFile(svg, dimensions, `${fileBase}.svg`);
        toast(t("toast.svgDone"), "success");
      } else {
        const pdfSvg = pdfSvgRef.current ?? svg;
        const result = await exportPdfFile(pdfSvg, dimensions, `${fileBase}.pdf`, theme.canvas.background);
        toast(
          t("toast.pdfDone", {
            size: formatBytes(result.bytes),
            mode: result.vector ? t("toast.pdfVector") : t("toast.pdfRaster"),
          }),
          "success",
        );
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : t("toast.exportFailed"), "error");
    } finally {
      setBusy(null);
    }
  };

  if (!schedule) return <EmptyState title={t("halls.empty")} hint={t("halls.emptyHint")} />;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_1fr]">
      <div className="no-print flex flex-col gap-4">
        <Panel title={`${t("export.title")} · ${schedule.name}`}>
          <div className="grid grid-cols-1 gap-3">
            <Field label={t("export.format")}>
              <SelectInput value={paper} onChange={(event) => setPaper(event.target.value as ExportPaper)}>
                <option value="original">{t("export.originalRatio")}</option>
                <option value="a4">{t("export.a4")}</option>
                <option value="a3">{t("export.a3")}</option>
                <option value="custom">{t("export.custom")}</option>
              </SelectInput>
            </Field>
            <Field label={t("export.orientation")}>
              <SelectInput value={orientation} onChange={(event) => setOrientation(event.target.value as ExportOrientation)}>
                <option value="landscape">{t("export.landscape")}</option>
                <option value="portrait">{t("export.portrait")}</option>
              </SelectInput>
            </Field>
            <Field label={t("export.scale")}>
              <SelectInput value={String(scale)} onChange={(event) => setScale(Number(event.target.value) as ExportScale)}>
                {[1, 2, 3, 4].map((value) => (
                  <option key={value} value={value}>
                    {t("export.scaleOption", {
                      scale: value,
                      width: dimensions.width * value,
                      height: dimensions.height * value,
                    })}
                  </option>
                ))}
              </SelectInput>
            </Field>
            {paper === "custom" ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Width">
                  <TextInput
                    type="number"
                    value={customWidth}
                    onChange={(event) => setCustomWidth(Number(event.target.value) || 1680)}
                  />
                </Field>
                <Field label="Height">
                  <TextInput
                    type="number"
                    value={customHeight}
                    onChange={(event) => setCustomHeight(Number(event.target.value) || 880)}
                  />
                </Field>
              </div>
            ) : null}
            <Button
              variant="subtle"
              size="sm"
              onClick={() =>
                dispatch(
                  {
                    type: "updateSettings",
                    patch: {
                      exportPaper: paper,
                      exportOrientation: orientation,
                      exportScale: scale,
                      customExportWidth: customWidth,
                      customExportHeight: customHeight,
                    },
                    description: t("history.exportDefaults"),
                  },
                  )
              }
            >
              {t("export.remember")}
            </Button>
          </div>
        </Panel>

        <Panel title={t("export.output")}>
          <div className="flex flex-col gap-2">
            <Chip tone="info">{dimensions.label}</Chip>
            <p className="text-[11px] text-slate-500">{t("export.outputHint")}</p>
            <Button variant="primary" disabled={busy !== null} onClick={() => void run("png")}>
              {busy === "png" ? t("export.rendering") : t("export.downloadPng", { scale })}
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => void run("pdf")}>
              {busy === "pdf"
                ? t("export.buildingPdf")
                : t("export.downloadPdf", { paper: paper === "original" ? t("export.sheet") : paper.toUpperCase() })}
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => void run("svg")}>
              {busy === "svg" ? t("export.exporting") : t("export.downloadSvg")}
            </Button>
            <Button variant="ghost" onClick={() => window.print()}>
              {t("export.printPage")}
            </Button>
          </div>
        </Panel>

        <Panel title={t("export.checklist")}>
          <ul className="space-y-1.5 text-[11px] text-slate-400">
            <li>{t("export.check1")}</li>
            <li>{t("export.check2")}</li>
            <li>{t("export.check3", { count: events.length })}</li>
          </ul>
        </Panel>
      </div>

      <div className="min-w-0">
        <div className="print-area relative overflow-x-auto rounded-lg border border-[#1d222d] bg-[#0a0b0f] p-3">
          <div className="mx-auto" style={{ maxWidth: dimensions.width }}>
            <ScheduleSvg layout={layout} svgRef={svgRef} />
            {/* Hidden copy used only for PDF generation (embedded Cyrillic font). */}
            <div aria-hidden className="pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0">
              <ScheduleSvg layout={pdfLayout} svgRef={pdfSvgRef} />
            </div>
          </div>
        </div>
        <p className="no-print mt-2 text-[11px] text-slate-500">
          {t("export.canvas", {
            width: dimensions.width,
            height: dimensions.height,
            pixelWidth: dimensions.pixelWidth,
            pixelHeight: dimensions.pixelHeight,
          })}
          {dimensions.pageMm ? ` · ${dimensions.pageMm.width} × ${dimensions.pageMm.height} mm` : ""}
        </p>
      </div>
    </div>
  );
}
