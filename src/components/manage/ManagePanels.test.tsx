// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ManagePanels } from "./ManagePanels";
import { LanguageProvider } from "@/components/app/LanguageProvider";
import { createTranslator } from "@/lib/i18n";

const mocks = vi.hoisted(() => ({ saveTrainer: vi.fn(), saveClass: vi.fn(), removeTrainer: vi.fn(), removeClass: vi.fn() }));
const trainer = { id: "trainer-one", name: "Alex", color: "#e11d48", initials: "AL", notes: "Trainer notes", active: true, sortOrder: 0 };
const classType = { id: "class-one", name: "Boxing", shortName: "BOX", defaultDuration: 45, description: "Class notes", active: true, sortOrder: 0, trainerIds: [trainer.id] };
vi.mock("@/components/app/WorkspaceProvider", () => ({ useWorkspace: () => ({
  schedule: { id: "hall-one", name: "Main hall" },
  trainers: [trainer], classTypes: [classType],
  events: [
    { id: "one", trainerId: trainer.id, classTypeId: classType.id },
    { id: "two", trainerId: trainer.id, classTypeId: "other-class" },
    { id: "three", trainerId: "other-trainer", classTypeId: "other-class" },
  ],
  saveTrainerWithClasses: mocks.saveTrainer, saveClassType: mocks.saveClass,
  removeTrainer: mocks.removeTrainer, removeClassType: mocks.removeClass,
  reorderTrainers: vi.fn(), reorderClassTypes: vi.fn(), toast: vi.fn(),
}) }));

const t = createTranslator("uk");
beforeEach(() => {
  mocks.saveTrainer.mockResolvedValue(true);
  mocks.saveClass.mockResolvedValue(true);
  mocks.removeTrainer.mockResolvedValue(true);
  mocks.removeClass.mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear(); });
const renderManage = (classes = false) => {
  render(<LanguageProvider><ManagePanels /></LanguageProvider>);
  if (classes) fireEvent.click(screen.getByRole("button", { name: t("manage.tabClasses") }));
};

describe("management name editing", () => {
  it.each(["name", "edit"])("opens the populated trainer editor through %s and saves its existing class links", async (entry) => {
    renderManage();
    const trigger = screen.getByRole("button", { name: entry === "name" ? t("manage.editTrainer", { name: trainer.name }) : t("common.edit") });
    expect((trigger as HTMLButtonElement).type).toBe("button");
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: t("manage.editTrainer", { name: trainer.name }) });
    const name = within(dialog).getByRole("textbox", { name: t("manage.name") }) as HTMLInputElement;
    expect(name.value).toBe("Alex");
    expect((within(dialog).getByRole("checkbox", { name: classType.name }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(name, { target: { value: "Alex updated" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("manage.saveTrainer") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.saveTrainer).toHaveBeenCalledExactlyOnceWith({ ...trainer, name: "Alex updated" }, [classType.id]);
  });

  it.each(["name", "edit"])("opens the populated class type editor through %s and preserves eligibility", async (entry) => {
    renderManage(true);
    const trigger = screen.getByRole("button", { name: entry === "name" ? t("manage.editClassType", { name: classType.name }) : t("common.edit") });
    expect((trigger as HTMLButtonElement).type).toBe("button");
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: t("manage.editClassType", { name: classType.name }) });
    const name = within(dialog).getByRole("textbox", { name: t("manage.name") }) as HTMLInputElement;
    expect(name.value).toBe("Boxing");
    expect((within(dialog).getByRole("checkbox", { name: trainer.name }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(name, { target: { value: "Boxing updated" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("manage.saveClassType") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.saveClass).toHaveBeenCalledExactlyOnceWith({ ...classType, name: "Boxing updated" });
  });

  it("returns focus to the trainer name after cancelling its editor without saving", () => {
    renderManage();
    const name = screen.getByRole("button", { name: t("manage.editTrainer", { name: trainer.name }) });
    name.focus();
    fireEvent.click(name);
    fireEvent.click(screen.getByRole("button", { name: t("common.cancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(name);
    expect(mocks.saveTrainer).not.toHaveBeenCalled();
  });
});

describe("catalogue deletion confirmation", () => {
  it.each([{ classes: false, hint: "manage.deleteTrainerHint", count: 2 }, { classes: true, hint: "manage.deleteClassHint", count: 1 }] as const)("explains cascading deletion and counts matching classes ($classes)", ({ classes, hint, count }) => {
    renderManage(classes);
    fireEvent.click(screen.getByRole("button", { name: t("common.delete") }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(t(hint))).toBeTruthy();
    expect(within(dialog).getByText(t("manage.deleteEventsCount", { count }))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: t("common.cancel") }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mocks.removeTrainer).not.toHaveBeenCalled();
    expect(mocks.removeClass).not.toHaveBeenCalled();
  });

  it("keeps class deletion busy until completion and retains confirmation on failure", async () => {
    let finish!: (success: boolean) => void;
    mocks.removeClass.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    renderManage(true);
    fireEvent.click(screen.getByRole("button", { name: t("common.delete") }));
    const dialog = screen.getByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: t("manage.deleteClassAction") });
    fireEvent.click(confirm);
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(confirm);
    expect(mocks.removeClass).toHaveBeenCalledExactlyOnceWith(classType.id);
    await act(async () => { finish(false); });
    expect(screen.getByRole("alertdialog").getAttribute("aria-busy")).toBe("false");
  });
});
