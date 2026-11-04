/** Small colour helpers shared by the DOM editor and the SVG export renderer. */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const cleaned = hex.replace("#", "").trim();
  const full =
    cleaned.length === 3
      ? cleaned
          .split("")
          .map((char) => char + char)
          .join("")
      : cleaned.padEnd(6, "0").slice(0, 6);
  const value = Number.parseInt(full, 16);
  if (Number.isNaN(value)) return { r: 148, g: 163, b: 184 };
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
}

export function mixColors(a: string, b: string, t: number): string {
  const first = hexToRgb(a);
  const second = hexToRgb(b);
  const ratio = Math.max(0, Math.min(1, t));
  const r = Math.round(first.r + (second.r - first.r) * ratio);
  const g = Math.round(first.g + (second.g - first.g) * ratio);
  const bl = Math.round(first.b + (second.b - first.b) * ratio);
  return `#${[r, g, bl].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export interface CardColors {
  accent: string;
  border: string;
  background: string;
  title: string;
  meta: string;
  trainer: string;
}

/** Automatic card palette derived from the trainer colour + theme surfaces. */
export function cardColors(trainerColor: string, surfaces: { card: string; text: string; muted: string }): CardColors {
  return {
    accent: trainerColor,
    border: withAlpha(trainerColor, 0.55),
    background: mixColors(surfaces.card, trainerColor, 0.16),
    title: surfaces.text,
    meta: surfaces.muted,
    trainer: mixColors(trainerColor, "#ffffff", 0.35),
  };
}
