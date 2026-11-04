import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutosaveController,
  syncRecoveryStorage,
  clearRecoveryAfterSave,
  prepareScheduleMutation,
  autosaveDecision,
  decodeRecoverySnapshot,
  DEFAULT_AUTOSAVE_DELAY_MS,
  editorSignature,
  encodeRecoverySnapshot,
  RECOVERY_NEWER_TOLERANCE_MS,
  shouldOfferRecovery,
} from "@/lib/schedule/autosave";
import { DEFAULT_SETTINGS, type ScheduleEvent, type ScheduleSettings } from "@/lib/domain/types";

const baseEvent: ScheduleEvent = {
  id: "e1",
  scheduleId: "sched",
  dayOfWeek: 0,
  startTime: "15:00",
  endTime: "16:00",
  trainerId: "trn-oleh",
  classTypeId: "cls-boxing",
  roomId: null,
  notes: null,
};

const settings = (patch: Partial<ScheduleSettings> = {}): ScheduleSettings => ({ ...DEFAULT_SETTINGS, ...patch });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("autosaveDecision", () => {
  it("skips clean states regardless of the setting", () => {
    expect(autosaveDecision({ autosaveEnabled: true, dirty: false })).toBe("skip");
    expect(autosaveDecision({ autosaveEnabled: false, dirty: false })).toBe("skip");
  });

  it("saves dirty states while autosave is on", () => {
    expect(autosaveDecision({ autosaveEnabled: true, dirty: true })).toBe("save");
  });

  it("keeps dirty states local-only while autosave is off", () => {
    expect(autosaveDecision({ autosaveEnabled: false, dirty: true })).toBe("store-locally-only");
  });
});

describe("editorSignature", () => {
  it("matches for equal content and differs on any change", () => {
    const a = editorSignature([baseEvent], settings());
    expect(editorSignature([{ ...baseEvent }], settings())).toBe(a);
    expect(editorSignature([], settings())).not.toBe(a);
    expect(editorSignature([baseEvent], settings({ autosave: false }))).not.toBe(a);
    expect(editorSignature([{ ...baseEvent, startTime: "16:00" }], settings())).not.toBe(a);
  });
});

describe("recovery snapshots", () => {
  const input = {
    scheduleId: "sched",
    clientUpdatedAt: 1_700_000_000_000,
    events: [baseEvent],
    settings: settings(),
    description: "Added class",
  };

  it("round-trips through encode/decode", () => {
    const decoded = decodeRecoverySnapshot(JSON.stringify(encodeRecoverySnapshot(input)));
    expect(decoded).toEqual({ ...encodeRecoverySnapshot(input) });
    expect(decoded?.signature).toBe(editorSignature(input.events, input.settings));
  });

  it("rejects corrupt payloads without throwing", () => {
    expect(decodeRecoverySnapshot("not json{{{")).toBeNull();
    expect(decodeRecoverySnapshot(JSON.stringify(null))).toBeNull();
    expect(decodeRecoverySnapshot(JSON.stringify({}))).toBeNull();
    expect(decodeRecoverySnapshot(JSON.stringify({ ...input, events: "nope" }))).toBeNull();
    expect(decodeRecoverySnapshot(JSON.stringify({ ...input, scheduleId: "" }))).toBeNull();
    expect(decodeRecoverySnapshot(JSON.stringify({ ...input, clientUpdatedAt: Number.NaN }))).toBeNull();
  });

  it("rejects events and settings that fail domain validation", () => {
    const badEvent = decodeRecoverySnapshot(
      JSON.stringify({ ...input, events: [{ ...baseEvent, startTime: "25:99" }] }),
    );
    expect(badEvent).toBeNull();
    const badSettings = decodeRecoverySnapshot(
      JSON.stringify({ ...input, settings: { ...settings(), visibleDays: [] } }),
    );
    expect(badSettings).toBeNull();
  });

  it("migrates legacy payloads written before versioning", () => {
    const legacy = {
      scheduleId: input.scheduleId,
      clientUpdatedAt: input.clientUpdatedAt,
      events: input.events,
      settings: input.settings,
      description: input.description,
    };
    const decoded = decodeRecoverySnapshot(JSON.stringify(legacy));
    expect(decoded).toEqual({ ...legacy, version: 1, signature: editorSignature(input.events, input.settings) });
  });

  it("decodes the legacy empty-events sentinel left by older save cleanups", () => {
    const sentinel = {
      scheduleId: input.scheduleId,
      clientUpdatedAt: input.clientUpdatedAt,
      events: [],
      settings: input.settings,
      description: "",
    };
    expect(decodeRecoverySnapshot(JSON.stringify(sentinel))).not.toBeNull();
  });
});

describe("shouldOfferRecovery", () => {
  const snapshot = encodeRecoverySnapshot({
    scheduleId: "sched",
    clientUpdatedAt: 1_700_000_000_000,
    events: [baseEvent],
    settings: settings(),
    description: "",
  });
  const serverSignature = editorSignature([], settings());

  it("offers snapshots that are newer than the server copy and different", () => {
    expect(
      shouldOfferRecovery({
        snapshot,
        scheduleId: "sched",
        serverUpdatedAtMs: snapshot.clientUpdatedAt - RECOVERY_NEWER_TOLERANCE_MS - 1,
        serverSignature,
      }),
    ).toBe(true);
  });

  it("offers differing snapshots regardless of timestamps, preserving possible unsaved work", () => {
    for (const serverUpdatedAtMs of [
      snapshot.clientUpdatedAt,
      snapshot.clientUpdatedAt - RECOVERY_NEWER_TOLERANCE_MS,
      snapshot.clientUpdatedAt + 60_000,
    ]) {
      expect(shouldOfferRecovery({ snapshot, scheduleId: "sched", serverUpdatedAtMs, serverSignature })).toBe(true);
    }
  });

  it("stays quiet when the content already matches the server (a save landed)", () => {
    expect(
      shouldOfferRecovery({
        snapshot,
        scheduleId: "sched",
        serverUpdatedAtMs: snapshot.clientUpdatedAt - 60_000,
        serverSignature: snapshot.signature,
      }),
    ).toBe(false);
  });

  it("stays quiet for foreign schedules and unreadable server timestamps", () => {
    expect(
      shouldOfferRecovery({
        snapshot,
        scheduleId: "other",
        serverUpdatedAtMs: snapshot.clientUpdatedAt - 60_000,
        serverSignature,
      }),
    ).toBe(false);
    expect(
      shouldOfferRecovery({ snapshot, scheduleId: "sched", serverUpdatedAtMs: Number.NaN, serverSignature }),
    ).toBe(false);
  });
});

describe("AutosaveController", () => {
  function setup(saveImpl: () => Promise<boolean> = async () => true) {
    vi.useFakeTimers();
    const save = vi.fn(saveImpl);
    const exhausted = vi.fn();
    let dirty = true;
    let autosaveEnabled = true;
    const controller = new AutosaveController({
      delayMs: DEFAULT_AUTOSAVE_DELAY_MS,
      retryDelaysMs: [2000, 5000],
      save,
      isDirty: () => dirty,
      isAutosaveEnabled: () => autosaveEnabled,
      onExhausted: exhausted,
    });
    return {
      controller,
      save,
      exhausted,
      setDirty: (value: boolean) => {
        dirty = value;
      },
      setAutosaveEnabled: (value: boolean) => {
        autosaveEnabled = value;
      },
    };
  }

  it("debounces rapid edits into a single save", async () => {
    const { controller, save, setDirty } = setup();
    controller.notifyDirty(true);
    await vi.advanceTimersByTimeAsync(300);
    controller.notifyDirty(true);
    await vi.advanceTimersByTimeAsync(300);
    controller.notifyDirty(true);
    expect(save).not.toHaveBeenCalled();
    // The save persists everything: no follow-up is chained.
    setDirty(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.hasPendingSave).toBe(false);
  });

  it("drops the pending save when autosave is switched off", async () => {
    const { controller, save } = setup();
    controller.notifyDirty(true);
    expect(controller.hasPendingSave).toBe(true);
    controller.notifyDirty(false);
    expect(controller.hasPendingSave).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).not.toHaveBeenCalled();
  });

  it("cancels pending saves explicitly", async () => {
    const { controller, save } = setup();
    controller.notifyDirty(true);
    controller.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).not.toHaveBeenCalled();
  });

  it("chains a follow-up save when the editor is still dirty after a save", async () => {
    const { controller, save, setDirty } = setup();
    controller.notifyDirty(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    // Still dirty (an edit landed mid-save): a follow-up is scheduled...
    expect(controller.hasPendingSave).toBe(true);
    setDirty(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
    expect(controller.hasPendingSave).toBe(false);
  });

  it("never runs two saves concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    });
    const { controller, save, setDirty } = setup(() => gate);
    controller.notifyDirty(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    // Edits during the flight must not start a second save...
    controller.notifyDirty(true);
    controller.notifyDirty(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    // ...but they are picked up once the flight settles.
    setDirty(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.hasPendingSave).toBe(true);
    setDirty(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("retries failures with backoff and reports once when exhausted", async () => {
    const { controller, save, exhausted } = setup(async () => false);
    controller.notifyDirty(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(exhausted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(3);
    // Budget exhausted: quiet until the next edit, exactly one report.
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(controller.hasPendingSave).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("treats a throwing save as a failure", async () => {
    const { controller, save, exhausted } = setup(async () => {
      throw new Error("boom");
    });
    controller.notifyDirty(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS + 2000 + 5000);
    expect(save).toHaveBeenCalledTimes(3);
    expect(exhausted).toHaveBeenCalledTimes(1);
  });

  it("resets the retry budget on fresh user activity", async () => {
    let calls = 0;
    const { controller, save } = setup(async () => {
      calls += 1;
      return calls > 2;
    });
    controller.notifyDirty(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    // A new edit abandons the backoff for a normal debounced save...
    controller.notifyDirty(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
    // ...which still retries on failure.
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("notifyIfDirty chains manual saves only when still dirty", async () => {
    const { controller, save, setDirty } = setup();
    setDirty(false);
    controller.notifyIfDirty();
    expect(controller.hasPendingSave).toBe(false);
    setDirty(true);
    controller.notifyIfDirty();
    expect(controller.hasPendingSave).toBe(true);
    setDirty(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("honours the live setting when chaining after a save", async () => {
    const { controller, save, setAutosaveEnabled } = setup();
    controller.notifyDirty(true);
    setAutosaveEnabled(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    // Still dirty, but autosave is off now: no follow-up server save.
    expect(controller.hasPendingSave).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("stops scheduling after dispose", async () => {
    const { controller, save } = setup();
    controller.notifyDirty(true);
    controller.dispose();
    controller.notifyDirty(true);
    controller.notifyIfDirty();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(save).not.toHaveBeenCalled();
  });
});

it("offers a differing edit made immediately after the server save", () => {
  const snapshot = encodeRecoverySnapshot({ scheduleId: "sched", clientUpdatedAt: 1500, events: [baseEvent], settings: settings(), description: "" });
  expect(shouldOfferRecovery({ snapshot, scheduleId: "sched", serverUpdatedAtMs: 1000, serverSignature: editorSignature([], settings()) })).toBe(true);
});

it("does not retry a failed in-flight save after autosave is disabled", async () => {
  vi.useFakeTimers();
  let finish!: (value: boolean) => void;
  let enabled = true;
  const save = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const controller = new AutosaveController({ save, isDirty: () => true, isAutosaveEnabled: () => enabled });
  controller.notifyDirty(true);
  await vi.advanceTimersByTimeAsync(DEFAULT_AUTOSAVE_DELAY_MS);
  enabled = false;
  controller.notifyDirty(false);
  finish(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(save).toHaveBeenCalledTimes(1);
  expect(controller.hasPendingSave).toBe(false);
});
it("removes a recovery copy when undo returns to the saved state", () => {
  const storage = new Map<string, string>();
  const adapter = { setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  syncRecoveryStorage(adapter, "key", "dirty snapshot");
  expect(storage.get("key")).toBe("dirty snapshot");
  syncRecoveryStorage(adapter, "key", null);
  expect(storage.has("key")).toBe(false);
});

it("saves pending edits before a schedule mutation", async () => {
  const calls: string[] = [];
  let dirty = true;
  const ok = await prepareScheduleMutation({ waitForSave: async () => { calls.push("wait"); }, isDirty: () => dirty, save: async () => { calls.push("save"); dirty = false; return true; }, resume: () => { calls.push("resume"); } });
  expect(ok).toBe(true);
  expect(calls).toEqual(["wait", "save"]);
});

it("aborts a schedule mutation and resumes autosave if the save fails", async () => {
  const resume = vi.fn();
  const ok = await prepareScheduleMutation({ waitForSave: async () => {}, isDirty: () => true, save: async () => false, resume });
  expect(ok).toBe(false);
  expect(resume).toHaveBeenCalledOnce();
});

it("keeps newer local edits when an older in-flight save succeeds", () => {
  const storage = new Map([["key", "newer edit"]]);
  const adapter = { removeItem: (key: string) => { storage.delete(key); } };
  clearRecoveryAfterSave(adapter, "key", true);
  expect(storage.get("key")).toBe("newer edit");
  clearRecoveryAfterSave(adapter, "key", false);
  expect(storage.has("key")).toBe(false);
});
