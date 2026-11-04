export type ExportPaper = "original" | "a4" | "a3" | "custom";
export type ExportOrientation = "landscape" | "portrait";
export type ExportScale = 1 | 2 | 3 | 4;

export interface ExportDimensionInput {
  paper: ExportPaper;
  orientation: ExportOrientation;
  scale: ExportScale;
  customWidth: number;
  customHeight: number;
}

export interface ExportDimensions {
  /** Design (CSS px) size of the rendered schedule canvas. */
  width: number;
  height: number;
  /** Raster size actually produced for PNG export. */
  pixelWidth: number;
  pixelHeight: number;
  /** Page size for PDF export (undefined for the native/original ratio). */
  pageMm: { width: number; height: number } | null;
  label: string;
}

export const ORIGINAL_RATIO = { width: 1680, height: 880 };
const MM: Record<"a4" | "a3", { long: number; short: number }> = {
  a4: { long: 297, short: 210 },
  a3: { long: 420, short: 297 },
};
const LANDSCAPE_BASE_WIDTH = 1680;
const PORTRAIT_BASE_WIDTH = 1188; // 1680 * (210/297) so A4 portrait keeps sane text scale

export function computeExportDimensions(input: ExportDimensionInput): ExportDimensions {
  const scale = normalizeScale(input.scale);

  if (input.paper === "original") {
    const width = input.orientation === "landscape" ? ORIGINAL_RATIO.width : ORIGINAL_RATIO.height;
    const height = input.orientation === "landscape" ? ORIGINAL_RATIO.height : ORIGINAL_RATIO.width;
    return {
      width,
      height,
      pixelWidth: width * scale,
      pixelHeight: height * scale,
      pageMm: null,
      label: `Original ${width}×${height} @${scale}x`,
    };
  }

  if (input.paper === "custom") {
    const width = clamp(Math.round(input.customWidth), 600, 6000);
    const height = clamp(Math.round(input.customHeight), 400, 6000);
    return {
      width,
      height,
      pixelWidth: width * scale,
      pixelHeight: height * scale,
      pageMm: null,
      label: `Custom ${width}×${height} @${scale}x`,
    };
  }

  const paper = MM[input.paper];
  const pageMm =
    input.orientation === "landscape"
      ? { width: paper.long, height: paper.short }
      : { width: paper.short, height: paper.long };
  const ratio = pageMm.height / pageMm.width;
  const baseWidth =
    input.orientation === "landscape" ? LANDSCAPE_BASE_WIDTH : PORTRAIT_BASE_WIDTH;
  const width = baseWidth;
  const height = Math.round(baseWidth * ratio);

  return {
    width,
    height,
    pixelWidth: width * scale,
    pixelHeight: height * scale,
    pageMm: { width: pageMm.width, height: pageMm.height },
    label: `${input.paper.toUpperCase()} ${input.orientation} @${scale}x`,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function normalizeScale(value: number): ExportScale {
  const rounded = Math.round(value);
  if (rounded <= 1) return 1;
  if (rounded === 2) return 2;
  if (rounded === 3) return 3;
  return 4;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
