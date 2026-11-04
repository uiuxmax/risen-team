"use client";

import { useMemo, useState } from "react";
import { type ClassType, type Room, type ScheduleEvent, type ScheduleSettings, type Trainer } from "@/lib/domain/types";
import { addMinutes, buildMarkers, isValidTime, minutesToTime, timeToMinutes } from "@/lib/schedule/time";
import { validateScheduleState } from "@/lib/schedule/validation";
import { Button, Chip, Field, Modal, SelectInput, Textarea, TextInput, TimeField } from "@/components/ui/controls";
import { uuid } from "@/lib/client/api";
import { useI18n } from "@/components/app/LanguageProvider";

export interface EventDialogProps {
  open: boolean;
  mode: "create" | "edit";
  scheduleId: string;
  initial?: Partial<ScheduleEvent> | null;
  events: ScheduleEvent[];
  trainers: Trainer[];
  classTypes: ClassType[];
  rooms: Room[];
  settings: ScheduleSettings;
  onClose: () => void;
  onSave: (event: ScheduleEvent) => void;
  onDuplicate?: (event: ScheduleEvent) => void;
  onDelete?: (event: ScheduleEvent) => void;
}

export function EventDialog(props: EventDialogProps) {
  const {
    open,
    mode,
    scheduleId,
    initial,
    events,
    trainers,
    classTypes,
    rooms,
    settings,
    onClose,
    onSave,
    onDuplicate,
    onDelete,
  } = props;

  const { t, dayName } = useI18n();
  const activeTrainers = useMemo(() => trainers.filter((trainer) => trainer.active), [trainers]);
  const activeClassTypes = useMemo(() => classTypes.filter((item) => item.active), [classTypes]);

  const [form, setForm] = useState<ScheduleEvent>(() => blank());
  const [error, setError] = useState<string | null>(null);
  // Dialog-driving props from the previous render. Comparing them during
  // render lets the form be re-initialised with React's documented
  // adjust-state-when-props-change pattern instead of a setState inside an
  // effect (same inputs the old effect tracked: open, initial, scheduleId,
  // settings.startTime).
  const [prevDialogInput, setPrevDialogInput] = useState<{
    open: boolean;
    initial: Partial<ScheduleEvent> | null | undefined;
    scheduleId: string;
    startTime: string;
  } | null>(null);

  function blank(): ScheduleEvent {
    const trainer = activeTrainers.find((item) => activeClassTypes.some((type) => type.trainerIds.includes(item.id))) ?? activeTrainers[0];
    const classType = activeClassTypes.find((item) => item.trainerIds.includes(trainer?.id ?? ""));
    const startTime = settings.startTime;
    return {
      id: uuid(),
      scheduleId,
      dayOfWeek: settings.visibleDays[0] ?? 0,
      startTime,
      endTime: addMinutes(startTime, classType?.defaultDuration ?? 60),
      trainerId: trainer?.id ?? "",
      classTypeId: classType?.id ?? "",
      roomId: null,
      notes: null,
    };
  }

  const dialogInputChanged =
    prevDialogInput === null ||
    prevDialogInput.open !== open ||
    prevDialogInput.initial !== initial ||
    prevDialogInput.scheduleId !== scheduleId ||
    prevDialogInput.startTime !== settings.startTime;
  if (dialogInputChanged) {
    setPrevDialogInput({ open, initial, scheduleId, startTime: settings.startTime });
    if (open) {
      setError(null);
      if (initial && initial.id) {
        setForm({
          id: initial.id,
          scheduleId,
          dayOfWeek: initial.dayOfWeek ?? 0,
          startTime: initial.startTime ?? settings.startTime,
          endTime: initial.endTime ?? addMinutes(settings.startTime, 60),
          trainerId: initial.trainerId ?? "",
          classTypeId: initial.classTypeId ?? "",
          roomId: initial.roomId ?? null,
          notes: initial.notes ?? null,
        });
      } else {
        const merged = { ...blank(), ...initial, id: initial?.id ?? form.id ?? uuid() };
        // When the user clicks a slot we keep the clicked time and suggest the
        // class' default duration (e.g. Boxing 60 min -> 15:30-16:30).
        if (initial?.startTime && !initial?.endTime) {
          const duration = classTypes.find((item) => item.id === merged.classTypeId)?.defaultDuration ?? 60;
          merged.endTime = addMinutes(initial.startTime, duration);
        }
        setForm(merged);
      }
    }
  }

  const selectedClassType = classTypes.find((item) => item.id === form.classTypeId);
  // Keep a saved inactive assignment visible while editing it. Deactivation
  // prevents new assignments; it must not make an existing reference look lost.
  const unchangedAssignment = mode === "edit" && initial?.trainerId === form.trainerId && initial?.classTypeId === form.classTypeId;
  const eligibleClasses = classTypes.filter((item) =>
    (item.active && item.trainerIds.includes(form.trainerId)) || (unchangedAssignment && item.id === form.classTypeId),
  );
  const selectableTrainers = trainers.filter((trainer) => trainer.active || (mode === "edit" && trainer.id === initial?.trainerId));

  const markers = useMemo(
    () => buildMarkers(settings).filter((marker) => marker.kind !== "boundary").map((marker) => marker.label),
    [settings],
  );

  const preview = useMemo(() => {
    const others = events.filter((event) => event.id !== form.id);
    // Same shared schedule-state boundary as the server: manual entry is
    // validated, never silently clamped, and schedule-window errors show here too.
    const { conflicts } = validateScheduleState(
      {
        settings,
        events: [...others, form],
        trainers,
        classTypes,
        rooms,
      },
      t,
    );
    return conflicts.filter(
      (conflict) => conflict.eventIds.includes(form.id) || conflict.eventIds.length === 0,
    );
  }, [events, form, settings, trainers, classTypes, rooms, t]);

  const errors = preview.filter((conflict) => conflict.severity === "error");
  const warnings = preview.filter((conflict) => conflict.severity === "warning");

  const submit = () => {
    if (!form.trainerId) return setError(t("dialog.errTrainer"));
    if (!form.classTypeId) return setError(t("dialog.errClass"));
    if (!unchangedAssignment && !eligibleClasses.some((item) => item.id === form.classTypeId)) return setError(t("dialog.errClass"));
    const others = events.filter((event) => event.id !== form.id);
    const { errors: structuralErrors } = validateScheduleState(
      {
        settings,
        events: [...others, form],
        trainers,
        classTypes,
        rooms,
      },
      t,
    );
    const blocking = structuralErrors.filter(
      (conflict) => conflict.eventIds.includes(form.id) || conflict.eventIds.length === 0,
    );
    if (blocking.length > 0) return setError(blocking[0].message);
    onSave({ ...form, roomId: form.roomId || null, notes: form.notes?.trim() ? form.notes.trim() : null });
  };

  const applyClassType = (classTypeId: string) => {
    setError(null);
    const classType = classTypes.find((item) => item.id === classTypeId);
    if (!classType) return;
    const duration = classType.defaultDuration;
    const start = form.startTime;
    setForm((current) => ({
      ...current,
      classTypeId,
      endTime: addMinutes(start, duration),
      trainerId: classType.trainerIds.includes(current.trainerId)
        ? current.trainerId
        : (classType.trainerIds[0] ?? current.trainerId),
    }));
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      title={mode === "create" ? t("dialog.addClass") : t("dialog.editClass")}
      description={`${dayName(form.dayOfWeek)} · ${form.startTime}–${form.endTime}${
        selectedClassType ? ` · ${t("dialog.durationMinutes", { count: selectedClassType.defaultDuration })}` : ""
      }`}
      onClose={onClose}
      width={760}
      footer={
        <>
          {mode === "edit" && onDelete ? (
            <Button
              variant="danger"
              onClick={() => {
                onDelete(form);
              }}
            >
              {t("common.delete")}
            </Button>
          ) : null}
          <span className="flex-1" />
          {mode === "edit" && onDuplicate ? (
            <Button variant="outline" onClick={() => onDuplicate({ ...form, id: uuid() })}>
              {t("dialog.duplicate")}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit}>
            {mode === "create" ? t("dialog.addToSchedule") : t("dialog.saveChanges")}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label={t("dialog.classType")} hint={eligibleClasses.length ? t("dialog.classTypeHint") : t("halls.noEligibleClasses")}>
          <SelectInput
            className="py-2.5"
            aria-label={t("dialog.classType")}
            required
            value={form.classTypeId}
            onChange={(event) => applyClassType(event.target.value)}
          >
            <option value="">{t("dialog.selectClass")}</option>
            {eligibleClasses.map((classType) => (
              <option key={classType.id} value={classType.id}>
                {classType.name} · {t("dialog.durationMinutes", { count: classType.defaultDuration })}{classType.active ? "" : ` · ${t("common.inactive")}`}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field
          label={t("dialog.trainer")}
          hint={selectedClassType?.trainerIds.length ? t("dialog.trainerHint") : undefined}
        >
          <SelectInput
            aria-label={t("dialog.trainer")}
            required
            value={form.trainerId}
            onChange={(event) => { const trainerId = event.target.value; setError(null); setForm((current) => ({ ...current, trainerId, classTypeId: activeClassTypes.find((item) => item.id === current.classTypeId)?.trainerIds.includes(trainerId) ? current.classTypeId : "" })); }}
          >
            <option value="">{t("dialog.selectTrainer")}</option>
            {selectableTrainers.map((trainer) => (
              <option key={trainer.id} value={trainer.id}>
                {trainer.name}{trainer.active ? "" : ` · ${t("common.inactive")}`}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label={t("dialog.day")}>
          <SelectInput
            value={String(form.dayOfWeek)}
            onChange={(event) => setForm((current) => ({ ...current, dayOfWeek: Number(event.target.value) }))}
          >
            {settings.visibleDays.map((day) => (
              <option key={day} value={day}>
                {dayName(day)}
              </option>
            ))}
          </SelectInput>
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:col-span-2">
          <TimeField
            label={t("dialog.start")}
            value={form.startTime}
            markers={markers}
            onChange={(value) => {
              if (!isValidTime(value)) return;
              const duration = Math.max(5, timeToMinutes(form.endTime) - timeToMinutes(form.startTime));
              setForm((current) => ({ ...current, startTime: value, endTime: minutesToTime(timeToMinutes(value) + duration) }));
            }}
          />
          <TimeField
            label={t("dialog.end")}
            value={form.endTime}
            markers={markers}
            onChange={(value) => {
              if (!isValidTime(value)) return;
              setForm((current) => ({ ...current, endTime: value }));
            }}
          />
        </div>
        <Field label={t("dialog.notes")} className="md:col-span-2">
          <Textarea
            value={form.notes ?? ""}
            placeholder={t("dialog.notesPlaceholder")}
            onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
          />
        </Field>
      </div>

      {error ? (
        <p className="mt-3 rounded-md border border-rose-800/60 bg-rose-950/35 px-3 py-2 text-xs text-rose-200">{error}</p>
      ) : null}

      {preview.length > 0 ? (
        <ul className="mt-3 space-y-1.5 rounded-md border border-amber-900/30 bg-[#0b0e14] px-3 py-2">
          {[...errors, ...warnings].map((conflict) => (
            <li key={conflict.id}>
              <Chip tone={conflict.severity === "error" ? "danger" : "warning"}>
                {conflict.severity === "error" ? t("common.error") : t("common.warning")}
              </Chip>{" "}
              <span className="text-xs text-slate-400">{conflict.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-emerald-400">{t("dialog.noConflicts")}</p>
      )}
    </Modal>
  );
}

export function CopyDayDialog({
  open,
  days,
  onClose,
  onConfirm,
}: {
  open: boolean;
  days: number[];
  onClose: () => void;
  onConfirm: (from: number, to: number, mode: "replace" | "merge") => void;
}) {
  const { t, dayName } = useI18n();
  const [from, setFrom] = useState(days[0] ?? 0);
  const [to, setTo] = useState(days[1] ?? days[0] ?? 0);
  const [mode, setMode] = useState<"replace" | "merge">("replace");
  // Previous render's opening inputs (same ones the old effect tracked):
  // reset during render instead of with a setState inside an effect.
  const [prevCopyInput, setPrevCopyInput] = useState<{ open: boolean; days: number[] } | null>(null);

  const copyInputChanged =
    prevCopyInput === null || prevCopyInput.open !== open || prevCopyInput.days !== days;
  if (copyInputChanged) {
    setPrevCopyInput({ open, days });
    if (open) {
      setFrom(days[0] ?? 0);
      setTo(days[1] ?? days[0] ?? 0);
      setMode("replace");
    }
  }

  return (
    <Modal
      open={open}
      title={t("dialog.copyDayTitle")}
      description={t("dialog.copyDayDescription")}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => onConfirm(from, to, mode)}>
            {t("dialog.copyDayAction")}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("dialog.copyFrom")}>
          <SelectInput value={String(from)} onChange={(event) => setFrom(Number(event.target.value))}>
            {days.map((day) => (
              <option key={day} value={day}>
                {dayName(day)}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label={t("dialog.copyTo")}>
          <SelectInput value={String(to)} onChange={(event) => setTo(Number(event.target.value))}>
            {days.map((day) => (
              <option key={day} value={day}>
                {dayName(day)}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setMode("replace")}
          className={`rounded-md border px-3 py-2 text-left text-xs ${
            mode === "replace" ? "border-rose-700/70 bg-rose-950/30 text-rose-100" : "border-[#242936] text-slate-400"
          }`}
        >
          <span className="block font-semibold">{t("dialog.copyReplace")}</span>
          {t("dialog.copyReplaceHint")}
        </button>
        <button
          type="button"
          onClick={() => setMode("merge")}
          className={`rounded-md border px-3 py-2 text-left text-xs ${
            mode === "merge" ? "border-rose-700/70 bg-rose-950/30 text-rose-100" : "border-[#242936] text-slate-400"
          }`}
        >
          <span className="block font-semibold">{t("dialog.copyMerge")}</span>
          {t("dialog.copyMergeHint")}
        </button>
      </div>
    </Modal>
  );
}

export function SnapshotDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (description: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open={open}
      title={t("dialog.snapshotTitle")}
      busy={busy}
      description={t("dialog.snapshotDescription")}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={async () => {
            if (busy) return;
            setBusy(true); setError(null);
            try {
              if (await onConfirm(description.trim() || t("history.manualSnapshot"))) onClose();
              else setError(t("toast.saveFailedPlain"));
            } catch (cause) { setError(cause instanceof Error ? cause.message : t("toast.saveFailedPlain")); }
            finally {setBusy(false);}
          }}>
            {busy ? t("common.saving") : t("dialog.snapshotSave")}
          </Button>
        </>
      }
    >
      <Field label={t("dialog.snapshotName")}>
        <TextInput
          autoFocus
          value={description}
          placeholder={t("dialog.snapshotPlaceholder")}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      {error ? <p role="alert" className="mt-3 text-xs text-rose-300">{error}</p> : null}
    </Modal>
  );
}
