import type { ScheduleLayout } from "@/lib/schedule/layout";

/** Conservative advances for the bundled Helvetica/Arial-compatible brand text.
 * Rendering also clips to the same width, keeping font fallback inside the panel. */
export function estimateLabelWidth(text: string, fontSize: number, letterSpacing: number): number {
  const letters = Array.from(text);
  return letters.reduce((width, letter, index) => {
    const factor = /\p{Mark}/u.test(letter) ? 0
      : /\s/u.test(letter) ? 0.36
      : /[IJІЇ1]/u.test(letter) ? 0.43
      : /[MWЖШЩЮФ]/u.test(letter) ? 1.05
      : /[.,:;'!|]/u.test(letter) ? 0.42
      : /[A-ZА-ЯІЇЄҐ0-9]/u.test(letter) ? 0.8 : 1.05;
    return width + factor * fontSize + (index ? letterSpacing : 0);
  }, 0);
}

export function fitLabelToWidth(text: string, width: number, fontSize: number, letterSpacing: number): string {
  if (width <= 0) return "";
  if (estimateLabelWidth(text, fontSize, letterSpacing) <= width) return text;
  const letters = Array.from(text);
  while (letters.length && estimateLabelWidth(`${letters.join("").trimEnd()}…`, fontSize, letterSpacing) > width) letters.pop();
  const result = `${letters.join("").trimEnd()}…`;
  return estimateLabelWidth(result, fontSize, letterSpacing) <= width ? result : "";
}

export function brandLabels(layout: ScheduleLayout) {
  const width = Math.max(0, layout.brand.logoArea.width - layout.theme.brand.logoPadding * 2);
  const label = (fullText: string, fontSize: number, letterSpacing: number) => ({
    fullText,
    text: fitLabelToWidth(fullText, width, fontSize, letterSpacing),
    fontSize,
    letterSpacing,
  });
  return {
    width,
    title: label(layout.title.toUpperCase(), layout.theme.brand.titleSize, 2),
    subtitle: label(layout.subtitle.toUpperCase(), layout.theme.brand.subtitleSize, 1.6),
  };
}
