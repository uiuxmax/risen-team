"use client";

import { useState } from "react";
import { useWorkspace } from "@/components/app/WorkspaceProvider";
import { Button, Chip, EmptyState, Field, Modal, Panel, SelectInput, TextInput, Textarea, Toggle, ColorPicker } from "@/components/ui/controls";
import { TRAINER_PALETTE, type ClassType, type Trainer } from "@/lib/domain/types";
import { uuid } from "@/lib/client/api";
import { useI18n } from "@/components/app/LanguageProvider";

const TABS = [
  { id: "trainers", labelKey: "manage.tabTrainers" },
  { id: "classes", labelKey: "manage.tabClasses" },
] as const;

export function ManagePanels() {
  const { t } = useI18n();
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("trainers");
  const { trainers, classTypes, schedule } = useWorkspace();

  if (!schedule) return <EmptyState title={t("halls.empty")} hint={t("halls.emptyHint")} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-[#242936] p-0.5">
          {TABS.map((item) => (
            <Button key={item.id} size="sm" variant={tab === item.id ? "subtle" : "ghost"} onClick={() => setTab(item.id)}>
              {t(item.labelKey)}
            </Button>
          ))}
        </div>
        <span className="text-[11px] text-slate-500">
          {schedule?.name} · {t("halls.catalogueCounts", { trainers: trainers.length, classes: classTypes.length })}
        </span>
      </div>

      {tab === "trainers" ? <TrainersPanel /> : null}
      {tab === "classes" ? <ClassTypesPanel /> : null}
    </div>
  );
}

function TrainersPanel() {
  const { t } = useI18n();
  const { trainers, classTypes, events, saveTrainerWithClasses, removeTrainer, reorderTrainers, toast } = useWorkspace();
  const [editing, setEditing] = useState<Trainer | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Trainer | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openNew = () => {
    const used = new Set(trainers.map((trainer) => trainer.color.toLowerCase()));
    const color = TRAINER_PALETTE.find((item) => !used.has(item.value.toLowerCase()))?.value ?? TRAINER_PALETTE[0].value;
    setEditing({
      id: uuid(),
      name: "",
      color,
      initials: null,
      notes: null,
      active: true,
      sortOrder: trainers.length,
    });
  };

  // Same ↑/↓ controls as before — the swap is now submitted as ONE atomic
  // reorder request instead of two independent saves.
  const move = async (trainer: Trainer, direction: -1 | 1) => {
    const index = trainers.findIndex((item) => item.id === trainer.id);
    const target = trainers[index + direction];
    if (!target) return;
    const order = trainers.map((item) => item.id);
    [order[index], order[index + direction]] = [order[index + direction], order[index]];
    await reorderTrainers(order);
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Panel
        title={t("manage.tabTrainers")}
        aside={
          <Button size="sm" variant="primary" onClick={openNew}>
            {t("manage.addTrainer")}
          </Button>
        }
      >
        {trainers.length === 0 ? (
          <EmptyState title={t("manage.trainersEmpty")} hint={t("manage.trainersEmptyHint")} />
        ) : (
          <ul className="divide-y divide-[#171b24]">
            {trainers.map((trainer, index) => {
              const assigned = classTypes.filter((classType) => classType.trainerIds.includes(trainer.id));
              return (
                <li key={trainer.id} className="flex flex-wrap items-center gap-2.5 py-2.5">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: trainer.color }} />
                  <button
                    type="button"
                    aria-label={t("manage.editTrainer", { name: trainer.name })}
                    onClick={() => setEditing(trainer)}
                    className="min-w-[120px] cursor-pointer rounded-sm text-left text-sm font-medium text-slate-100 hover:text-rose-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0b0f]"
                  >
                    {trainer.name}
                  </button>
                  {trainer.active ? (
                    <Chip tone="success">{t("common.active")}</Chip>
                  ) : (
                    <Chip tone="warning">{t("common.inactive")}</Chip>
                  )}
                  <span className="flex flex-wrap gap-1">
                    {assigned.map((classType) => (
                      <Chip key={classType.id} tone="neutral" className="text-slate-400">
                        {classType.shortName}
                      </Chip>
                    ))}
                    {assigned.length === 0 ? (
                      <span className="text-[11px] text-slate-500">{t("manage.noClassesAssigned")}</span>
                    ) : null}
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => void move(trainer, -1)} title={t("manage.moveUp")}>
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={index === trainers.length - 1}
                      onClick={() => void move(trainer, 1)}
                      title={t("manage.moveDown")}
                    >
                      ↓
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing(trainer)}>
                      {t("common.edit")}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setPendingDelete(trainer)}>
                      {t("common.delete")}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title={t("manage.howTrainers")}>
        <ul className="space-y-2 text-xs text-slate-400">
          <li>{t("manage.howTrainers1")}</li>
          <li>{t("manage.howTrainers2")}</li>
          <li>{t("manage.howTrainers3")}</li>
        </ul>
      </Panel>

      {editing ? (
        <TrainerEditor
          trainer={editing}
          classTypes={classTypes}
          onClose={() => setEditing(null)}
          onSave={async (trainer, classIds) => {
            // ONE atomic save for the trainer row and every class link it touches.
            // On failure the modal stays open and the error toast explains that
            // nothing was changed.
            const saved = await saveTrainerWithClasses(trainer, classIds);
            if (!saved) return;
            toast(
              t("toast.trainerSavedWith", { name: trainer.name || t("dialog.trainer"), count: classIds.length }),
              "success",
            );
            setEditing(null);
          }}
        />
      ) : null}

      <Modal
        open={pendingDelete !== null}
        alert
        busy={deleting}
        title={t("manage.deleteTrainerTitle")}
        description={pendingDelete?.name}
        onClose={() => setPendingDelete(null)}
        width={420}
        footer={
          <>
            <Button variant="ghost" disabled={deleting} onClick={() => setPendingDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!pendingDelete || deleting) return;
                // Failure keeps the confirmation open (nothing was changed) and
                // reports why through the existing toast channel.
                setDeleting(true);
                try { if (await removeTrainer(pendingDelete.id)) setPendingDelete(null); } finally { setDeleting(false); }
              }}
            >
              {t("manage.deleteTrainerAction")}
            </Button>
          </>
        }
      >
        <p className="text-xs text-slate-400">{t("manage.deleteTrainerHint")}</p>
        <p className="mt-2 text-xs text-slate-400">{t("manage.deleteEventsCount", { count: events.filter((event) => event.trainerId === pendingDelete?.id).length })}</p>
      </Modal>
    </div>
  );
}

function TrainerEditor({
  trainer,
  classTypes,
  onClose,
  onSave,
}: {
  trainer: Trainer;
  classTypes: ClassType[];
  onClose: () => void;
  onSave: (trainer: Trainer, classIds: string[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<Trainer>(trainer);
  const [classIds, setClassIds] = useState<string[]>(
    classTypes.filter((classType) => classType.trainerIds.includes(trainer.id)).map((classType) => classType.id),
  );
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      open
      title={trainer.name ? t("manage.editTrainer", { name: trainer.name }) : t("manage.addTrainer")}
      description={t("settings.showLegendHint")}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || form.name.trim().length === 0}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave({ ...form, name: form.name.trim(), initials: form.initials?.toUpperCase() || null }, classIds);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? t("common.saving") : t("manage.saveTrainer")}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label={t("manage.name")}>
          <TextInput
            autoFocus
            value={form.name}
            placeholder={t("manage.namePlaceholder")}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>
        <Field label={t("manage.initials")} hint={t("manage.initialsHint")}>
          <TextInput
            value={form.initials ?? ""}
            maxLength={3}
            onChange={(event) => setForm({ ...form, initials: event.target.value })}
          />
        </Field>
        <div className="md:col-span-2">
          <ColorPicker value={form.color} onChange={(color) => setForm({ ...form, color })} />
        </div>
        <Field label={t("manage.notes")} className="md:col-span-2">
          <Textarea value={form.notes ?? ""} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
        </Field>
        <div className="md:col-span-2">
          <Toggle
            checked={form.active}
            onChange={(active) => setForm({ ...form, active })}
            label={t("manage.activeToggle")}
            description={t("manage.activeToggleHint")}
          />
        </div>
        <div className="md:col-span-2">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            {t("manage.availableClasses")}
          </p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {classTypes.map((classType) => (
              <label key={classType.id} className="flex items-center gap-2 rounded-md border border-[#20242f] px-2.5 py-1.5 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={classIds.includes(classType.id)}
                  onChange={(event) =>
                    setClassIds((current) =>
                      event.target.checked ? [...current, classType.id] : current.filter((id) => id !== classType.id),
                    )
                  }
                  className="h-3.5 w-3.5 accent-rose-600"
                />
                {classType.name}
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ClassTypesPanel() {
  const { t } = useI18n();
  const { classTypes, trainers, events, saveClassType, removeClassType, reorderClassTypes, toast } = useWorkspace();
  const [editing, setEditing] = useState<(ClassType & { isNew?: boolean }) | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ClassType | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openNew = () =>
    setEditing({
      id: uuid(),
      name: "",
      shortName: "",
      defaultDuration: 60,
      color: null,
      description: null,
      active: true,
      sortOrder: classTypes.length,
      trainerIds: [],
      isNew: true,
    });

  // Same ↑/↓ controls as before — one atomic reorder request per move.
  const move = async (classType: ClassType, direction: -1 | 1) => {
    const index = classTypes.findIndex((item) => item.id === classType.id);
    const target = classTypes[index + direction];
    if (!target) return;
    const order = classTypes.map((item) => item.id);
    [order[index], order[index + direction]] = [order[index + direction], order[index]];
    await reorderClassTypes(order);
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Panel
        title={t("manage.tabClasses")}
        aside={
          <Button size="sm" variant="primary" onClick={openNew}>
            {t("manage.addClassType")}
          </Button>
        }
      >
        {classTypes.length === 0 ? (
          <EmptyState title={t("manage.classesEmpty")} hint={t("manage.classesEmptyHint")} />
        ) : (
          <ul className="divide-y divide-[#171b24]">
            {classTypes.map((classType, index) => {
              const eligible = trainers.filter((trainer) => classType.trainerIds.includes(trainer.id));
              return (
                <li key={classType.id} className="flex flex-wrap items-center gap-2.5 py-2.5">
                  <button
                    type="button"
                    aria-label={t("manage.editClassType", { name: classType.name })}
                    onClick={() => setEditing(classType)}
                    className="min-w-[140px] cursor-pointer rounded-sm text-left text-sm font-medium text-slate-100 hover:text-rose-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0b0f]"
                  >
                    {classType.name}
                  </button>
                  <Chip tone="neutral" className="text-slate-400">{classType.shortName}</Chip>
                  <Chip tone="info" className="text-sky-400/80">{t("manage.minutes", { count: classType.defaultDuration })}</Chip>
                  {classType.active ? (
                    <Chip tone="success">{t("common.active")}</Chip>
                  ) : (
                    <Chip tone="warning">{t("common.inactive")}</Chip>
                  )}
                  <span className="flex flex-wrap gap-1">
                    {eligible.map((trainer) => (
                      <Chip key={trainer.id} tone="neutral" className="text-slate-400">
                        {trainer.name}
                      </Chip>
                    ))}
                    {eligible.length === 0 ? (
                      <span className="text-[11px] text-slate-500">{t("manage.noTrainersAssigned")}</span>
                    ) : null}
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => void move(classType, -1)}>
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={index === classTypes.length - 1}
                      onClick={() => void move(classType, 1)}
                    >
                      ↓
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing(classType)}>
                      {t("common.edit")}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setPendingDelete(classType)}>
                      {t("common.delete")}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title={t("manage.classDefaults")}>
        <p className="text-xs text-slate-400">{t("manage.classDefaultsHint")}</p>
      </Panel>

      {editing ? (
        <ClassTypeEditor
          classType={editing}
          trainers={trainers}
          onClose={() => setEditing(null)}
          onSave={async (classType) => {
            const { isNew: _isNew, ...payload } = classType;
            void _isNew;
            // Atomic server-side: metadata + eligibility links together. A
            // failure keeps the editor open instead of pretending success.
            if (!(await saveClassType(payload))) return;
            setEditing(null);
          }}
        />
      ) : null}

      <Modal
        open={pendingDelete !== null}
        alert
        busy={deleting}
        title={t("manage.deleteClassTitle")}
        description={pendingDelete?.name}
        onClose={() => setPendingDelete(null)}
        width={420}
        footer={
          <>
            <Button variant="ghost" disabled={deleting} onClick={() => setPendingDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!pendingDelete || deleting) return;
                // Failure keeps the confirmation open and reports the reason.
                setDeleting(true);
                try {
                  if (!(await removeClassType(pendingDelete.id))) return;
                  toast(t("toast.classTypeRemoved"), "success");
                  setPendingDelete(null);
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {t("manage.deleteClassAction")}
            </Button>
          </>
        }
      >
        <p className="text-xs text-slate-400">{t("manage.deleteClassHint")}</p>
        <p className="mt-2 text-xs text-slate-400">{t("manage.deleteEventsCount", { count: events.filter((event) => event.classTypeId === pendingDelete?.id).length })}</p>
      </Modal>
    </div>
  );
}

function ClassTypeEditor({
  classType,
  trainers,
  onClose,
  onSave,
}: {
  classType: ClassType & { isNew?: boolean };
  trainers: Trainer[];
  onClose: () => void;
  onSave: (classType: ClassType & { isNew?: boolean }) => Promise<void>;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState(classType);
  const [busy, setBusy] = useState(false);
  const durations = [15, 20, 30, 45, 60, 75, 90, 120];

  return (
    <Modal
      open
      title={classType.isNew ? t("manage.addClassType") : t("manage.editClassType", { name: classType.name })}
      description={t("manage.classDefaultsHint")}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || form.name.trim().length === 0 || form.shortName.trim().length === 0}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave({
                  ...form,
                  name: form.name.trim(),
                  shortName: form.shortName.trim().toUpperCase(),
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? t("common.saving") : t("manage.saveClassType")}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label={t("manage.name")}>
          <TextInput autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label={t("manage.shortName")} hint={t("manage.shortNameHint")}>
          <TextInput
            value={form.shortName}
            maxLength={10}
            onChange={(event) => setForm({ ...form, shortName: event.target.value })}
          />
        </Field>
        <Field label={t("manage.defaultDuration")}>
          <SelectInput
            value={String(form.defaultDuration)}
            onChange={(event) => setForm({ ...form, defaultDuration: Number(event.target.value) })}
          >
            {durations.map((duration) => (
              <option key={duration} value={duration}>
                {t("manage.minutes", { count: duration })}
              </option>
            ))}
          </SelectInput>
        </Field>
        <div className="flex items-end">
          <Toggle
            checked={form.active}
            onChange={(active) => setForm({ ...form, active })}
            label={t("manage.activeToggle")}
            description={t("manage.activeToggleClass")}
          />
        </div>
        <Field label={t("manage.description")} className="md:col-span-2">
          <Textarea
            value={form.description ?? ""}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </Field>
        <div className="md:col-span-2">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            {t("manage.eligibleTrainers")}
          </p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {trainers.map((trainer) => (
              <label key={trainer.id} className="flex items-center gap-2 rounded-md border border-[#20242f] px-2.5 py-1.5 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={form.trainerIds.includes(trainer.id)}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      trainerIds: event.target.checked
                        ? [...current.trainerIds, trainer.id]
                        : current.trainerIds.filter((id) => id !== trainer.id),
                    }))
                  }
                  className="h-3.5 w-3.5 accent-rose-600"
                />
                {trainer.name}
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
