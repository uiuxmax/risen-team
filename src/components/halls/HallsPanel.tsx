"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/components/app/WorkspaceProvider";
import { useI18n } from "@/components/app/LanguageProvider";
import { Button, Chip, EmptyState, Field, Modal, Panel, TextInput, Toggle } from "@/components/ui/controls";
import { VersionsPanel } from "@/components/versions/VersionsPanel";
import { apiRequest } from "@/lib/client/api";
import type { Schedule } from "@/lib/domain/types";

interface MigrationPreview {
  requiresConfirmation: boolean;
  schedules: { id: string; name: string; eventCount: number; roomIds: string[]; unassignedEvents: number; eligibilityMismatches?: number }[];
  trainerCount: number;
  classTypeCount: number;
  notice: string;
}

export function HallsPanel() {
  const { t, formatDateTime } = useI18n();
  const router = useRouter();
  const { workspace, schedule, settings, loading, reload, scheduleAction, saveNow, dirty, toast } = useWorkspace();
  const [editing, setEditing] = useState<{ action: "create" | "rename" | "duplicate"; hall?: Schedule } | null>(null);
  const [name, setName] = useState("");
  const [withoutEvents, setWithoutEvents] = useState(false);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false);
  const [migration, setMigration] = useState<MigrationPreview | null>(null);
  const editingFormId = useId();

  useEffect(() => {
    let cancelled = false;
    void apiRequest<{ preview: MigrationPreview }>("/api/workspace/migration").then(({ preview }) => {
      if (!cancelled && preview?.requiresConfirmation) setMigration(preview);
    }).catch(() => { /* Workspace's load error already explains unavailable storage. */ });
    return () => { cancelled = true; };
  }, []);

  const openEditor = (action: "create" | "rename" | "duplicate", hall?: Schedule) => {
    const suffix = ` — ${t("settings.duplicate")}`;
    setName(action === "duplicate" ? `${(hall?.name ?? "").slice(0, 80 - suffix.length)}${suffix}` : hall?.name ?? "");
    setWithoutEvents(false);
    setEditing({ action, hall });
  };

  const addDemo = async () => {
    setBusy(true);
    try {
      if (await scheduleAction("template")) router.push("/schedule");
    } finally { setBusy(false); }
  };

  const saveEditing = async () => {
    if (!editing || busy || !name.trim()) return;
    setBusy(true);
    try {
      if (await scheduleAction(editing.action, { id: editing.hall?.id, sourceId: editing.hall?.id, name: name.trim(), withoutEvents })) setEditing(null);
    } finally { setBusy(false); }
  };

  const exportHall = async (id: string) => {
    setBusy(true);
    try {
      if (dirty) {
        if (!settings.autosave && !window.confirm(t("halls.saveBeforeExport"))) return;
        if (!(await saveNow())) return;
      }
      const { backup } = await apiRequest<{ backup: unknown }>(`/api/workspace/backup?hallId=${encodeURIComponent(id)}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `risen-team-hall-${id}-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (error) { toast(error instanceof Error ? error.message : t("toast.backupFailed"), "error"); }
    finally { setBusy(false); }
  };

  return <div className="flex flex-col gap-4">
    {migration ? <Panel title={t("halls.migrationTitle")}>
      <p className="mb-3 text-xs text-slate-400">{t("halls.migrationHint")}</p>
      <p className="mb-3 text-xs text-slate-300">{migration.notice}</p>
      <ul className="mb-3 divide-y divide-[#171b24] text-xs text-slate-300">
        {migration.schedules.map((item) => <li key={item.id} className="py-2">{item.name} · {t("halls.migrationEvents", { events: item.eventCount, rooms: item.roomIds.length, unassigned: item.unassignedEvents })} · {t("halls.eligibilityMismatches", { count: item.eligibilityMismatches ?? 0 })}</li>)}
      </ul>
      <p className="mb-3 text-xs text-slate-400">{t("halls.catalogueCounts", { trainers: migration.trainerCount, classes: migration.classTypeCount })}</p>
      <Button variant="primary" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          await apiRequest("/api/workspace/migration", { json: { confirmed: true } });
          setMigration(null);
          await reload();
        } catch (error) { toast(error instanceof Error ? error.message : t("halls.migrationFailed"), "error"); }
        finally { setBusy(false); }
      }}>{t("halls.migrate")}</Button>
    </Panel> : <Panel title={t("halls.title")} aside={<div className="flex flex-wrap justify-end gap-2">
      <Button size="sm" variant="outline" disabled={loading || busy || !workspace} onClick={() => openEditor("create")}>{t("halls.create")}</Button>
      {workspace?.schedules.length ? <Button size="sm" variant="primary" disabled={loading || busy} title={t("halls.demoHint")} onClick={() => void addDemo()}>{t("halls.addDemo")}</Button> : null}
    </div>}>
      {!workspace?.schedules.length ? <EmptyState title={loading ? t("state.loading") : t("halls.empty")} hint={t("halls.demoHint")} action={workspace && !loading ? <Button variant="primary" disabled={busy} onClick={() => void addDemo()}>{t("halls.addDemo")}</Button> : undefined} /> : <ul className="divide-y divide-[#171b24]">
        {workspace.schedules.map((hall) => <li key={hall.id} className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-[180px] flex-1">
            <span className="text-sm font-medium text-slate-100">{hall.name}</span>
            <p className="mt-1 text-[11px] text-slate-500">{t("halls.updated", { date: formatDateTime(hall.updatedAt) })}</p>
            {hall.id === schedule?.id ? <p className="mt-1 text-[11px] text-slate-400">{t("halls.catalogueCounts", { trainers: workspace.trainers.length, classes: workspace.classTypes.length })}</p> : null}
          </div>
          {hall.id === schedule?.id ? <Chip tone="info">{t("halls.opened")}</Chip> : null}
          <Button size="sm" variant="primary" disabled={busy} onClick={async () => { await reload(hall.id); }}>{t("halls.open")}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => openEditor("rename", hall)}>{t("common.edit")}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => openEditor("duplicate", hall)}>{t("halls.duplicate")}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void exportHall(hall.id)}>{t("halls.export")}</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => setDeleting(hall)}>{t("common.delete")}</Button>
        </li>)}
      </ul>}
      {schedule ? <Button size="sm" variant="ghost" onClick={() => router.push("/schedule")}>{schedule.name} → {t("nav.schedule")}</Button> : null}
    </Panel>}
    {schedule && !migration ? <VersionsPanel /> : null}
    <Modal busy={busy} open={editing !== null} title={editing?.action === "create" ? t("halls.create") : editing?.action === "duplicate" ? t("halls.duplicate") : t("common.edit")} onClose={() => { if (!busy) setEditing(null); }} width={460} footer={<>
      <Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>{t("common.cancel")}</Button>
      <Button type="submit" form={editingFormId} variant="primary" disabled={busy || !name.trim()}>{t("common.save")}</Button>
    </>}>
      <form id={editingFormId} onSubmit={(event) => { event.preventDefault(); void saveEditing(); }}>
        <Field label={t("halls.name")}><TextInput autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></Field>
        {editing?.action === "duplicate" ? <div className="mt-3"><Toggle checked={withoutEvents} onChange={setWithoutEvents} label={t("halls.withoutEvents")} /></div> : null}
      </form>
    </Modal>
    <Modal alert busy={busy} open={deleting !== null} title={t("halls.deleteTitle")} description={deleting?.name} onClose={() => { if (!busy) setDeleting(null); }} width={460} footer={<>
      <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
      <Button variant="danger" disabled={busy} onClick={async () => { if (!deleting) return; setBusy(true); try { if (await scheduleAction("delete", { id: deleting.id })) setDeleting(null); } finally { setBusy(false); } }}>{t("common.delete")}</Button>
    </>}><p className="text-xs text-slate-400">{t("halls.deleteHint")}</p></Modal>
  </div>;
}
