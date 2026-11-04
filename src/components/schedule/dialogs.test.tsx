// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LanguageProvider } from "@/components/app/LanguageProvider";
import { EventDialog } from "@/components/schedule/dialogs";
import { DEFAULT_SETTINGS, type ClassType, type Trainer } from "@/lib/domain/types";

const trainers: Trainer[] = [
  { id: "t1", name: "Trainer One", active: true, color: "#ff0000", sortOrder: 0 },
  { id: "t2", name: "Trainer Two", active: true, color: "#00ff00", sortOrder: 1 },
  { id: "t3", name: "No Permissions", active: true, color: "#0000ff", sortOrder: 2 },
];
const classTypes: ClassType[] = [
  { id: "c1", name: "Boxing", shortName: "BOX", active: true, sortOrder: 0, defaultDuration: 60, trainerIds: ["t1"] },
  { id: "c2", name: "Yoga", shortName: "YOGA", active: true, sortOrder: 1, defaultDuration: 60, trainerIds: ["t2"] },
  { id: "c3", name: "Unassigned", shortName: "NONE", active: true, sortOrder: 2, defaultDuration: 60, trainerIds: [] },
];
afterEach(() => { cleanup(); localStorage.clear(); });
describe("hall event eligibility", () => {
  it("changes available class types with the trainer and gives an empty-permission trainer no choices", () => {
    const onSave = vi.fn();
    render(<LanguageProvider><EventDialog open mode="create" scheduleId="hall" events={[]} trainers={trainers} classTypes={classTypes} rooms={[]} settings={DEFAULT_SETTINGS} onSave={onSave} onClose={() => {}} /></LanguageProvider>);
    const [classes, trainer] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(Array.from(classes.options).map((item) => item.value)).toEqual(["", "c1"]);
    fireEvent.change(trainer, { target: { value: "t2" } });
    expect(classes.value).toBe("");
    expect(screen.queryByText(/якого більше немає/)).toBeNull();
    expect(screen.getByText("Виберіть тип заняття.")).toBeTruthy();
    expect(Array.from(classes.options).map((item) => item.value)).toEqual(["", "c2"]);
    fireEvent.change(trainer, { target: { value: "t3" } });
    expect(Array.from(classes.options).map((item) => item.value)).toEqual([""]);
    expect(screen.queryByText("Unassigned")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("allows assigning a valid replacement after a trainer change without claiming the class was deleted", () => {
    const onSave=vi.fn();
    const initial={id:"event",scheduleId:"hall",trainerId:"t1",classTypeId:"c1",dayOfWeek:3,startTime:"10:00",endTime:"10:45"};
    render(<LanguageProvider><EventDialog open mode="edit" initial={initial} scheduleId="hall" events={[initial]} trainers={trainers} classTypes={classTypes} rooms={[]} settings={DEFAULT_SETTINGS} onSave={onSave} onClose={()=>{}} /></LanguageProvider>);
    const [classes,trainer]=screen.getAllByRole("combobox");
    fireEvent.change(trainer,{target:{value:"t2"}});
    expect(screen.queryByText(/якого більше немає/)).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"Зберегти зміни"}));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(classes,{target:{value:"c2"}});
    fireEvent.click(screen.getByRole("button",{name:"Зберегти зміни"}));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({trainerId:"t2",classTypeId:"c2"}));
    expect(screen.queryByText("Виберіть тип заняття.")).toBeNull();
  });

  it("shows a saved inactive trainer/type instead of an empty selection during editing", () => {
    const initial={id:"event",scheduleId:"hall",trainerId:"t1",classTypeId:"c1",dayOfWeek:3,startTime:"10:00",endTime:"11:00"};
    const onSave=vi.fn();
    render(<LanguageProvider><EventDialog open mode="edit" initial={initial} scheduleId="hall" events={[initial]} trainers={trainers.map(item=>({...item,active:false}))} classTypes={classTypes.map(item=>({...item,active:false}))} rooms={[]} settings={DEFAULT_SETTINGS} onSave={onSave} onClose={()=>{}} /></LanguageProvider>);
    const [classes,trainer]=screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(classes.value).toBe("c1");expect(trainer.value).toBe("t1");
    fireEvent.click(screen.getByRole("button",{name:"Зберегти зміни"}));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining(initial));
  });
});
