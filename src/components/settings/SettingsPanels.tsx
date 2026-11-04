"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useWorkspace } from "@/components/app/WorkspaceProvider";
import { useI18n } from "@/components/app/LanguageProvider";
import { Button, Chip, EmptyState, Field, Modal, Panel, SelectInput, TextInput, Toggle } from "@/components/ui/controls";
import { LANGUAGES } from "@/lib/i18n";
import { settingsSchema, type ScheduleSettings } from "@/lib/domain/types";
import { apiRequest } from "@/lib/client/api";
import { readFileAsDataUrl } from "@/lib/export/client-export";
import type { BackupPayload } from "@/lib/server/admin";
import { SelectInput as Select } from "@/components/ui/controls";
import { getTheme, THEME_OPTIONS } from "@/lib/theme/risen-team-dark";
import { cardColors } from "@/lib/theme/color";

const LOGO_LIMIT = 400 * 1024;

interface SafetyBackupInfo {
  name: string;
  size: number;
  modifiedAt: string;
}

/** Shows where the local SQLite database lives and what safety copies exist. */
function StoragePanel() {
  const { t, formatDateTime } = useI18n();
  const [database, setDatabase] = useState<string | null>(null);
  const [backups, setBackups] = useState<SafetyBackupInfo[]>([]);

  const refresh = useCallback(async () => {
    try {
      const health = await apiRequest<{ database?: string }>("/api/health");
      setDatabase(health.database ?? null);
      const listed = await apiRequest<{ backups: SafetyBackupInfo[] }>("/api/workspace/backup?safety=1");
      setBackups(listed.backups ?? []);
    } catch {
      setDatabase(null);
      setBackups([]);
    }
  }, []);

  useEffect(() => {
    // Start the refresh from a promise reaction (the same async boundary as
    // `fetch(...).then(...)`): invoking the loader synchronously inside the
    // effect would cascade renders during the effect flush. The reaction runs
    // right after that flush, before any user interaction can interleave.
    void Promise.resolve().then(() => refresh());
  }, [refresh]);

  return (
    <Panel
      title={t("storage.title")}
      aside={
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          {t("storage.refresh")}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-xs text-slate-400">
        <p>{t("storage.hint")}</p>
        <p>
          {t("storage.database")}:{" "}
          <span className="break-all font-mono text-[11px] text-slate-300">{database ?? "—"}</span>
        </p>
        <div>
          <p className="mb-1 font-semibold text-slate-300">{t("storage.backups")}</p>
          {backups.length === 0 ? (
            <p className="text-[11px] text-slate-500">{t("storage.noBackups")}</p>
          ) : (
            <>
              <p className="mb-1 text-[11px] text-slate-500">
                {t("storage.backupCount", { count: backups.length })}
              </p>
              <ul className="max-h-40 space-y-1 overflow-y-auto">
                {backups.slice(0, 10).map((backup) => (
                  <li key={backup.name} className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="truncate font-mono text-slate-300">{backup.name}</span>
                    <span className="shrink-0 text-slate-500">{formatDateTime(backup.modifiedAt)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

export function SettingsPanels() {
  const { t, language, setLanguage, dayTiny, dayName } = useI18n();
  const { settings, dispatch, saveNow, toast, schedule, workspace, dirty, importBackup, restoreProjectArchive } = useWorkspace();
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const archiveRef = useRef<HTMLInputElement>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const markerErrorId = useId();
  const markerSource = settings.customMarkers.join(", ");
  const [markerDraft, setMarkerDraft] = useState<{ scheduleId: string | undefined; source: string; value: string; invalid: boolean } | null>(null);
  // A draft belongs to the hall and persisted value it was started from.
  // Hall switches and restored settings must not reuse another value's draft.
  const currentMarkerDraft = markerDraft?.scheduleId === schedule?.id && markerDraft?.source === markerSource ? markerDraft : null;
  const [archivePending, setArchivePending] = useState<{ archiveBase64: string; name: string } | null>(null);
  const [importPending, setImportPending] = useState<{ payload: Record<string, unknown>; name: string; mode: "merge" | "replace"; halls: { id: string; name: string }[]; selected: string[]; targetId: string } | null>(null);

  const patch = (changes: Partial<ScheduleSettings>, description?: string) =>
    dispatch({ type: "updateSettings", patch: changes, description });

  const exportBackup = async () => {
    try {
      if (dirty) {
        if (!settings.autosave && !window.confirm(t("halls.saveBeforeExport"))) return;
        if (!(await saveNow())) return;
      }
      const { backup } = await apiRequest<{ backup: BackupPayload }>("/api/workspace/backup");
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `risen-team-schedule-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      toast(t("toast.backupDownloaded"), "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : t("toast.backupFailed"), "error");
    }
  };

  const runImport = async () => {
    if (!importPending) return;
    setExportBusy(true);
    try {
      const selected = new Set(importPending.selected);
      if (!selected.size || importPending.mode === "replace" && (selected.size !== 1 || !importPending.targetId)) return;
      const payload = { ...importPending.payload };
      if (Array.isArray(payload.halls)) payload.halls = payload.halls.filter((item: { id: string }) => selected.has(item.id));
      else {
        for (const key of ["schedules", "events", "settings", "versions"]) {
          if (Array.isArray(payload[key])) payload[key] = (payload[key] as { id?: string; scheduleId?: string }[]).filter((item) => selected.has((key === "schedules" ? item.id : item.scheduleId) ?? ""));
        }
      }
      const result = await importBackup(payload, importPending.mode, importPending.mode === "replace" ? importPending.targetId : undefined);
      toast(
        t("toast.importDone", { schedules: result.schedules, events: result.events, mode: result.mode }),
        "success",
      );
      setImportPending(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : t("toast.importFailed"), "error");
    } finally {
      setExportBusy(false);
    }
  };

  const exportArchive = async () => {
    setExportBusy(true);
    try {
      if (dirty) {
        if (!settings.autosave && !window.confirm(t("halls.saveBeforeExport"))) return;
        if (!(await saveNow())) return;
      }
      const response = await fetch("/api/workspace/project-archive", { cache: "no-store" });
      if (!response.ok) throw new Error(t("toast.backupFailed"));
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `risen-team-project-${new Date().toISOString().slice(0, 10)}.risen-project.gz`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (error) { toast(error instanceof Error ? error.message : t("toast.backupFailed"), "error"); }
    finally { setExportBusy(false); }
  };

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)]">
      {schedule ? <>
      <Panel
        title={t("settings.schedule")}
        aside={
          <Button size="sm" variant="outline" onClick={() => void saveNow({ description: t("history.savedSettings") })}>
            {t("settings.saveNow")}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-[#1a1f2a] bg-[#0b0e14]/60 px-3 py-3">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-300">
              {t("settings.visibleWeekdays")}
            </p>
            <div role="group" aria-label={t("settings.visibleWeekdays")} className="flex flex-wrap gap-1.5">
              {[0, 1, 2, 3, 4, 5, 6].map((index) => {
                const active = settings.visibleDays.includes(index);
                return (
                  <Button
                    key={index}
                    size="sm"
                    variant={active ? "subtle" : "ghost"}
                    aria-pressed={active}
                    onClick={() => {
                      const next = active
                        ? settings.visibleDays.filter((value) => value !== index)
                        : [...settings.visibleDays, index].sort((a, b) => a - b);
                      if (next.length === 0) {
                        toast(t("toast.keepOneDay"), "warning");
                        return;
                      }
                      patch({ visibleDays: next }, t("history.settingsDays"));
                    }}
                    title={dayName(index)}
                  >
                    {dayTiny(index)}
                  </Button>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 rounded-md border border-[#1a1f2a] bg-[#0b0e14]/60 px-3 py-3">
            <Field label={t("settings.starts")}>
              <TextInput
                type="time"
                value={settings.startTime}
                onChange={(event) => patch({ startTime: event.target.value }, t("settings.windowChanged"))}
              />
            </Field>
            <Field label={t("settings.ends")}>
              <TextInput
                type="time"
                value={settings.endTime}
                onChange={(event) => patch({ endTime: event.target.value }, t("settings.windowChanged"))}
              />
            </Field>
            <Field label={t("settings.interval")} hint={t("settings.intervalHint")}>
              <SelectInput
                value={String(settings.defaultInterval)}
                onChange={(event) => patch({ defaultInterval: Number(event.target.value) }, t("settings.intervalChanged"))}
              >
                {[15, 20, 30, 60, 120].map((interval) => (
                  <option key={interval} value={interval}>
                    {t("settings.intervalOption", { count: interval })}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label={t("settings.snap")} hint={t("settings.snapHint")}>
              <SelectInput
                value={String(settings.snapMinutes)}
                onChange={(event) => patch({ snapMinutes: Number(event.target.value) as 5 | 10 | 15 | 30 })}
              >
                {[5, 10, 15, 30].map((value) => (
                  <option key={value} value={value}>
                    {t("settings.minutes", { count: value })}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
          <Field label={t("settings.customMarkers")} hint={t("settings.customMarkersHint")}>
            <TextInput
              value={currentMarkerDraft?.value ?? markerSource}
              aria-invalid={currentMarkerDraft?.invalid || undefined}
              aria-describedby={currentMarkerDraft?.invalid ? markerErrorId : undefined}
              onChange={(event) => setMarkerDraft({ scheduleId: schedule?.id, source: markerSource, value: event.target.value, invalid: false })}
              onBlur={(event) => {
                const value = event.target.value;
                const markers = value.trim() ? value.split(",").map((item) => item.trim()) : [];
                const parsed = settingsSchema.shape.customMarkers.safeParse(markers);
                if (!parsed.success) {
                  setMarkerDraft({ scheduleId: schedule?.id, source: markerSource, value, invalid: true });
                  return;
                }
                if (parsed.data.join(", ") !== markerSource) patch({ customMarkers: parsed.data }, t("settings.markersUpdated"));
                setMarkerDraft(null);
              }}
            />
            {currentMarkerDraft?.invalid ? <span id={markerErrorId} role="alert" className="text-xs text-rose-300">{t("settings.customMarkersInvalid")}</span> : null}
          </Field>
        </div>
      </Panel>

      <Panel title={t("settings.appearance")}>
        <div className="flex flex-col gap-4">
          <Field label={t("settings.language")} hint={t("settings.languageHint")}>
            <div className="flex gap-2">
              {LANGUAGES.map((option) => (
                <Button
                  key={option.value}
                  variant={language === option.value ? "subtle" : "outline"}
                  aria-pressed={language === option.value}
                  onClick={() => setLanguage(option.value)}
                  className="flex-1"
                >
                  {option.nativeLabel}
                </Button>
              ))}
            </div>
          </Field>
          <Field label={t("settings.theme")}>
            <Select value={getTheme(settings.themeId).id} onChange={(event) => patch({ themeId: event.target.value })}>
              {THEME_OPTIONS.map(option => <option key={option.id} value={option.id}>{t(option.nameKey)}</option>)}
            </Select>
          </Field>
          <div role="group" aria-label={t("theme.previewLabel")} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {THEME_OPTIONS.map(option => {
              const theme = getTheme(option.id);
              const selected = getTheme(settings.themeId).id === option.id;
              return <button key={option.id} type="button" aria-pressed={selected} onClick={() => patch({ themeId: option.id })}
                className={`min-w-0 rounded-md border p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 ${selected ? "border-rose-500" : "border-[#303030] hover:border-[#666666]"}`}
                style={{ background: theme.canvas.background }}>
                <svg aria-hidden="true" viewBox="0 0 120 76" className="mb-2 w-full rounded-sm">
                  <rect x="1" y="1" width="118" height="74" rx={theme.canvas.radius / 2} fill={theme.canvas.background} stroke={theme.canvas.border} />
                  <rect x="8" y="9" width="43" height="4" fill={theme.header.titleColor} />
                  <rect x="8" y="19" width="74" height="2" fill={theme.days.accent} />
                  {[0, 1, 2].map(column => <g key={column}>
                    <line x1={10 + column * 25} y1="27" x2={10 + column * 25} y2="66" stroke={theme.grid.verticalStrong} />
                    <rect x={13 + column * 25} y={29 + column * 5} width="20" height="26" rx={theme.cards.radius / 3}
                      fill={cardColors(["#8b5cf6", "#22c55e", "#f59e0b"][column], { card: theme.cards.cardSurface, text: theme.cards.cardText, muted: theme.cards.cardMuted }).background}
                      stroke={["#8b5cf6", "#22c55e", "#f59e0b"][column]} />
                    <rect x={17 + column * 25} y={35 + column * 5} width="12" height="2" fill={theme.cards.cardText} />
                    <rect x={17 + column * 25} y={41 + column * 5} width="9" height="2" fill={theme.cards.cardMuted} />
                  </g>)}
                  <rect x="91" y="9" width="19" height="57" fill={theme.brand.background} stroke={theme.brand.border} />
                  <rect x="96" y="16" width="9" height="3" fill={theme.days.accent} />
                </svg>
                <span className="block text-xs font-semibold" style={{ color: theme.header.titleColor }}>{t(option.nameKey)}</span>
                <span className="mt-1 block text-[11px] leading-snug" style={{ color: theme.header.subtitleColor }}>{t(option.descriptionKey)}</span>
              </button>;
            })}
          </div>
          <p className="text-xs text-slate-400">{t("theme.scopeHint")}</p>
          <Toggle
            checked={settings.showTrainerLegend}
            onChange={(value) => patch({ showTrainerLegend: value })}
            label={t("settings.showLegend")}
            description={t("settings.showLegendHint")}
          />
          {settings.showTrainerLegend ? (
            <Field label={t("settings.legendPosition")}>
              <SelectInput
                value={settings.legendPosition}
                onChange={(event) => patch({ legendPosition: event.target.value === "bottom" ? "bottom" : "right" })}
              >
                <option value="right">{t("settings.legendRight")}</option>
                <option value="bottom">{t("settings.legendBottom")}</option>
              </SelectInput>
            </Field>
          ) : null}
          <div className="grid grid-cols-1 gap-3 rounded-md border border-[#1a1f2a] bg-[#0b0e14]/60 px-3 py-3 md:grid-cols-2">
            <Field label={t("settings.scheduleTitle")}>
              <TextInput value={settings.scheduleTitle} onChange={(event) => patch({ scheduleTitle: event.target.value })} />
            </Field>
            <Field label={t("settings.subtitle")}>
              <TextInput
                value={settings.scheduleSubtitle}
                onChange={(event) => patch({ scheduleSubtitle: event.target.value })}
              />
            </Field>
            <Field label={t("settings.effectiveDate")} hint={t("settings.effectiveDateHint")}>
              <TextInput
                value={settings.effectiveDate ?? ""}
                onChange={(event) => patch({ effectiveDate: event.target.value || null })}
              />
            </Field>
            <Field label={t("settings.logo")}>
              <span className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                  {t("settings.uploadLogo")}
                </Button>
                {settings.logoDataUrl ? (
                  <Button size="sm" variant="ghost" onClick={() => patch({ logoDataUrl: null })}>
                    {t("settings.removeLogo")}
                  </Button>
                ) : (
                  <Chip tone="neutral">{t("settings.noLogo")}</Chip>
                )}
              </span>
            </Field>
          </div>
          {settings.logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={settings.logoDataUrl} alt={t("settings.currentLogo")} className="h-14 w-auto object-contain" />
          ) : null}
          <Toggle
            checked={settings.showLogo}
            onChange={(value) => patch({ showLogo: value })}
            label={t("settings.logoRail")}
            description={t("settings.logoRailHint")}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              try {
                const dataUrl = await readFileAsDataUrl(file, LOGO_LIMIT);
                patch({ logoDataUrl: dataUrl }, t("history.logoUpdated"));
                toast(t("toast.logoUpdated"), "success");
              } catch (error) {
                toast(error instanceof Error ? error.message : t("toast.logoUnreadable"), "error");
              }
            }}
          />
        </div>
      </Panel>

      <Panel title={t("settings.exportDefaults")}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("settings.format")}>
            <SelectInput
              value={settings.exportPaper}
              onChange={(event) =>
                patch({ exportPaper: event.target.value as ScheduleSettings["exportPaper"] })
              }
            >
              <option value="original">{t("export.originalRatio")}</option>
              <option value="a4">A4</option>
              <option value="a3">A3</option>
              <option value="custom">{t("export.custom")}</option>
            </SelectInput>
          </Field>
          <Field label={t("settings.orientation")}>
            <SelectInput
              value={settings.exportOrientation}
              onChange={(event) =>
                patch({ exportOrientation: event.target.value === "portrait" ? "portrait" : "landscape" })
              }
            >
              <option value="landscape">{t("export.landscape")}</option>
              <option value="portrait">{t("export.portrait")}</option>
            </SelectInput>
          </Field>
          <Field label={t("settings.pngScale")}>
            <SelectInput
              value={String(settings.exportScale)}
              onChange={(event) => patch({ exportScale: Number(event.target.value) as 1 | 2 | 3 | 4 })}
            >
              {[1, 2, 3, 4].map((scale) => (
                <option key={scale} value={scale}>
                  {scale}x
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label={t("settings.customSize")}>
            <span className="flex items-center gap-2">
              <TextInput
                type="number"
                value={settings.customExportWidth}
                onChange={(event) => patch({ customExportWidth: Number(event.target.value) || 1680 })}
              />
              <TextInput
                type="number"
                value={settings.customExportHeight}
                onChange={(event) => patch({ customExportHeight: Number(event.target.value) || 880 })}
              />
            </span>
          </Field>
        </div>
        <p className="mt-3 text-[11px] text-slate-500">{t("settings.exportDefaultsHint")}</p>
      </Panel>

      </> : <EmptyState title={t("halls.empty")} hint={t("halls.emptyHint")} />}
      <Panel title={`${t("settings.general")} · ${schedule?.name ?? ""}`}>
        <div className="flex flex-col gap-3">
          {schedule ? <Toggle
            checked={settings.autosave}
            onChange={(value) => patch({ autosave: value })}
            label={t("settings.autosave")}
            description={t("settings.autosaveHint")}
          /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void exportBackup()}>
              {t("settings.exportBackup")}
            </Button>
            <Button variant="outline" onClick={() => importRef.current?.click()}>
              {t("settings.importBackup")}
            </Button>
            <span className="text-[11px] text-slate-500">{t("settings.backupIncludes")}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={exportBusy} onClick={() => void exportArchive()}>{t("halls.archiveExport")}</Button>
            <Button variant="outline" disabled={exportBusy} onClick={() => archiveRef.current?.click()}>{t("halls.archiveRestore")}</Button>
          </div>
          <input ref={archiveRef} type="file" accept=".gz,.risen-project.gz,application/gzip" className="hidden" onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            try {
              if (file.size > 32 * 1024 * 1024) throw new Error(t("toast.importFailed"));
              const dataUrl = await readFileAsDataUrl(file, 32 * 1024 * 1024);
              setArchivePending({ archiveBase64: dataUrl.slice(dataUrl.indexOf(",") + 1), name: file.name });
            } catch (error) { toast(error instanceof Error ? error.message : t("toast.importFailed"), "error"); }
          }} />
          <input
            ref={importRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              try {
                if (file.size > 64 * 1024 * 1024) throw new Error("oversized import");
                const payload: unknown = JSON.parse(await file.text());
                if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid import");
                const record = payload as Record<string, unknown>;
                const list = record.formatVersion === 2 ? record.halls : record.schedules;
                if (!Array.isArray(list) || !list.length || list.some((item) => !item || typeof item.id !== "string" || typeof item.name !== "string")) throw new Error("invalid hall list");
                const halls = list.map((item: { id: string; name: string }) => ({ id: item.id, name: item.name }));
                if (new Set(halls.map((item) => item.id)).size !== halls.length) throw new Error("duplicate hall IDs");
                setImportPending({ payload: record, name: file.name, mode: "merge", halls, selected: halls.map((item) => item.id), targetId: schedule?.id ?? "" });
              } catch {
                toast(t("toast.importInvalidJson"), "error");
              }
            }}
          />
          <p className="text-[11px] text-slate-500">{t("settings.importHint")}</p>
  </div>
      </Panel>

      <StoragePanel />

      <Modal alert busy={exportBusy} open={archivePending !== null} title={t("halls.archiveRestore")} description={archivePending?.name} onClose={() => { if (!exportBusy) setArchivePending(null); }} width={520} footer={<>
        <Button variant="ghost" disabled={exportBusy} onClick={() => setArchivePending(null)}>{t("common.cancel")}</Button>
        <Button variant="danger" disabled={exportBusy} onClick={async () => {
          if (!archivePending) return;
          setExportBusy(true);
          try {
            if (await restoreProjectArchive(archivePending.archiveBase64)) setArchivePending(null);
          } catch (error) { toast(error instanceof Error ? error.message : t("toast.importFailed"), "error"); }
          finally { setExportBusy(false); }
        }}>{t("halls.archiveRestore")}</Button>
      </>}><p className="text-xs text-slate-400">{t("halls.archiveRestoreHint")}</p></Modal>

      <Modal
        open={importPending !== null}
        title={t("settings.importTitle")}
        description={importPending?.name}
        onClose={() => setImportPending(null)}
        width={520}
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportPending(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={exportBusy || !importPending?.selected.length || importPending.mode === "replace" && (importPending.selected.length !== 1 || !importPending.targetId)} onClick={() => void runImport()}>
              {exportBusy ? t("common.saving") : t("settings.importAction")}
            </Button>
          </>
        }
      >
        <p className="text-xs text-slate-400">{t("settings.importConfirm")}</p>
        <Field label={t("halls.importSelect")} className="mt-3">
          <div className="space-y-2">{importPending?.halls.map((hall) => <label key={hall.id} className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={importPending.selected.includes(hall.id)} onChange={(event) => setImportPending((current) => current ? { ...current, selected: event.target.checked ? [...current.selected, hall.id] : current.selected.filter((id) => id !== hall.id) } : current)} />{hall.name}</label>)}</div>
        </Field>
        <Field label={t("settings.importMode")} className="mt-3"><SelectInput value={importPending?.mode ?? "merge"} onChange={(event) => setImportPending((current) => current ? { ...current, mode: event.target.value as "merge" | "replace" } : current)}>
          <option value="merge">{t("halls.importNew")}</option><option value="replace" disabled={!workspace?.schedules.length}>{t("halls.importReplace")}</option>
        </SelectInput></Field>
        {importPending?.mode === "replace" ? <Field label={t("halls.importTarget")} hint={t("halls.importReplaceHint")} className="mt-3"><SelectInput value={importPending.targetId} onChange={(event) => setImportPending((current) => current ? { ...current, targetId: event.target.value } : current)}>
          <option value="">—</option>{workspace?.schedules.map((hall) => <option key={hall.id} value={hall.id}>{hall.name}</option>)}
        </SelectInput></Field> : null}
      </Modal>
    </div>
  );
}
