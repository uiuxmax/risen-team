"use client";

import { useState } from "react";
import { useWorkspace } from "@/components/app/WorkspaceProvider";
import { Button, Chip, EmptyState, Modal, Panel, TextInput } from "@/components/ui/controls";
import { useI18n } from "@/components/app/LanguageProvider";
import type { DictionaryKey } from "@/lib/i18n";

const SOURCE_LABELS: Record<string, { labelKey: DictionaryKey; tone: "neutral" | "success" | "warning" | "info" | "danger" }> = {
  automatic: { labelKey: "versions.sourceAutomatic", tone: "neutral" },
  manual: { labelKey: "versions.sourceManual", tone: "info" },
  publish: { labelKey: "versions.sourcePublish", tone: "success" },
  restore: { labelKey: "versions.sourceRestore", tone: "warning" },
  import: { labelKey: "versions.sourceImport", tone: "info" },
  seed: { labelKey: "versions.sourceSeed", tone: "neutral" },
};

function useWhen() {
  const { t, locale } = useI18n();
  return (iso: string): string => {
    const date = new Date(iso);
    const sameDay = date.toDateString() === new Date().toDateString();
    const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return t("versions.today", { time });
    return `${date.toLocaleDateString(locale, { day: "2-digit", month: "short" })} ${time}`;
  };
}

export function VersionsPanel() {
  const { t } = useI18n();
  const when = useWhen();
  const { versions, createSnapshot, restoreVersion, toast } = useWorkspace();
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [snapshotName, setSnapshotName] = useState("");
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);


  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Panel
        title={t("halls.history")}
        aside={
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSnapshotName("");
                setSnapshotError(null);
                setSnapshotOpen(true);
              }}
            >
              {t("versions.saveCheckpoint")}
            </Button>

          </span>
        }
      >
        {versions.length === 0 ? (
          <EmptyState title={t("versions.empty")} hint={t("versions.emptyHint")} />
        ) : (
          <ul className="divide-y divide-[#171b24]">
            {versions.map((version, index) => {
              const meta = SOURCE_LABELS[version.source] ?? SOURCE_LABELS.automatic;
              const current = index === 0;
              return (
                <li
                  key={version.id}
                  className={`grid grid-cols-1 items-center gap-2 py-2.5 md:grid-cols-[150px_150px_minmax(0,1fr)_92px_128px] ${
                    current ? "bg-sky-950/10" : version.source === "publish" ? "bg-emerald-950/10" : ""
                  }`}
                >
                  <span className="font-mono text-xs tabular-nums text-slate-300">{when(version.createdAt)}</span>
                  <Chip tone={meta.tone} className="justify-self-start">{t(meta.labelKey)}</Chip>
                  <span className="min-w-0 text-xs leading-5 text-slate-400">
                    {version.description || t("versions.descriptionFallback")}
                  </span>
                  <span>{current ? <Chip tone="info">{t("common.latest")}</Chip> : null}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="justify-self-start md:justify-self-end"
                    onClick={() => setPendingRestore(version.id)}
                    title={t("versions.restore")}
                  >
                    {t("versions.restore")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <div className="flex flex-col gap-4">
        <Panel title={t("versions.howRestore")}>
          <ul className="space-y-2 text-xs text-slate-400">
            <li>{t("versions.howRestore1")}</li>
            <li>{t("versions.howRestore2")}</li>
            <li>{t("versions.howRestore3")}</li>
          </ul>
        </Panel>
      </div>

      <Modal
        open={snapshotOpen}
        busy={busy}
        title={t("dialog.snapshotTitle")}
        description={t("versions.snapshotDescription")}
        onClose={() => setSnapshotOpen(false)}
        width={460}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setSnapshotOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true); setSnapshotError(null);
                try {
                  if (await createSnapshot(snapshotName.trim() || t("history.manualSnapshot"))) setSnapshotOpen(false);
                  else setSnapshotError(t("toast.saveFailedPlain"));
                } catch (cause) { setSnapshotError(cause instanceof Error ? cause.message : t("toast.saveFailedPlain")); }
                finally {setBusy(false);}
              }}
            >
              {busy ? t("common.saving") : t("versions.saveCheckpoint")}
            </Button>
          </>
        }
      >
        <TextInput
          autoFocus
          value={snapshotName}
          placeholder={t("versions.renamePlaceholder")}
          onChange={(event) => setSnapshotName(event.target.value)}
        />
        {snapshotError ? <p role="alert" className="mt-3 text-xs text-rose-300">{snapshotError}</p> : null}
      </Modal>

      <Modal
        open={pendingRestore !== null}
        alert
        busy={busy}
        title={t("versions.restoreTitle")}
        description={t("versions.restoreSubtitle")}
        onClose={() => setPendingRestore(null)}
        width={440}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setPendingRestore(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                if (!pendingRestore) return;
                setBusy(true);
                try {
                  await restoreVersion(pendingRestore);
                  setPendingRestore(null);
                } catch (error) {
                  toast(error instanceof Error ? error.message : t("toast.restoreFailed"), "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? t("versions.restoring") : t("versions.restoreAction")}
            </Button>
          </>
        }
      >
        <p className="text-xs text-slate-400">{t("versions.restoreWarning")}</p>
      </Modal>
    </div>
  );
}
