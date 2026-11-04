/**
 * Theme architecture.
 *
 * DATA  →  LAYOUT ENGINE  →  THEME
 *
 * The layout engine only speaks in rectangles/positions. All colours, sizes and
 * typography come from a theme object, so additional themes (light, TV, social,
 * print) can reuse exactly the same schedule data and layout engine.
 *
 * Initial theme: Risen Team Dark. The right-hand brand panel contains the club
 * logo on top and the trainer legend directly below it.
 */

export interface ScheduleTheme {
  id: string;
  name: string;
  fonts: { family: string; display: string };
  canvas: {
    background: string;
    border: string;
    radius: number;
    padding: number;
  };
  header: {
    height: number;
    titleSize: number;
    subtitleSize: number;
    titleColor: string;
    subtitleColor: string;
    metaSize: number;
    metaColor: string;
  };
  days: {
    headerHeight: number;
    labelSize: number;
    letterSpacing: number;
    color: string;
    weekendColor: string;
    accent: string;
    divider: string;
  };
  timeAxis: {
    width: number;
    labelSize: number;
    labelColor: string;
    customColor: string;
    boundaryColor: string;
  };
  grid: {
    line: string;
    customLine: string;
    vertical: string;
    verticalStrong: string;
    hourStrong: string;
  };
  cards: {
    radius: number;
    paddingX: number;
    paddingY: number;
    titleSize: number;
    metaSize: number;
    accentWidth: number;
    gap: number;
    cardSurface: string;
    cardText: string;
    cardMuted: string;
    compactTitleSize: number;
    compactMetaSize: number;
  };
  brand: {
    width: number;
    gap: number;
    background: string;
    border: string;
    logoPadding: number;
    titleSize: number;
    titleColor: string;
    subtitleSize: number;
    subtitleColor: string;
    legendTitle: string;
    legendTitleSize: number;
    itemSize: number;
    itemHeight: number;
    swatch: number;
    muted: string;
  };
}

export const risenTeamDark: ScheduleTheme = {
  id: "risen-team-dark",
  name: "Risen Team Dark",
  fonts: {
    family: "Helvetica, Arial, 'Segoe UI', sans-serif",
    display: "Helvetica, Arial, 'Segoe UI', sans-serif",
  },
  canvas: {
    background: "#08090c",
    border: "#1e222c",
    radius: 10,
    padding: 12,
  },
  header: {
    height: 46,
    titleSize: 20,
    subtitleSize: 11,
    titleColor: "#f8fafc",
    subtitleColor: "#8b93a6",
    metaSize: 11,
    metaColor: "#9aa3b6",
  },
  days: {
    headerHeight: 34,
    labelSize: 12.5,
    letterSpacing: 2.0,
    color: "#e6e9f1",
    weekendColor: "#bfc6d4",
    accent: "#e11d48",
    divider: "#1a1e27",
  },
  timeAxis: {
    width: 62,
    labelSize: 11,
    labelColor: "#98a1b3",
    customColor: "#facc15",
    boundaryColor: "#d5dbe6",
  },
  grid: {
    line: "#161a23",
    customLine: "#3b3513",
    vertical: "#14171f",
    verticalStrong: "#222733",
    hourStrong: "#1d2330",
  },
  cards: {
    radius: 8,
    paddingX: 8,
    paddingY: 6,
    titleSize: 15,
    metaSize: 11,
    accentWidth: 3.5,
    gap: 5,
    cardSurface: "#12151d",
    cardText: "#f5f7fb",
    cardMuted: "#98a1b3",
    compactTitleSize: 12,
    compactMetaSize: 10,
  },
  brand: {
    width: 196,
    gap: 12,
    background: "#0b0d13",
    border: "#1e222c",
    logoPadding: 16,
    titleSize: 17,
    titleColor: "#f8fafc",
    subtitleSize: 10,
    subtitleColor: "#8b93a6",
    legendTitle: "#8b93a6",
    legendTitleSize: 10,
    itemSize: 13,
    itemHeight: 28,
    swatch: 9,
    muted: "#6d7488",
  },
};

export const THEMES: Record<string, ScheduleTheme> = {
  "risen-team-dark": risenTeamDark,
  "risen-carbon": {
    ...risenTeamDark,
    id: "risen-carbon",
    name: "Carbon",
    canvas: { ...risenTeamDark.canvas, background: "#050505", border: "#292929", radius: 4 },
    header: { ...risenTeamDark.header, titleColor: "#fafafa", subtitleColor: "#b2b2b2", metaColor: "#b2b2b2" },
    days: { ...risenTeamDark.days, color: "#eeeeee", weekendColor: "#c8c8c8", accent: "#ce2538", divider: "#242424", letterSpacing: 1.5 },
    timeAxis: { ...risenTeamDark.timeAxis, labelColor: "#aaaaaa", customColor: "#ff8793", boundaryColor: "#dedede" },
    grid: { line: "#202020", customLine: "#64232d", vertical: "#1c1c1c", verticalStrong: "#353535", hourStrong: "#2b2b2b" },
    cards: { ...risenTeamDark.cards, radius: 3, cardSurface: "#121212", cardText: "#fafafa", cardMuted: "#b8b8b8", accentWidth: 3 },
    brand: { ...risenTeamDark.brand, background: "#0b0b0b", border: "#2d2d2d", titleColor: "#fafafa", subtitleColor: "#b2b2b2", legendTitle: "#b2b2b2", muted: "#a3a3a3" },
  },
  "risen-crimson": {
    ...risenTeamDark,
    id: "risen-crimson",
    name: "Crimson",
    canvas: { ...risenTeamDark.canvas, background: "#0b0506", border: "#4c2029", radius: 16 },
    header: { ...risenTeamDark.header, titleColor: "#fff7f8", subtitleColor: "#c9b5bb", metaColor: "#c9b5bb" },
    days: { ...risenTeamDark.days, color: "#fff0f3", weekendColor: "#e3c1ca", accent: "#e63b4f", divider: "#3c1b23" },
    timeAxis: { ...risenTeamDark.timeAxis, labelColor: "#c6adb5", customColor: "#ff9da9", boundaryColor: "#f2d7de" },
    grid: { line: "#2c151b", customLine: "#74313f", vertical: "#251116", verticalStrong: "#50232e", hourStrong: "#3b1b24" },
    cards: { ...risenTeamDark.cards, radius: 12, cardSurface: "#211013", cardText: "#fff7f8", cardMuted: "#d8bfc7", accentWidth: 4 },
    brand: { ...risenTeamDark.brand, background: "#190b0f", border: "#57232f", titleColor: "#fff7f8", subtitleColor: "#cbb3bb", legendTitle: "#cbb3bb", muted: "#c0aeb2" },
  },
  "risen-signal": {
    ...risenTeamDark,
    id: "risen-signal",
    name: "Signal",
    canvas: { ...risenTeamDark.canvas, background: "#000000", border: "#666666", radius: 0 },
    header: { ...risenTeamDark.header, titleColor: "#ffffff", subtitleColor: "#d0d0d0", metaColor: "#d0d0d0", titleSize: 22 },
    days: { ...risenTeamDark.days, color: "#ffffff", weekendColor: "#ffffff", accent: "#ff303f", divider: "#555555", labelSize: 13, letterSpacing: 2.5 },
    timeAxis: { ...risenTeamDark.timeAxis, labelColor: "#dedede", customColor: "#ffb3b9", boundaryColor: "#ffffff" },
    grid: { line: "#323232", customLine: "#b73540", vertical: "#2e2e2e", verticalStrong: "#666666", hourStrong: "#505050" },
    cards: { ...risenTeamDark.cards, radius: 0, cardSurface: "#101010", cardText: "#ffffff", cardMuted: "#dedede", accentWidth: 5.5 },
    brand: { ...risenTeamDark.brand, background: "#050505", border: "#666666", titleColor: "#ffffff", subtitleColor: "#dedede", legendTitle: "#dedede", muted: "#c9c9c9" },
  },
};

/** Stable order and translation keys for the settings picker. */
export const THEME_OPTIONS = [
  { id: "risen-team-dark", nameKey: "theme.original", descriptionKey: "theme.originalHint" },
  { id: "risen-carbon", nameKey: "theme.carbon", descriptionKey: "theme.carbonHint" },
  { id: "risen-crimson", nameKey: "theme.crimson", descriptionKey: "theme.crimsonHint" },
  { id: "risen-signal", nameKey: "theme.signal", descriptionKey: "theme.signalHint" },
] as const;

const LEGACY_THEME_IDS = ["team-nesin-dark", "nesin-team-dark"];

export function getTheme(id: string | undefined | null): ScheduleTheme {
  if (id && Object.prototype.hasOwnProperty.call(THEMES, id)) return THEMES[id];
  // Older saved settings pointed at the pre-rebrand theme id — map them silently.
  if (id && LEGACY_THEME_IDS.includes(id)) return risenTeamDark;
  return risenTeamDark;
}
