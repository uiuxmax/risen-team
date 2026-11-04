// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { LanguageProvider } from "@/components/app/LanguageProvider";
import { Button, Modal, TextInput, TimeField } from "@/components/ui/controls";
import { SnapshotDialog } from "@/components/schedule/dialogs";

afterEach(() => {cleanup();vi.restoreAllMocks();});
function Fixture({busy=false}:{busy?:boolean}) {
  const [open,setOpen]=useState(false);
  return <LanguageProvider><Button onClick={()=>setOpen(true)}>Open editor</Button><Modal open={open} onClose={()=>setOpen(false)} title="Editor" description="Example form" busy={busy} footer={<Button>Save</Button>}><TextInput aria-label="Name" /></Modal></LanguageProvider>;
}
function openEditor() {const trigger=screen.getByRole("button",{name:"Open editor"});trigger.focus();fireEvent.click(trigger);return trigger;}
function ConditionalEditorFixture() {
  const [editing, setEditing] = useState(false);
  return <LanguageProvider>
    <Button onClick={() => setEditing(true)}>Alex</Button>
    {editing ? <Modal open title="Edit Alex" onClose={() => setEditing(false)} footer={<Button onClick={() => setEditing(false)}>Cancel</Button>}>
      <TextInput autoFocus aria-label="Trainer name" defaultValue="Alex" />
    </Modal> : null}
  </LanguageProvider>;
}
function MountedAutofocusFixture() {
  const [open, setOpen] = useState(false);
  return <LanguageProvider>
    <Button onClick={() => setOpen(true)}>First trainer</Button>
    <Button onClick={() => setOpen(true)}>Second trainer</Button>
    <Modal open={open} title="Edit trainer" onClose={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>Cancel</Button>}>
      <TextInput autoFocus aria-label="Trainer name" />
    </Modal>
  </LanguageProvider>;
}
describe("modal interactions", () => {
  it("restores each opener when a retained modal opens with an autofocus input", () => {
    render(<MountedAutofocusFixture />);
    for (const name of ["First trainer", "Second trainer"]) {
      const trigger = screen.getByRole("button", { name });
      trigger.focus();
      fireEvent.click(trigger);
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Trainer name" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    }
  });
  it("restores the name button after cancelling a conditionally mounted editor with autofocus", () => {
    render(<ConditionalEditorFixture />);
    const nameButton = screen.getByRole("button", { name: "Alex" });
    nameButton.focus();
    fireEvent.click(nameButton);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Trainer name" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(nameButton);
  });
  it("keeps the checkpoint form and its name after a failed save", async () => {
    const close=vi.fn(),confirm=vi.fn(async()=>false);
    render(<LanguageProvider><SnapshotDialog open onClose={close} onConfirm={confirm} /></LanguageProvider>);
    fireEvent.change(screen.getByRole("textbox"),{target:{value:"Before review"}});
    fireEvent.click(screen.getByRole("button",{name:/Зберегти|Save/}));
    await waitFor(()=>expect(screen.getByRole("alert")).toBeTruthy());
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Before review");
    expect(confirm).toHaveBeenCalledWith("Before review");
    expect(close).not.toHaveBeenCalled();
  });
  it("associates time labels with their actual inputs", () => {
    render(<LanguageProvider><TimeField value="10:00" onChange={()=>{}} label="Start time" /></LanguageProvider>);
    expect((screen.getByLabelText("Start time") as HTMLInputElement).type).toBe("time");
  });
  it("closes with a backdrop click and restores focus/scroll to the page", () => {
    render(<Fixture />);const trigger=openEditor();
    const dialog=screen.getByRole("dialog",{name:"Editor"});
    screen.getByRole("textbox",{name:"Name"}).focus();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.pointerDown(dialog);fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("");
  });
  it("does not dismiss a form when a gesture starts inside then ends on the backdrop", () => {
    render(<Fixture />);openEditor();
    const input=screen.getByRole("textbox",{name:"Name"});
    fireEvent.pointerDown(input);fireEvent.click(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  it("closes through the native Escape cancel event", () => {
    render(<Fixture />);openEditor();
    fireEvent(screen.getByRole("dialog"),new Event("cancel",{cancelable:true}));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps an in-flight operation open for backdrop, Escape and close-button attempts", () => {
    render(<Fixture busy />);openEditor();
    const dialog=screen.getByRole("dialog");
    fireEvent.pointerDown(dialog);fireEvent.click(dialog);
    fireEvent(dialog,new Event("cancel",{cancelable:true}));
    const close=screen.getByRole("button",{name:/Закрити|Close/});
    expect((close as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  it("keeps shortcuts inside the dialog instead of changing the underlying schedule", () => {
    const handler=vi.fn();window.addEventListener("keydown",handler);
    try { render(<Fixture />);openEditor();fireEvent.keyDown(screen.getByRole("textbox"),{key:"z",ctrlKey:true});expect(handler).not.toHaveBeenCalled(); }
    finally {window.removeEventListener("keydown",handler);}
  });
});
