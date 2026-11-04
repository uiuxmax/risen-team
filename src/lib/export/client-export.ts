"use client";

import type { ExportDimensions } from "@/lib/export/dimensions";

/**
 * Export pipeline (browser side).
 *
 * Schedule data → layout engine → SVG renderer → { PNG, PDF, SVG }
 *
 * The PNG is produced by rasterising the SVG at the requested multiple, so
 * geometry/text stay sharp (a 4x export really is 4x, not an upscaled screenshot).
 * The PDF embeds the same SVG as vector artwork via jsPDF + svg2pdf.js.
 */

export function serializeSvg(svg: SVGSVGElement, pixelWidth: number, pixelHeight: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.setAttribute("width", String(Math.round(pixelWidth)));
  clone.setAttribute("height", String(Math.round(pixelHeight)));
  clone.setAttribute("viewBox", `0 0 ${svg.viewBox.baseVal.width || pixelWidth} ${svg.viewBox.baseVal.height || pixelHeight}`);
  return new XMLSerializer().serializeToString(clone);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function svgToPngBlob(
  svg: SVGSVGElement,
  pixelWidth: number,
  pixelHeight: number,
  background: string,
): Promise<Blob> {
  const serialized = serializeSvg(svg, pixelWidth, pixelHeight);
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;

  const image = new Image();
  image.width = pixelWidth;
  image.height = pixelHeight;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The schedule image could not be rendered. Please try again."));
    image.src = source;
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(pixelWidth);
  canvas.height = Math.round(pixelHeight);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser blocked the export canvas. Try a different browser.");
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The PNG could not be created. Try a smaller export scale.");
  return blob;
}

export async function exportSvgFile(svg: SVGSVGElement, dimensions: ExportDimensions, filename: string): Promise<void> {
  const serialized = serializeSvg(svg, dimensions.width, dimensions.height);
  downloadBlob(new Blob([serialized], { type: "image/svg+xml;charset=utf-8" }), filename);
}

export async function exportPngFile(
  svg: SVGSVGElement,
  dimensions: ExportDimensions,
  filename: string,
  background: string,
): Promise<{ bytes: number }> {
  const blob = await svgToPngBlob(svg, dimensions.pixelWidth, dimensions.pixelHeight, background);
  downloadBlob(blob, filename);
  return { bytes: blob.size };
}

/**
 * Embedded PDF font.
 *
 * The PDF never relies on fonts installed on the viewing computer: DejaVu Sans
 * (redistributable, Cyrillic-complete) is embedded into the document, so
 * Ukrainian text stays correct on Windows, macOS and anywhere else.
 */
export const PDF_FONT_NAME = "RisenSans";
const PDF_FONT_FILES: { file: string; weight: "normal" | "bold" }[] = [
  { file: "/fonts/RisenSans.ttf", weight: "normal" },
  { file: "/fonts/RisenSans-Bold.ttf", weight: "bold" },
];

async function loadFontBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    return arrayBufferToBase64(buffer);
  } catch {
    return null;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export interface PdfFontAvailability {
  normal: boolean;
  bold: boolean;
}

/** Registers the embedded Cyrillic font inside a jsPDF document. */
export async function registerPdfFonts(doc: { addFileToVFS: (name: string, data: string) => void; addFont: (file: string, name: string, style: string) => void }): Promise<PdfFontAvailability> {
  const availability: PdfFontAvailability = { normal: false, bold: false };
  for (const font of PDF_FONT_FILES) {
    const base64 = await loadFontBase64(font.file);
    if (!base64) continue;
    const fileName = font.file.split("/").pop() ?? "font.ttf";
    doc.addFileToVFS(fileName, base64);
    doc.addFont(fileName, PDF_FONT_NAME, font.weight);
    availability[font.weight] = true;
  }
  return availability;
}

export async function exportPdfFile(
  svg: SVGSVGElement,
  dimensions: ExportDimensions,
  filename: string,
  background: string,
): Promise<{ bytes: number; vector: boolean; embeddedFont: boolean }> {
  const { jsPDF } = await import("jspdf");

  const pageWidth = dimensions.pageMm ? dimensions.pageMm.width : dimensions.width * 0.75;
  const pageHeight = dimensions.pageMm ? dimensions.pageMm.height : dimensions.height * 0.75;
  const unit = dimensions.pageMm ? "mm" : "pt";

  const doc = new jsPDF({
    orientation: pageWidth >= pageHeight ? "landscape" : "portrait",
    unit,
    format: [pageWidth, pageHeight],
    compress: true,
  });

  const fonts = await registerPdfFonts(doc);
  const embeddedFont = fonts.normal || fonts.bold;

  try {
    const { svg2pdf } = await import("svg2pdf.js");
    await svg2pdf(svg, doc, { x: 0, y: 0, width: pageWidth, height: pageHeight });
    const arrayBuffer = doc.output("arraybuffer");
    downloadBlob(new Blob([arrayBuffer], { type: "application/pdf" }), filename);
    return { bytes: arrayBuffer.byteLength, vector: true, embeddedFont };
  } catch {
    // Fallback: embed a high resolution raster so the user always gets a PDF.
    const blob = await svgToPngBlob(svg, dimensions.width * 3, dimensions.height * 3, background);
    const dataUrl = await blobToDataUrl(blob);
    doc.addImage(dataUrl, "PNG", 0, 0, pageWidth, pageHeight, undefined, "FAST");
    const arrayBuffer = doc.output("arraybuffer");
    downloadBlob(new Blob([arrayBuffer], { type: "application/pdf" }), filename);
    return { bytes: arrayBuffer.byteLength, vector: false, embeddedFont };
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(blob);
  });
}

export async function readFileAsDataUrl(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes) {
    throw new Error(`Please choose an image smaller than ${Math.round(maxBytes / 1024)} KB.`);
  }
  return blobToDataUrl(file);
}
