import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS, settingsSchema, type ClassType, type ScheduleEvent, type Trainer } from "@/lib/domain/types";
import { buildScheduleLayout } from "@/lib/schedule/layout";
import { ScheduleSvg } from "@/components/schedule/ScheduleSvg";
import { getTheme, risenTeamDark, THEME_OPTIONS } from "@/lib/theme/risen-team-dark";
import { hexToRgb } from "@/lib/theme/color";

const trainers: Trainer[] = [{id:"trainer",name:"Тренер",color:"#8b5cf6",active:true,sortOrder:0}];
const classTypes: ClassType[] = [{id:"class",name:"Бокс",shortName:"БОКС",defaultDuration:60,trainerIds:["trainer"],active:true,sortOrder:0}];
const events: ScheduleEvent[] = [{id:"event",scheduleId:"hall",trainerId:"trainer",classTypeId:"class",dayOfWeek:0,startTime:"10:00",endTime:"11:00"}];
function layoutFor(id: string) {
  const settings = settingsSchema.parse({...DEFAULT_SETTINGS,themeId:id});
  return buildScheduleLayout({settings,events,trainers,classTypes,rooms:[],theme:getTheme(settings.themeId),width:1680,height:880});
}
function luminance(hex: string) {
  const {r,g,b}=hexToRgb(hex);
  const linear=(value:number) => {const channel=value/255;return channel<=0.04045 ? channel/12.92 : ((channel+0.055)/1.055)**2.4;};
  return 0.2126*linear(r)+0.7152*linear(g)+0.0722*linear(b);
}
function contrast(a:string,b:string) {const l=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (l[0]+0.05)/(l[1]+0.05);}

describe("schedule themes with trainer colours", () => {
  it("keeps the original and legacy settings compatible, including unknown registry keys", () => {
    expect(getTheme("risen-team-dark")).toBe(risenTeamDark);
    for(const id of [undefined,null,"team-nesin-dark","nesin-team-dark","missing","__proto__","toString"]) expect(getTheme(id)).toBe(risenTeamDark);
    expect(layoutFor("risen-team-dark").cards[0].colors.accent).toBe(trainers[0].color);
  });

  it.each(THEME_OPTIONS)("renders $id consistently in the shared layout and export SVG", option => {
    const layout=layoutFor(option.id),theme=layout.theme;
    const markup=renderToStaticMarkup(<ScheduleSvg layout={layout} />);
    expect(layout.cards[0].colors.accent).toBe(trainers[0].color);
    expect(layout.cards[0].trainerColor).toBe(trainers[0].color);
    expect(markup).toContain(`fill="${theme.canvas.background}"`);
    expect(markup).toContain(`fill="${layout.cards[0].colors.background}"`);
    expect(markup).toContain(`fill="${theme.days.accent}"`);
    expect(markup).toContain(`fill="${trainers[0].color}"`);
    expect(markup).toContain("Тренер");
    expect(layout.cards[0].width).toBeGreaterThan(0);
    expect(layout.cards[0].y+layout.cards[0].height).toBeLessThanOrEqual(layout.body.y+layout.body.height);
    expect(contrast(theme.cards.cardText,layout.cards[0].colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.cards.cardMuted,layout.cards[0].colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.header.subtitleColor,theme.canvas.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.timeAxis.labelColor,theme.canvas.background)).toBeGreaterThanOrEqual(4.5);
    if (theme.id !== risenTeamDark.id) expect(contrast(theme.brand.muted,theme.brand.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("offers three visually distinct new themes without changing the saved trainer identity", () => {
    const newThemes=THEME_OPTIONS.slice(1).map(option=>getTheme(option.id));
    expect(new Set(newThemes.map(theme=>theme.canvas.background)).size).toBe(3);
    expect(new Set(newThemes.map(theme=>theme.cards.radius)).size).toBe(3);
    expect(new Set(newThemes.map(theme=>theme.grid.verticalStrong)).size).toBe(3);
    expect(trainers[0].color).toBe("#8b5cf6");
  });

  it.each(THEME_OPTIONS)("retains multiple trainer identities in $id cards and legend", ({ id }) => {
    const settings = settingsSchema.parse({ ...DEFAULT_SETTINGS, themeId: id });
    const otherTrainer = { ...trainers[0], id: "other-trainer", color: "#22c55e" };
    const layout = buildScheduleLayout({ settings, events: [...events, { ...events[0], id: "other-event", trainerId: otherTrainer.id, dayOfWeek: 1 }],
      trainers: [...trainers, otherTrainer], classTypes, rooms: [], theme: getTheme(id), width: 1680, height: 880 });
    expect(layout.cards.map(card => card.colors.accent)).toEqual([trainers[0].color, otherTrainer.color]);
    expect(layout.brand.items.map(item => item.color)).toEqual([trainers[0].color, otherTrainer.color]);
    const svg = renderToStaticMarkup(<ScheduleSvg layout={layout} />);
    expect(svg).toContain(`fill="${otherTrainer.color}"`);
  });
});
