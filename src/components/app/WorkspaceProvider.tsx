"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, apiRequest, setApiWorkspaceIdentity, uuid } from "@/lib/client/api";
import { useI18n } from "@/components/app/LanguageProvider";
import type { DictionaryKey, TranslateVars, Translator } from "@/lib/i18n";
import type {
  ClassType,
  Conflict,
  Room,
  Schedule,
  ScheduleEvent,
  ScheduleSettings,
  Trainer,
  VersionSummary,
  Workspace,
} from "@/lib/domain/types";
import {
  applyAction,
  createHistory,
  historyReducer,
  type EditorAction,
  type EditorState,
} from "@/lib/schedule/editor";
import {
  AutosaveController,
  decodeRecoverySnapshot,
  editorSignature,
  encodeRecoverySnapshot,
  shouldOfferRecovery,
  syncRecoveryStorage,
  clearRecoveryAfterSave,
  prepareScheduleMutation,
} from "@/lib/schedule/autosave";
import { validateSchedule } from "@/lib/schedule/validation";

/** Keepalive tab-close flushes cap bodies (~64KB); the signature length is a cheap size proxy. */
const FLUSH_MAX_BODY_LENGTH = 50000;

export type SaveStatus = "idle" | "saving" | "saved" | "error";

interface PersistOptions {
  description?: string;
  snapshot?: boolean;
  publish?: boolean;
  silent?: boolean;
  keepalive?: boolean;
}

export interface LocalRecovery {
  scheduleId: string;
  clientUpdatedAt: number;
  events: ScheduleEvent[];
  settings: ScheduleSettings;
  description: string;
  storageKey: string;
  storedValue: string;
}

export interface ToastMessage {
  id: number;
  message: string;
  kind: "success" | "error" | "info" | "warning";
}

interface WorkspaceContextValue {
  loading: boolean;
  mutationBusy: boolean;
  loadError: string | null;
  workspace: Workspace | null;
  schedule: Schedule | null;
  events: ScheduleEvent[];
  settings: ScheduleSettings;
  trainers: Trainer[];
  classTypes: ClassType[];
  rooms: Room[];
  versions: VersionSummary[];
  conflicts: Conflict[];
  canUndo: boolean;
  canRedo: boolean;
  saveStatus: SaveStatus;
  savedAt: string | null;
  dirty: boolean;
  saveConflict: boolean;
  dispatch: (action: EditorAction) => void;
  applyTransient: (action: EditorAction) => void;
  commit: (action: EditorAction, base: EditorState) => void;
  editorState: EditorState;
  runUndo: () => void;
  runRedo: () => void;
  saveNow: (options?: { description?: string; snapshot?: boolean; publish?: boolean }) => Promise<boolean>;
  reload: (scheduleId?: string) => Promise<boolean>;
  /**
   * Trainer save = metadata + eligibility checkboxes in ONE atomic request;
   * `false` means nothing changed (the error toast is already shown).
   */
  saveTrainerWithClasses: (trainer: Trainer, classTypeIds: string[]) => Promise<boolean>;
  removeTrainer: (id: string) => Promise<boolean>;
  saveClassType: (classType: ClassType) => Promise<boolean>;
  removeClassType: (id: string) => Promise<boolean>;
  /** Batch reorder: the whole list order or nothing. */
  reorderTrainers: (order: string[]) => Promise<boolean>;
  reorderClassTypes: (order: string[]) => Promise<boolean>;
  saveRoom: (room: Room) => Promise<void>;
  removeRoom: (id: string) => Promise<void>;
  scheduleAction: (
    action: "create" | "template" | "duplicate" | "rename" | "archive" | "unarchive" | "activate" | "delete",
    payload?: { id?: string; name?: string; sourceId?: string; withoutEvents?: boolean },
  ) => Promise<boolean>;
  importBackup: (backup: unknown, mode: "merge" | "replace", targetId?: string) => Promise<{ schedules: number; events: number; mode: string }>;
  restoreProjectArchive: (archiveBase64: string) => Promise<boolean>;
  createSnapshot: (description: string) => Promise<boolean>;
  restoreVersion: (versionId: string) => Promise<void>;
  toast: (message: string, kind?: ToastMessage["kind"]) => void;
  toastKey: (key: DictionaryKey, vars?: TranslateVars, kind?: ToastMessage["kind"]) => void;
  t: Translator;
  toasts: ToastMessage[];
  dismissToast: (id: number) => void;
  recovery: LocalRecovery | null;
  acceptRecovery: () => void;
  discardRecovery: () => void;
  actionDialog: EditorActionState | null;
  setActionDialog: (state: EditorActionState | null) => void;
}

export interface EditorActionState {
  mode: "create" | "edit" | "duplicate";
  event?: ScheduleEvent;
  dayOfWeek?: number;
  startTime?: string;
  endTime?: string;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function recoveryKey(scheduleId: string, workspaceId?: string, sessionId?: string): string {
  const prefix = workspaceId ? `tn:recovery:${workspaceId}:${scheduleId}` : `tn:recovery:${scheduleId}`;
  return sessionId ? `${prefix}:${sessionId}` : prefix;
}

/** Applies a confirmed batch order locally, exactly as the server stored it. */
function withOrder<T extends { id: string; name: string; sortOrder: number }>(rows: T[], order: string[]): T[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return rows
    .map((row) => (positions.has(row.id) ? { ...row, sortOrder: positions.get(row.id) as number } : row))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/**
 * One move = one request. The whole list order is applied server-side in a
 * single transaction; the local list is only touched once the server confirmed
 * it, so a failure can never leave a half-applied order behind.
 */
async function requestReorder(
  entity: "trainers" | "classTypes",
  order: string[],
  report: (error: unknown) => void,
  hallId?: string,
): Promise<boolean> {
  try {
    await apiRequest(`/api/workspace/reorder${hallId ? `?hallId=${encodeURIComponent(hallId)}` : ""}`, { json: { entity, order } });
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutationBusy, setMutationBusy] = useState(false);
  const mutationBusyRef = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, dispatchHistory] = useReducer(historyReducer, createHistory({ events: [], settings: defaultSettings() }));
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const saveConflictRef = useRef(false);
  const [initialRecoverySession] = useState(uuid);
  const recoverySessionRef = useRef(initialRecoverySession);
  const acceptedRecoveryRef = useRef<LocalRecovery | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [recovery, setRecovery] = useState<LocalRecovery | null>(null);
  const [actionDialog, setActionDialog] = useState<EditorActionState | null>(null);

  const workspaceIdentityRef = useRef<string | undefined>(undefined);
  const workspaceRef = useRef<Workspace | null>(null);
  const revisionRef = useRef<number | undefined>(undefined);
  const reloadToken = useRef(0);
  const reloadBusyRef = useRef(false);
  const pendingDescription = useRef<string>("");
  const lastSavedSignature = useRef<string>("");
  const stateRef = useRef<EditorState>(history.present);
  // Serializes saves so results always land in order: a slow request can never
  // overwrite the results of a newer one.
  const flightRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const savingRef = useRef(false);
  const lastSaveError = useRef<string | null>(null);
  const persistRef = useRef<(options?: PersistOptions) => Promise<boolean>>(async () => false);
  const toastKeyRef = useRef<WorkspaceContextValue["toastKey"]>(() => {});

  // Stable scheduler wiring: timer callbacks always see post-commit values via refs.
  const autosaveSave = useCallback(
    () => persistRef.current({ description: pendingDescription.current, silent: true }),
    [],
  );
  const autosaveIsDirty = useCallback(
    () => editorSignature(stateRef.current.events, stateRef.current.settings) !== lastSavedSignature.current,
    [],
  );
  const autosaveIsEnabled = useCallback(() => stateRef.current.settings.autosave && !saveConflictRef.current, []);
  // Autosave attempts stay silent (retries would spam); one failure surfaces
  // only when the retry budget is exhausted.
  const autosaveExhausted = useCallback(() => {
    const message = lastSaveError.current;
    toastKeyRef.current(
      message ? "toast.saveFailed" : "toast.saveFailedPlain",
      { message: message ?? "" },
      "error",
    );
  }, []);
  // The scheduler lives outside render: created once on mount, disposed on unmount.
  const controllerRef = useRef<AutosaveController | null>(null);
  useEffect(() => {
    const created = new AutosaveController({
      save: autosaveSave,
      isDirty: autosaveIsDirty,
      isAutosaveEnabled: autosaveIsEnabled,
      onExhausted: autosaveExhausted,
    });
    controllerRef.current = created;
    return () => {
      created.dispose();
      controllerRef.current = null;
    };
  }, [autosaveExhausted, autosaveIsDirty, autosaveIsEnabled, autosaveSave]);

  const toast = useCallback((message: string, kind: ToastMessage["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, kind }]);
    setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 6000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toastKey = useCallback(
    (key: DictionaryKey, vars?: TranslateVars, kind: ToastMessage["kind"] = "info") => {
      toast(t(key, vars), kind);
    },
    [t, toast],
  );

  const signatureOf = (state: EditorState) => editorSignature(state.events, state.settings);

  const applyWorkspace = useCallback(
    (data: Workspace, options?: { fromRecovery?: boolean }) => {
      workspaceIdentityRef.current = data.workspaceId;
      setApiWorkspaceIdentity(data.workspaceId);
      workspaceRef.current = data;
      revisionRef.current = data.revision;
      acceptedRecoveryRef.current = null;
      saveConflictRef.current = false;
      setSaveConflict(false);
      stateRef.current = { events: data.state.events, settings: data.state.settings };
      setActionDialog(null);
      setWorkspace(data);
      dispatchHistory({
        action: {
          type: "replace",
          state: { events: data.state.events, settings: data.state.settings },
          description: t("history.loaded"),
          history: false,
        },
        record: false,
      });
      lastSavedSignature.current = signatureOf({ events: data.state.events, settings: data.state.settings });
      setDirty(false);
      setSaveStatus("idle");

      if (!options?.fromRecovery) {
        // A fresh server state is showing: any previous banner is stale.
        setRecovery(null);
        const prefix = recoveryKey(data.activeScheduleId, workspaceIdentityRef.current);
        try {
          // Each editor writes its own slot. Discover earlier sessions without
          // deleting another tab's pending edits (including the legacy slot).
          const candidates: LocalRecovery[] = [];
          for (const key of Object.keys(window.localStorage).filter(key => key === prefix || key.startsWith(`${prefix}:`))) {
            const raw = window.localStorage.getItem(key);
            const snapshot = raw ? decodeRecoverySnapshot(raw) : null;
            if (snapshot && shouldOfferRecovery({
                snapshot,
                scheduleId: data.activeScheduleId,
                serverUpdatedAtMs: new Date(data.state.schedule.updatedAt).getTime(),
                serverSignature: signatureOf({ events: data.state.events, settings: data.state.settings }),
              })) {
              candidates.push({
                scheduleId: snapshot.scheduleId,
                clientUpdatedAt: snapshot.clientUpdatedAt,
                events: snapshot.events,
                settings: snapshot.settings,
                description: snapshot.description,
                storageKey: key,
                storedValue: raw!,
              });
            }
          }
          candidates.sort((a, b) => b.clientUpdatedAt - a.clientUpdatedAt);
          setRecovery(candidates[0] ?? null);
        } catch {
          // Storage unavailable: the server state still loads, recovery just skips.
        }
      }
    },
    [t],
  );

  const reload = useCallback(
    async (scheduleId?: string, replaceLocal = false): Promise<boolean> => {
      const token = ++reloadToken.current;
      reloadBusyRef.current = true;
      setLoading(true);
      try {
        // Coordinate with saves: drop pending autosaves and let an in-flight
        // save land first, so we reload post-save state instead of racing it.
        controllerRef.current?.cancel();
        await flightRef.current;
        if (!replaceLocal && workspaceRef.current && autosaveIsDirty()) {
          if (!saveConflictRef.current) {
            if (!stateRef.current.settings.autosave && !window.confirm(t("halls.saveBeforeSwitch"))) return false;
            if (!await persistRef.current() && !saveConflictRef.current) return false;
          }
          if (saveConflictRef.current) {
            if (!window.confirm(t("recovery.conflictReload"))) return false;
            // Do not replace the editor unless its exact current state is
            // safely recoverable. A new slot keeps subsequent clean/save
            // cleanup from removing this preserved conflict.
            const current = stateRef.current;
            try {
              window.localStorage.setItem(recoveryKey(workspaceRef.current.activeScheduleId, workspaceIdentityRef.current, recoverySessionRef.current), JSON.stringify(encodeRecoverySnapshot({
                scheduleId: workspaceRef.current.activeScheduleId, clientUpdatedAt: Date.now(),
                events: current.events, settings: current.settings, description: pendingDescription.current,
              })));
            } catch { throw new Error(t("recovery.storageUnavailable")); }
            recoverySessionRef.current = uuid();
          }
        }
        const data = await apiRequest<Workspace>(`/api/workspace${scheduleId ? `?scheduleId=${scheduleId}` : ""}`);
        if (token !== reloadToken.current) return false;
        applyWorkspace(data);
        setLoadError(null);
        return true;
      } catch (error) {
        if (token === reloadToken.current) setLoadError(error instanceof Error ? error.message : t("state.workspaceFailed"));
        return false;
      } finally {
        if (token === reloadToken.current) { reloadBusyRef.current = false; setLoading(false); }
      }
    },
    [applyWorkspace, t, autosaveIsDirty],
  );

  // Start the load from a promise reaction (the same async boundary as
  // `fetch(...).then(...)`): `reload` begins with state updates, and invoking
  // it synchronously inside the effect would cascade renders during the
  // effect flush. The reaction runs right after that flush — before any timer
  // or input event can interleave — so load triggers and timing are unchanged.
  const initialReload = useRef(reload);
  useEffect(() => {
    void Promise.resolve().then(() => initialReload.current());
  }, []);

  const doPersist = useCallback(
    async (options?: PersistOptions): Promise<boolean> => {
      const current = stateRef.current;
      const scheduleId = workspace?.activeScheduleId;
      if (!scheduleId) return false;
      if (saveConflictRef.current) return false;

      savingRef.current = true;
      setSaveStatus("saving");
      try {
        const result = await apiRequest<{ savedAt: string; versionCreated: VersionSummary | null; revision?: number }>(
          "/api/workspace/state",
          {
            method: "PUT",
            json: {
              scheduleId,
              hallId: workspaceRef.current?.hallId,
              revision: revisionRef.current,
              events: current.events,
              settings: current.settings,
              status: options?.publish ? "published" : undefined,
              changeDescription: options?.description || pendingDescription.current || undefined,
              snapshot: options?.snapshot ?? options?.publish ?? false,
            },
            keepalive: options?.keepalive,
          },
        );
        revisionRef.current = result.revision;
        const savedSignature = signatureOf(current);
        lastSavedSignature.current = savedSignature;
        // The editor may have moved on while the request was in flight:
        // reconcile against the live state instead of blindly clearing dirty.
        const stillDirty = signatureOf(stateRef.current) !== savedSignature;
        setDirty(stillDirty);
        setSaveStatus("saved");
        setSavedAt(result.savedAt);
        pendingDescription.current = "";
        lastSaveError.current = null;
        try {
          // Clean save: the server holds this state now, no recovery copy needed.
          clearRecoveryAfterSave(window.localStorage, recoveryKey(scheduleId, workspaceIdentityRef.current, recoverySessionRef.current), stillDirty);
          const accepted = acceptedRecoveryRef.current;
          if (!stillDirty && accepted && accepted.scheduleId === scheduleId && window.localStorage.getItem(accepted.storageKey) === accepted.storedValue) {
            window.localStorage.removeItem(accepted.storageKey);
          }
          if (!stillDirty) acceptedRecoveryRef.current = null;
        } catch {
          /* storage unavailable — not fatal */
        }
        setWorkspace((prev) =>
          prev
            ? {
                ...prev,
                state: { ...prev.state, schedule: options?.publish ? { ...prev.state.schedule, status: "published" } : { ...prev.state.schedule, status: "draft" } },
                versions: result.versionCreated ? [result.versionCreated, ...prev.versions] : prev.versions,
              }
            : prev,
        );
        // Chain a follow-up when the editor moved during the save (or this was
        // a manual save) instead of stranding those edits.
        controllerRef.current?.notifyIfDirty();
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          saveConflictRef.current = true;
          setSaveConflict(true);
          controllerRef.current?.cancel();
        }
        const message = error instanceof Error ? error.message : "";
        lastSaveError.current = message;
        setSaveStatus("error");
        if (!options?.silent) {
          toastKey(message ? "toast.saveFailed" : "toast.saveFailedPlain", { message }, "error");
        }
        return false;
      } finally {
        savingRef.current = false;
      }
    },
    [toastKey, workspace?.activeScheduleId],
  );

  const persist = useCallback(
    (options?: PersistOptions): Promise<boolean> => {
      // Serialize saves: each save runs against the latest editor state and
      // results land in order, so overlapping autosave/manual saves converge
      // instead of overwriting each other.
      const run = flightRef.current.then(
        () => doPersist(options),
        () => doPersist(options),
      );
      flightRef.current = run.catch(() => false);
      return run;
    },
    [doPersist],
  );

  // Timer/closure mirrors track post-commit values (refs are never written during render).
  useEffect(() => {
    stateRef.current = history.present;
    persistRef.current = persist;
    toastKeyRef.current = toastKey;
  });

  // Autosave: every change is mirrored to local recovery storage synchronously,
  // then scheduled for the server (debounced) while autosave is on. The
  // controller coalesces edits that land mid-save and retries failures.
  useEffect(() => {
    if (!workspace || workspace.empty) return;
    const scheduler = controllerRef.current;
    if (!scheduler) return;
    const present = history.present;
    if (signatureOf(present) === lastSavedSignature.current) {
      scheduler.cancel();
      setDirty(false);
      try {
        syncRecoveryStorage(window.localStorage, recoveryKey(workspace.activeScheduleId, workspaceIdentityRef.current, recoverySessionRef.current), null);
      } catch { /* storage unavailable */ }
      return;
    }
    setDirty(true);

    const scheduleId = workspace.activeScheduleId;
    try {
      syncRecoveryStorage(
        window.localStorage,
        recoveryKey(scheduleId, workspaceIdentityRef.current, recoverySessionRef.current),
        JSON.stringify(
          encodeRecoverySnapshot({
            scheduleId,
            clientUpdatedAt: Date.now(),
            events: present.events,
            settings: present.settings,
            description: pendingDescription.current,
          }),
        ),
      );
    } catch {
      /* ignore quota errors */
    }

    // The live editor setting is authoritative: turning autosave off takes
    // effect immediately instead of waiting for a save round-trip.
    scheduler.notifyDirty(present.settings.autosave && !saveConflictRef.current);
  }, [history.present, workspace, recovery]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (saveStatus === "saving" || dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, saveStatus]);

  // Best-effort tab-close flush: a debounced save still waiting when the tab
  // closes would otherwise survive only as a local recovery copy. A keepalive
  // request lets it land on the server; if it fails the recovery copy stands.
  useEffect(() => {
    const flush = () => {
      const scheduler = controllerRef.current;
      if (!scheduler?.hasPendingSave || savingRef.current) return;
      const state = stateRef.current;
      if (!state.settings.autosave) return;
      if (editorSignature(state.events, state.settings).length > FLUSH_MAX_BODY_LENGTH) return;
      scheduler.cancel();
      void persistRef.current({ description: pendingDescription.current, silent: true, keepalive: true });
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const dispatch = useCallback(
    (action: EditorAction) => {
      if (mutationBusyRef.current || reloadBusyRef.current) return;
      const preview = applyAction(stateRef.current, action, t);
      if (preview.description) pendingDescription.current = preview.description;
      dispatchHistory({ action, translate: t });
    },
    [t],
  );

  const applyTransient = useCallback(
    (action: EditorAction) => {
      if (mutationBusyRef.current || reloadBusyRef.current) return;
      dispatchHistory({ action, record: false, translate: t });
    },
    [t],
  );

  const commit = useCallback(
    (action: EditorAction, base: EditorState) => {
      if (mutationBusyRef.current || reloadBusyRef.current) return;
      const preview = applyAction(base, action, t);
      if (preview.description) pendingDescription.current = preview.description;
      dispatchHistory({ action, base, translate: t });
    },
    [t],
  );

  const runUndo = useCallback(() => {
    if (mutationBusyRef.current || reloadBusyRef.current) return;
    pendingDescription.current = t("history.undo");
    dispatchHistory({ undo: true });
  }, [t]);

  const runRedo = useCallback(() => {
    if (mutationBusyRef.current || reloadBusyRef.current) return;
    pendingDescription.current = t("history.redo");
    dispatchHistory({ redo: true });
  }, [t]);

  /**
   * Surfaces a failed administrative mutation through the existing toast UI.
   * Server messages are already localized and actionable ("nothing was
   * changed" wording); the fallback key covers transport-level failures.
   */
  const reportFailure = useCallback(
    (error: unknown, fallbackKey: DictionaryKey) => {
      const message = error instanceof Error && error.message.trim().length > 0 ? error.message : t(fallbackKey);
      toast(message, "error");
    },
    [t, toast],
  );

  const saveTrainerWithClasses = useCallback(
    async (trainer: Trainer, classTypeIds: string[]): Promise<boolean> => {
      const contextHall = workspaceRef.current?.hallId;
      // ONE atomic request: the trainer row and every class link this save
      // touches either all change or none do. The UI (same form, same
      // checkboxes, same Save button) never sees a partial result.
      try {
        await apiRequest(`/api/workspace/trainers${workspaceRef.current?.hallId ? `?hallId=${encodeURIComponent(workspaceRef.current.hallId)}` : ""}`, { json: { trainer, classTypeIds } });
      } catch (error) {
        reportFailure(error, "api.trainerSaveFailed");
        return false;
      }
      if (contextHall !== workspaceRef.current?.hallId) return true;
      setWorkspace((prev) =>
        prev
          ? {
              ...prev,
              trainers: [...prev.trainers.filter((item) => item.id !== trainer.id), trainer].sort(
                (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
              ),
              // The server reconciled this trainer's links; mirror exactly that.
              classTypes: prev.classTypes.map((classType) => {
                const shouldHave = classTypeIds.includes(classType.id);
                const has = classType.trainerIds.includes(trainer.id);
                if (shouldHave === has) return classType;
                return {
                  ...classType,
                  trainerIds: shouldHave
                    ? [...classType.trainerIds, trainer.id]
                    : classType.trainerIds.filter((id) => id !== trainer.id),
                };
              }),
            }
          : prev,
      );
      return true;
    },
    [reportFailure],
  );

  const reorderTrainers = useCallback(
    async (order: string[]): Promise<boolean> => {
      const contextHall = workspaceRef.current?.hallId;
      const ok = await requestReorder("trainers", order, (error) => reportFailure(error, "api.reorderFailed"), workspaceRef.current?.hallId);
      if (!ok) return false;
      if (contextHall !== workspaceRef.current?.hallId) return true;
      setWorkspace((prev) => (prev ? { ...prev, trainers: withOrder(prev.trainers, order) } : prev));
      toastKey("toast.orderSaved", undefined, "success");
      return true;
    },
    [reportFailure, toastKey],
  );

  const reorderClassTypes = useCallback(
    async (order: string[]): Promise<boolean> => {
      const contextHall = workspaceRef.current?.hallId;
      const ok = await requestReorder("classTypes", order, (error) => reportFailure(error, "api.reorderFailed"), contextHall);
      if (!ok) return false;
      if (contextHall !== workspaceRef.current?.hallId) return true;
      setWorkspace((prev) => (prev ? { ...prev, classTypes: withOrder(prev.classTypes, order) } : prev));
      toastKey("toast.orderSaved", undefined, "success");
      return true;
    },
    [reportFailure, toastKey],
  );

  const removeCatalog = useCallback(async (entity: "trainers" | "class-types", id: string): Promise<boolean> => {
    if (mutationBusyRef.current || reloadBusyRef.current) return false;
    const contextHall = workspaceRef.current?.hallId;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    try {
      controllerRef.current?.cancel();
      if (autosaveIsDirty() && !stateRef.current.settings.autosave && !window.confirm(t("manage.saveBeforeDelete"))) return false;
      if (!await prepareScheduleMutation({
        waitForSave: async () => { await flightRef.current; controllerRef.current?.cancel(); },
        isDirty: autosaveIsDirty,
        save: () => persist(),
        resume: () => controllerRef.current?.notifyIfDirty(),
      })) return false;
      await apiRequest(`/api/workspace/${entity}?id=${encodeURIComponent(id)}${contextHall ? `&hallId=${encodeURIComponent(contextHall)}&revision=${revisionRef.current}` : ""}`, {method:"DELETE"});
      // The server removed events and advanced the revision as well as deleting
      // metadata. Replace the entire local state/undo stack, never just its list.
      if (!await reload(contextHall, true)) return false;
      toastKey(entity === "trainers" ? "toast.trainerDeleted" : "toast.classTypeRemoved", undefined, "success");
      return true;
    } catch (error) {
      reportFailure(error, entity === "trainers" ? "api.trainerDeleteFailed" : "api.classTypeDeleteFailed");
      controllerRef.current?.notifyIfDirty();
      return false;
    } finally {
      mutationBusyRef.current = false;
      setMutationBusy(false);
    }
  }, [autosaveIsDirty, persist, reload, reportFailure, t, toastKey]);

  const removeTrainer = useCallback((id: string) => removeCatalog("trainers",id), [removeCatalog]);

  const saveClassType = useCallback(
    async (classType: ClassType): Promise<boolean> => {
      const contextHall = workspaceRef.current?.hallId;
      // Metadata + trainer links are written atomically server-side: `false`
      // means nothing changed and the error toast is already shown.
      try {
        await apiRequest(`/api/workspace/class-types${workspaceRef.current?.hallId ? `?hallId=${encodeURIComponent(workspaceRef.current.hallId)}` : ""}`, { json: classType });
      } catch (error) {
        reportFailure(error, "api.classTypeSaveFailed");
        return false;
      }
      if (contextHall !== workspaceRef.current?.hallId) return true;
      setWorkspace((prev) =>
        prev
          ? {
              ...prev,
              classTypes: [...prev.classTypes.filter((item) => item.id !== classType.id), classType].sort(
                (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
              ),
            }
          : prev,
      );
      toastKey("toast.classSaved", { name: classType.name }, "success");
      return true;
    },
    [reportFailure, toastKey],
  );

  const removeClassType = useCallback((id: string) => removeCatalog("class-types",id), [removeCatalog]);

  const saveRoom = useCallback(
    async (room: Room) => {
      await apiRequest("/api/workspace/rooms", { json: room });
      setWorkspace((prev) =>
        prev
          ? {
              ...prev,
              rooms: [...prev.rooms.filter((item) => item.id !== room.id), room].sort(
                (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
              ),
            }
          : prev,
      );
      toastKey("toast.roomSaved", { name: room.name }, "success");
    },
    [toastKey],
  );

  const removeRoom = useCallback(
    async (id: string) => {
      await apiRequest(`/api/workspace/rooms?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setWorkspace((prev) => (prev ? { ...prev, rooms: prev.rooms.filter((item) => item.id !== id) } : prev));
      toastKey("toast.roomDeleted", undefined, "success");
    },
    [toastKey],
  );

  const scheduleAction = useCallback<WorkspaceContextValue["scheduleAction"]>(
    async (action, payload) => {
      if (mutationBusyRef.current) return false;
      mutationBusyRef.current = true;
      setMutationBusy(true);
      try {
      if (workspaceRef.current?.hallId && autosaveIsDirty() && !stateRef.current.settings.autosave && !window.confirm(t("halls.saveBeforeSwitch"))) return false;
      // Let an in-flight save land before mutating schedules server-side.
      controllerRef.current?.cancel();
      const prepared = await prepareScheduleMutation({
        waitForSave: () => flightRef.current,
        isDirty: autosaveIsDirty,
        save: () => persist(),
        resume: () => controllerRef.current?.notifyIfDirty(),
      });
      if (!prepared) return false;
      let result: { activeScheduleId: string | null };
      try {
        result = await apiRequest<{ activeScheduleId: string | null }>("/api/workspace/schedules", {
          json: { action, ...payload },
        });
      } catch (error) {
        // Server-side the mutation was rolled back (or never started): the
        // local state still matches the database, so nothing is applied here
        // and the operator is told why the action did not happen.
        reportFailure(error, action === "delete" ? "api.scheduleDeleteFailed" : "api.scheduleActionFailed");
        controllerRef.current?.notifyIfDirty();
        return false;
      }
      if (!await reload(result.activeScheduleId ?? undefined)) return false;
      const actionKeys: Record<string, DictionaryKey> = {
        create: "toast.scheduleCreated",
        template: "halls.demoCreated",
        duplicate: "toast.scheduleDuplicated",
        rename: "toast.scheduleRenamed",
        archive: "toast.scheduleArchived",
        unarchive: "toast.scheduleUnarchived",
        activate: "toast.scheduleActivated",
        delete: "toast.scheduleDeleted",
      };
      toastKey(actionKeys[action] ?? "toast.scheduleCreated", undefined, "success");
      return true;
      } finally {
        mutationBusyRef.current = false;
        setMutationBusy(false);
      }
    },
    [reload, reportFailure, toastKey, autosaveIsDirty, persist, t],
  );

  const createSnapshot = useCallback(
    async (description: string) => {
      const scheduleId = workspace?.activeScheduleId;
      if (!scheduleId) return false;
      // An explicit save supersedes any pending autosave.
      controllerRef.current?.cancel();
      const saved = await persist({ description, snapshot: true });
      if (saved) {
        const data = await apiRequest<Workspace>(`/api/workspace?scheduleId=${scheduleId}`);
        if (workspaceRef.current?.activeScheduleId !== scheduleId) return false;
        setWorkspace(data);
        toastKey("toast.snapshotCreated", undefined, "success");
        return true;
      }
      return false;
    },
    [persist, toastKey, workspace?.activeScheduleId],
  );

  const importBackup = useCallback<WorkspaceContextValue["importBackup"]>(
    async (backup, mode, targetId) => {
      if (mutationBusyRef.current) throw new Error(t("state.workspaceFailed"));
      mutationBusyRef.current = true;
      setMutationBusy(true);
      try {
        if (workspaceRef.current?.hallId && autosaveIsDirty() && !stateRef.current.settings.autosave && !window.confirm(t("halls.saveBeforeSwitch"))) throw new Error(t("common.cancel"));
        controllerRef.current?.cancel();
        const prepared = await prepareScheduleMutation({
          waitForSave: async () => { await flightRef.current; controllerRef.current?.cancel(); },
          isDirty: autosaveIsDirty,
          save: () => persist(),
          resume: () => controllerRef.current?.notifyIfDirty(),
        });
        if (!prepared) throw new Error(t("toast.saveFailedPlain"));
        let result: { schedules: number; events: number; mode: string };
        try {
          result = await apiRequest("/api/workspace/backup", { json: { mode, backup, targetId } });
        } catch (error) {
          controllerRef.current?.notifyIfDirty();
          throw error;
        }
        if (!await reload()) throw new Error(t("state.workspaceFailed"));
        return result;
      } finally {
        mutationBusyRef.current = false;
        setMutationBusy(false);
      }
    },
    [autosaveIsDirty, persist, reload, t],
  );

  const restoreProjectArchive = useCallback(async (archiveBase64: string): Promise<boolean> => {
    if (mutationBusyRef.current) return false;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    try {
      controllerRef.current?.cancel();
      if (autosaveIsDirty() && !stateRef.current.settings.autosave && !window.confirm(t("halls.saveBeforeSwitch"))) return false;
      if (!await prepareScheduleMutation({ waitForSave: () => flightRef.current, isDirty: autosaveIsDirty, save: () => persist(), resume: () => controllerRef.current?.notifyIfDirty() })) return false;
      await apiRequest("/api/workspace/project-archive", { json: { archiveBase64 } });
      if (!await reload(undefined, true)) return false;
      return true;
    } catch (error) {
      reportFailure(error, "api.scheduleActionFailed");
      controllerRef.current?.notifyIfDirty();
      return false;
    } finally {
      mutationBusyRef.current = false;
      setMutationBusy(false);
    }
  }, [autosaveIsDirty, persist, reload, reportFailure, t]);

  const restoreVersion = useCallback(
    async (versionId: string) => {
      if (mutationBusyRef.current) throw new Error(t("state.workspaceFailed"));
      mutationBusyRef.current = true;
      setMutationBusy(true);
      try {
        // Let old writes finish, then cancel any retry or follow-up they scheduled.
        controllerRef.current?.cancel();
        await flightRef.current;
        controllerRef.current?.cancel();
        let result: { scheduleId: string };
        try {
          result = await apiRequest<{ scheduleId: string }>(`/api/workspace/versions${workspaceRef.current?.hallId ? `?hallId=${encodeURIComponent(workspaceRef.current.hallId)}` : ""}`, {
            json: { action: "restore", versionId },
          });
        } catch (error) {
          controllerRef.current?.notifyIfDirty();
          throw error;
        }
        // A confirmed restore intentionally replaces this schedule's local edits.
        try { window.localStorage.removeItem(recoveryKey(result.scheduleId, workspaceIdentityRef.current, recoverySessionRef.current)); } catch { /* unavailable */ }
        if (!await reload(result.scheduleId, true)) throw new Error(t("state.workspaceFailed"));
        toastKey("toast.restored", undefined, "success");
      } finally {
        mutationBusyRef.current = false;
        setMutationBusy(false);
      }
    },
    [reload, toastKey, t],
  );

  const saveNow = useCallback(
    (options?: { description?: string; snapshot?: boolean; publish?: boolean }) => {
      // An explicit save supersedes any pending autosave; completion chaining
      // picks up edits that land while it runs.
      controllerRef.current?.cancel();
      return persist(options);
    },
    [persist],
  );

  const acceptRecovery = useCallback(() => {
    const found = recovery;
    if (!found) return;
    acceptedRecoveryRef.current = found;
    dispatchHistory({
      action: {
        type: "replace",
        state: { events: found.events, settings: found.settings },
        description: t("history.recovered"),
      },
      record: false,
    });
    pendingDescription.current = t("history.recovered");
    setRecovery(null);
    setDirty(true);
    toastKey("toast.recovered", undefined, "success");
  }, [recovery, toastKey, t]);

  const discardRecovery = useCallback(() => {
    if (recovery) {
      try {
        if (window.localStorage.getItem(recovery.storageKey) === recovery.storedValue) window.localStorage.removeItem(recovery.storageKey);
      } catch { /* Storage unavailable: keep the original recoverable copy. */ }
    }
    setRecovery(null);
  }, [recovery]);

  const conflicts = useMemo(() => {
    if (!workspace) return [];
    return validateSchedule(
      {
        settings: history.present.settings,
        events: history.present.events,
        trainers: workspace.trainers,
        classTypes: workspace.classTypes,
        rooms: workspace.rooms,
      },
      t,
    );
  }, [history.present.events, history.present.settings, workspace, t]);

  const value: WorkspaceContextValue = {
    loading,
    mutationBusy: mutationBusy || loading,
    loadError,
    workspace,
    schedule: workspace?.empty ? null : workspace?.state.schedule ?? null,
    events: history.present.events,
    settings: history.present.settings,
    trainers: workspace?.trainers ?? [],
    classTypes: workspace?.classTypes ?? [],
    rooms: workspace?.rooms ?? [],
    versions: workspace?.versions ?? [],
    conflicts,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    saveStatus,
    savedAt,
    dirty,
    saveConflict,
    dispatch,
    applyTransient,
    commit,
    editorState: history.present,
    runUndo,
    runRedo,
    saveNow,
    reload,
    saveTrainerWithClasses,
    removeTrainer,
    saveClassType,
    removeClassType,
    reorderTrainers,
    reorderClassTypes,
    saveRoom,
    removeRoom,
    scheduleAction,
    importBackup,
    restoreProjectArchive,
    createSnapshot,
    restoreVersion,
    toast,
    toastKey,
    toasts,
    dismissToast,
    t,
    recovery,
    acceptRecovery,
    discardRecovery,
    actionDialog,
    setActionDialog,
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

function defaultSettings() {
  return {
    visibleDays: [0, 1, 2, 3, 4, 5],
    startTime: "07:00",
    endTime: "21:00",
    defaultInterval: 60,
    customMarkers: [],
    snapMinutes: 15 as const,
    themeId: "risen-team-dark",
    showTrainerLegend: true,
    legendPosition: "right" as const,
    showLogo: true,
    logoDataUrl: null,
    scheduleTitle: "Risen Team",
    scheduleSubtitle: "Weekly Training Schedule",
    effectiveDate: null,
    exportPaper: "original" as const,
    exportOrientation: "landscape" as const,
    exportScale: 2 as const,
    customExportWidth: 1680,
    customExportHeight: 880,
    autosave: true,
  };
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return context;
}
