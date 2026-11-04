/**
 * Autosave coordination: pure policy, versioned recovery snapshots and a
 * timer coordinator shared by the editor.
 *
 * Responsibilities are split so the tricky parts stay unit-testable:
 *
 * - `autosaveDecision` is the pure policy: given the LIVE editor setting and
 *   the dirty flag, should a change go to the server (`save`), stay in the
 *   browser (`store-locally-only`) or be ignored (`skip`)? The server snapshot
 *   is never consulted here, which is what makes turning autosave off take
 *   effect immediately in the current session.
 * - `AutosaveController` owns timing: debounce, coalescing edits that land
 *   while a save is in flight (via the `isDirty` re-check, so they are never
 *   stranded), and bounded retries with backoff. It never touches storage or
 *   React state directly.
 * - Recovery snapshots are the local safety net. Every committed change is
 *   mirrored to localStorage synchronously; on load `shouldOfferRecovery`
 *   offers differing snapshots, so possible unsaved work survives clock skew
 *   and server metadata changes; identical copies do not prompt.
 */
import { z } from "zod";
import { eventSchema, settingsSchema, type ScheduleEvent, type ScheduleSettings } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface AutosaveInput {
  /** Live editor setting. */
  autosaveEnabled: boolean;
  /** True when the editor state differs from the last persisted state. */
  dirty: boolean;
}

export type AutosaveDecision = "save" | "store-locally-only" | "skip";

export function autosaveDecision({ autosaveEnabled, dirty }: AutosaveInput): AutosaveDecision {
  if (!dirty) return "skip";
  // With autosave off we still keep a local recovery copy: nothing is lost when
  // the browser is refreshed, and the user can save explicitly.
  return autosaveEnabled ? "save" : "store-locally-only";
}

// ---------------------------------------------------------------------------
// State signatures (dirty detection shared by the editor and recovery)
// ---------------------------------------------------------------------------

/** Short, comparable fingerprint of the editable state. */
export function editorSignature(events: ScheduleEvent[], settings: ScheduleSettings): string {
  return JSON.stringify({ e: events, s: settings });
}

// ---------------------------------------------------------------------------
// Recovery snapshots (localStorage payloads)
// ---------------------------------------------------------------------------

export const RECOVERY_STORAGE_VERSION = 1 as const;

/** Kept for callers that read the old recovery tolerance; it is no longer used to discard work. */
export const RECOVERY_NEWER_TOLERANCE_MS = 1500;

const recoverySnapshotSchema = z.object({
  version: z.literal(RECOVERY_STORAGE_VERSION),
  scheduleId: z.string().min(1),
  clientUpdatedAt: z.number().finite(),
  events: z.array(eventSchema),
  settings: settingsSchema,
  description: z.string(),
  signature: z.string().min(1),
});

export type RecoverySnapshot = z.infer<typeof recoverySnapshotSchema>;

/** Payloads written before versioning carried no `version`/`signature` fields. */
const legacyRecoverySnapshotSchema = z.object({
  scheduleId: z.string().min(1),
  clientUpdatedAt: z.number().finite(),
  events: z.array(eventSchema),
  settings: settingsSchema,
  description: z.string().optional().default(""),
});

export function encodeRecoverySnapshot(input: {
  scheduleId: string;
  clientUpdatedAt: number;
  events: ScheduleEvent[];
  settings: ScheduleSettings;
  description: string;
}): RecoverySnapshot {
  return {
    version: RECOVERY_STORAGE_VERSION,
    scheduleId: input.scheduleId,
    clientUpdatedAt: input.clientUpdatedAt,
    events: input.events,
    settings: input.settings,
    description: input.description,
    signature: editorSignature(input.events, input.settings),
  };
}

/**
 * Parse a stored snapshot. Never throws: corrupt payloads yield `null` (the
 * caller drops them and the server state stands), legacy payloads are
 * migrated to the current shape.
 */
export function decodeRecoverySnapshot(raw: string): RecoverySnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const current = recoverySnapshotSchema.safeParse(parsed);
  if (current.success) return current.data;
  const legacy = legacyRecoverySnapshotSchema.safeParse(parsed);
  if (!legacy.success) return null;
  return encodeRecoverySnapshot({
    scheduleId: legacy.data.scheduleId,
    clientUpdatedAt: legacy.data.clientUpdatedAt,
    events: legacy.data.events,
    settings: legacy.data.settings,
    description: legacy.data.description,
  });
}

export function shouldOfferRecovery(input: {
  snapshot: RecoverySnapshot;
  scheduleId: string;
  serverUpdatedAtMs: number;
  serverSignature: string;
}): boolean {
  if (input.snapshot.scheduleId !== input.scheduleId) return false;
  if (!Number.isFinite(input.serverUpdatedAtMs)) return false;
  // A differing local copy may contain unsaved work even if clocks differ or
  // server metadata changed later. Let the user choose instead of deleting it.
  // A debounced save may have landed already
  // (e.g. via the tab-close flush), in which case there is nothing to recover.
  if (input.snapshot.signature === input.serverSignature) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Save scheduler
// ---------------------------------------------------------------------------

export const DEFAULT_AUTOSAVE_DELAY_MS = 1100;
export const DEFAULT_AUTOSAVE_RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 10000];

export interface AutosaveControllerOptions {
  delayMs?: number;
  retryDelaysMs?: readonly number[];
  /** Runs one save; resolves `true` when the server accepted the state. Never throws to the controller. */
  save: () => Promise<boolean>;
  /** True when the editor still differs from the last persisted state. Read after every save to chain follow-ups. */
  isDirty: () => boolean;
  /** Live editor setting, read whenever a follow-up save is considered. */
  isAutosaveEnabled: () => boolean;
  /** Called once when the retry budget is exhausted (failures before that stay silent). */
  onExhausted?: () => void;
}

/**
 * Debounced, self-healing save scheduler.
 *
 * - `notifyDirty` (re)starts the debounce timer; in local-only mode it drops
 *   any pending server save instead, so toggling autosave off takes effect
 *   immediately.
 * - Edits that land while a save is in flight are picked up by the
 *   post-save `isDirty` re-check and chained into a follow-up save instead
 *   of being stranded.
 * - Failed saves are retried with backoff; when the budget runs out the
 *   controller goes quiet until the next edit and reports once via
 *   `onExhausted` (no toast spam, no infinite retry loop against a dead server).
 */
export class AutosaveController {
  private readonly delayMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly saveFn: () => Promise<boolean>;
  private readonly isDirtyFn: () => boolean;
  private readonly isAutosaveEnabledFn: () => boolean;
  private readonly onExhausted?: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private failures = 0;
  private disposed = false;

  constructor(options: AutosaveControllerOptions) {
    this.delayMs = options.delayMs ?? DEFAULT_AUTOSAVE_DELAY_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_AUTOSAVE_RETRY_DELAYS_MS;
    this.saveFn = options.save;
    this.isDirtyFn = options.isDirty;
    this.isAutosaveEnabledFn = options.isAutosaveEnabled;
    this.onExhausted = options.onExhausted;
  }

  /** True while a debounced save or a backoff retry is waiting to run. */
  get hasPendingSave(): boolean {
    return this.timer !== null;
  }

  /**
   * Report an edit; `autosaveEnabled` must be the live editor setting.
   * The caller always refreshes the local recovery copy first.
   */
  notifyDirty(autosaveEnabled: boolean): void {
    if (this.disposed) return;
    if (autosaveDecision({ autosaveEnabled, dirty: true }) !== "save") {
      this.cancel();
      return;
    }
    // A save is running: don't stack timers, the post-save isDirty re-check
    // chains a follow-up when these edits are still unsaved.
    if (this.inFlight) return;
    // Fresh user activity starts a new streak: normal debounce, retry budget reset.
    this.failures = 0;
    this.restartTimer(this.delayMs);
  }

  /** Re-check dirtiness after an out-of-band (manual) save and chain when needed. */
  notifyIfDirty(): void {
    if (this.disposed || this.inFlight) return;
    if (this.isDirtyFn()) this.notifyDirty(this.isAutosaveEnabledFn());
  }

  /** Drop any pending debounced save or backoff retry. In-flight saves run to completion. */
  cancel(): void {
    this.clearTimer();
    this.failures = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private restartTimer(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) {
      // Unreachable in normal flow (notifyDirty never stacks timers during a
      // flight), but self-heal instead of stranding the save.
      this.restartTimer(this.delayMs);
      return;
    }
    this.inFlight = true;
    let ok = false;
    try {
      ok = await this.saveFn();
    } catch {
      ok = false;
    }
    this.inFlight = false;
    if (this.disposed) return;
    if (ok) {
      this.failures = 0;
      // The editor may have changed while the save was in flight: chain a
      // follow-up instead of stranding those edits.
      if (this.isDirtyFn()) this.notifyDirty(this.isAutosaveEnabledFn());
      return;
    }
    if (!this.isAutosaveEnabledFn() || !this.isDirtyFn()) {
      this.failures = 0;
      return;
    }
    const backoff = this.retryDelaysMs[this.failures];
    this.failures += 1;
    if (backoff === undefined) {
      this.failures = 0;
      try {
        this.onExhausted?.();
      } catch {
        /* reporting must never break the scheduler */
      }
      return;
    }
    this.restartTimer(backoff);
  }
}

/** Keep the recovery copy in step with whether the editor differs from the server. */
export function syncRecoveryStorage(storage: Pick<Storage, "setItem" | "removeItem">, key: string, value: string | null): void {
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
}

/** Wait for any existing save and persist pending edits before switching schedules. */
export async function prepareScheduleMutation(options: {
  waitForSave: () => Promise<unknown>;
  isDirty: () => boolean;
  save: () => Promise<boolean>;
  resume: () => void;
}): Promise<boolean> {
  await options.waitForSave();
  while (options.isDirty()) {
    if (!await options.save()) {
      options.resume();
      return false;
    }
  }
  return true;
}

/** An older successful save must not erase recovery for edits made during it. */
export function clearRecoveryAfterSave(storage: Pick<Storage, "removeItem">, key: string, stillDirty: boolean): void {
  if (!stillDirty) storage.removeItem(key);
}
