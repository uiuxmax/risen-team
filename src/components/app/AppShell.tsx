"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { useEffect } from "react";
import { useWorkspace } from "@/components/app/WorkspaceProvider";
import { useI18n } from "@/components/app/LanguageProvider";
import { Button, Chip } from "@/components/ui/controls";
import { getTheme } from "@/lib/theme/risen-team-dark";

const NAV = [
  { href: "/schedule", key: "nav.schedule" },
  { href: "/halls", key: "nav.halls" },
  { href: "/manage", key: "nav.manage" },
  { href: "/settings", key: "nav.settings" },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { t, formatDateTime, language, setLanguage } = useI18n();
  const {
    settings,
    saveStatus,
    mutationBusy,
    savedAt,
    dirty,
    saveConflict,
    loadError,
    toasts,
    dismissToast,
    recovery,
    acceptRecovery,
    discardRecovery,
    reload,
    runUndo,
    runRedo,
  } = useWorkspace();
  const theme = getTheme(settings.themeId);
  const themeStyle = {
    "--ui-background": theme.canvas.background,
    "--ui-surface": theme.brand.background,
    "--ui-control": theme.cards.cardSurface,
    "--ui-border": theme.canvas.border,
    "--ui-divider": theme.days.divider,
    "--ui-text": theme.header.titleColor,
    "--ui-muted": theme.header.subtitleColor,
    "--ui-radius": `${theme.cards.radius}px`,
  } as CSSProperties;

  // Editor shortcuts that must work anywhere in the app.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (typing) return;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) runRedo();
        else runUndo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [runUndo, runRedo]);

  return (
    <div className="min-h-dvh bg-[var(--ui-background)] text-[var(--ui-text)]" style={themeStyle} data-theme={theme.id} aria-busy={mutationBusy}>
      <div inert={mutationBusy}>
      <header className="no-print sticky top-0 z-40 border-b border-[var(--ui-divider)] bg-[var(--ui-surface)] backdrop-blur">
        <div className="mx-auto grid max-w-[2048px] grid-cols-1 items-center gap-2 px-4 py-2.5 md:grid-cols-[1fr_auto_1fr] md:gap-4">
          <Link href="/schedule" aria-label={`Risen Team — ${t("app.product")}`} className="flex items-center gap-2 justify-self-start">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-sign.svg" alt="" width={28} height={28} className="h-7 w-7 object-contain" />
            <span className="hidden text-sm font-semibold text-slate-200 sm:block">{t("app.product")}</span>
          </Link>
          <nav className="flex flex-wrap items-center justify-center gap-1 justify-self-center">
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-[var(--ui-radius)] px-3 py-1.5 text-xs font-medium transition-colors ${
                    active ? "bg-[var(--ui-control)] text-white" : "text-slate-400 hover:bg-[#141821] hover:text-slate-200"
                  }`}
                >
                  {t(item.key)}
                </Link>
              );
            })}
          </nav>
          <div className="flex flex-wrap items-center justify-center gap-2 justify-self-center md:justify-self-end">
            <div className="flex items-center" role="status" aria-live="polite" data-save-status>
              <SaveIndicator status={saveStatus} savedAt={savedAt} dirty={dirty} />
            </div>
            <div className="flex items-center gap-1 rounded-[var(--ui-radius)] border border-[var(--ui-border)] bg-[var(--ui-control)] p-0.5" role="group" aria-label={t("settings.language")}>
              {(["en", "uk"] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setLanguage(code)}
                  aria-pressed={language === code}
                  className={`rounded px-2 py-1 text-[11px] font-semibold uppercase transition-colors ${
                    language === code ? "bg-[#232936] text-white" : "text-slate-500 hover:text-slate-200"
                  }`}
                >
                  {code === "en" ? "EN" : "УКР"}
                </button>
              ))}
            </div>
            <Button size="sm" variant="ghost" onClick={() => void reload()}>
              {t("app.refresh")}
            </Button>
          </div>
        </div>
      </header>

      {saveConflict ? (
        <div role="alert" className="no-print flex flex-wrap items-center gap-3 border-b border-amber-900/50 bg-amber-950/25 px-4 py-2 text-xs text-amber-100">
          <span>{t("recovery.conflict")}</span>
          <Button size="sm" variant="outline" onClick={() => void reload()}>{t("app.refresh")}</Button>
        </div>
      ) : null}

      {loadError ? (
        <div className="no-print border-b border-rose-900/50 bg-rose-950/30 px-4 py-2 text-xs text-rose-200">
          {loadError}{" "}
          <button type="button" className="underline" onClick={() => void reload()}>
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      {recovery ? (
        <div className="no-print flex flex-wrap items-center gap-3 border-b border-amber-900/50 bg-amber-950/25 px-4 py-2 text-xs text-amber-100">
          <span>{t("recovery.message", { time: formatDateTime(new Date(recovery.clientUpdatedAt).toISOString()) })}</span>
          <Button size="sm" variant="primary" onClick={acceptRecovery}>
            {t("recovery.restore")}
          </Button>
          <Button size="sm" variant="ghost" onClick={discardRecovery}>
            {t("recovery.discard")}
          </Button>
        </div>
      ) : null}

      <main className="mx-auto max-w-[2048px] px-4 py-4">{children}</main>

      <div role="log" aria-live="polite" aria-relevant="additions" className="no-print pointer-events-none fixed left-4 right-4 z-50 flex flex-col gap-2 sm:left-auto sm:w-80" style={{bottom:"max(1rem, env(safe-area-inset-bottom))"}}>
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            onClick={() => dismissToast(toast.id)}
            className={`pointer-events-auto rounded-[var(--ui-radius)] border px-3 py-2 text-left text-xs shadow-lg ${
              toast.kind === "error"
                ? "border-rose-800/70 bg-rose-950/90 text-rose-100"
                : toast.kind === "success"
                  ? "border-emerald-800/70 bg-emerald-950/90 text-emerald-100"
                  : toast.kind === "warning"
                    ? "border-amber-800/70 bg-amber-950/90 text-amber-100"
                    : "border-[#2a3040] bg-[var(--ui-control)]/95 text-slate-200"
            }`}
          >
            {toast.message}
          </button>
        ))}
      </div>
      </div>
      {mutationBusy ? (
        <div role="status" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 text-sm text-white">
          {t("save.saving")}
        </div>
      ) : null}
    </div>
  );
}

export function SaveIndicator({
  status,
  savedAt,
  dirty,
}: {
  status: "idle" | "saving" | "saved" | "error";
  savedAt: string | null;
  dirty: boolean;
}) {
  const { t, locale } = useI18n();
  if (status === "saving") {
    return (
      <Chip tone="info">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> {t("save.saving")}
      </Chip>
    );
  }
  if (status === "error") return <Chip tone="danger">{t("save.error")}</Chip>;
  if (dirty) return <Chip tone="warning">{t("save.dirty")}</Chip>;
  if (status === "saved") {
    return (
      <Chip tone="success">
        {t("save.saved", {
          time: savedAt ? new Date(savedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : "",
        })}
      </Chip>
    );
  }
  return <Chip tone="neutral">{t("save.upToDate")}</Chip>;
}
