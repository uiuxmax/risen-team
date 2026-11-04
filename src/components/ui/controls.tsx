"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { TRAINER_PALETTE } from "@/lib/domain/types";
import { useI18n } from "@/components/app/LanguageProvider";

type ButtonVariant = "primary" | "outline" | "ghost" | "danger" | "subtle";

export function Button({
  variant = "outline",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-[var(--ui-radius)] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/70 focus-visible:ring-offset-1 focus-visible:ring-offset-[#0a0b0f] disabled:cursor-not-allowed disabled:opacity-45";
  const sizes = size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm";
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-rose-600 text-white hover:bg-rose-500",
    outline: "border border-[var(--ui-border)] bg-[var(--ui-control)] text-slate-200 hover:border-[#39404f] hover:bg-[#171b25]",
    ghost: "text-slate-300 hover:bg-[#161a23] hover:text-white",
    danger: "border border-rose-800/60 bg-rose-950/40 text-rose-200 hover:bg-rose-900/50",
    subtle: "bg-[#1b2029] text-slate-200 hover:bg-[#232936]",
  };
  return (
    <button type="button" className={`${base} ${sizes} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Chip({
  children,
  tone = "neutral",
  className = "",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  className?: string;
  title?: string;
}) {
  const tones = {
    neutral: "border-[#2b3140] bg-[#161a23] text-slate-300",
    success: "border-emerald-800/60 bg-emerald-950/40 text-emerald-300",
    warning: "border-amber-800/60 bg-amber-950/40 text-amber-300",
    danger: "border-rose-800/60 bg-rose-950/40 text-rose-300",
    info: "border-sky-800/60 bg-sky-950/40 text-sky-300",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-slate-500">{hint}</span> : null}
    </label>
  );
}

const inputClass =
  "w-full rounded-[var(--ui-radius)] border border-[var(--ui-border)] bg-[var(--ui-control)] px-2.5 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-rose-600/70 focus:outline-none focus:ring-1 focus:ring-rose-600/40";

export function TextInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${inputClass} ${className}`} {...rest} />;
}

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${inputClass} min-h-[72px] ${className}`} {...rest} />;
}

export function SelectInput({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${inputClass} appearance-none pr-8 ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 rounded-[var(--ui-radius)] border border-[var(--ui-border)] bg-[var(--ui-control)] px-3 py-2.5 text-left transition-colors hover:border-[#333a4b]"
    >
      <span>
        <span className="block text-sm text-slate-200">{label}</span>
        {description ? <span className="block text-[11px] text-slate-500">{description}</span> : null}
      </span>
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-rose-600" : "bg-[#2c3242]"}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-4.5" : "left-0.5"}`}
          style={{ left: checked ? 18 : 2 }}
        />
      </span>
    </button>
  );
}

export function TimeField({
  value,
  onChange,
  label,
  stepMinutes = 5,
  markers = [],
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  stepMinutes?: number;
  markers?: string[];
}) {
  const id = useId();
  const { t } = useI18n();
  const shift = (delta: number) => {
    const [hours, minutes] = value.split(":").map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return;
    const total = Math.max(0, Math.min(23 * 60 + 55, hours * 60 + minutes + delta));
    onChange(`${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</label>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="subtle" onClick={() => shift(-5)} title={t("time.fiveEarlier")} aria-label={`${label}: ${t("time.fiveEarlier")}`}>
          −5
        </Button>
        <input
          id={id}
          type="time"
          step={stepMinutes * 60}
          value={value}
          list={markers.length > 0 ? `${id}-markers` : undefined}
          onChange={(event) => onChange(event.target.value)}
          className={`${inputClass} text-center font-mono`}
        />
        <Button size="sm" variant="subtle" onClick={() => shift(5)} title={t("time.fiveLater")} aria-label={`${label}: ${t("time.fiveLater")}`}>
          +5
        </Button>
      </div>
      {markers.length > 0 ? (
        <datalist id={`${id}-markers`}>
          {markers.map((marker) => (
            <option key={marker} value={marker} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}

export function ColorPicker({
  value,
  onChange,
  palette = TRAINER_PALETTE,
}: {
  value: string;
  onChange: (value: string) => void;
  palette?: { name: string; value: string }[];
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{t("manage.color")}</span>
      <div className="flex flex-wrap gap-2">
        {palette.map((color) => (
          <button
            key={color.value}
            type="button"
            title={color.name}
            aria-label={color.name}
            aria-pressed={value.toLowerCase() === color.value.toLowerCase()}
            onClick={() => onChange(color.value)}
            className={`h-7 w-7 rounded-full border-2 transition-transform focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 ${
              value.toLowerCase() === color.value.toLowerCase()
                ? "border-white scale-110"
                : "border-transparent hover:scale-105"
            }`}
            style={{ backgroundColor: color.value }}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-7 w-9 cursor-pointer rounded border border-[var(--ui-border)] bg-[var(--ui-control)]"
          aria-label={t("manage.customColor")}
        />
        <span className="font-mono text-slate-500">{value.toUpperCase()}</span>
      </div>
    </div>
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  width = 560,
  busy = false,
  alert = false,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  busy?: boolean;
  alert?: boolean;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  // React can autofocus a child during commit, before the opening effect.
  // Capture the opener on each open transition, including retained modals.
  const openingFocus = useMemo(() =>
    open && typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  [open]);
  const backdropPress = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previous = active && dialog.contains(active) ? openingFocus : active;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open, openingFocus]);

  if (!open) return null;
  return (
    <dialog
      ref={dialogRef}
      role={alert ? "alertdialog" : "dialog"}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy}
      className="risen-modal fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none overflow-y-auto border-0 bg-transparent p-4 pt-12 text-inherit open:flex open:items-start open:justify-center"
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => { backdropPress.current = event.target === event.currentTarget; }}
      onClick={(event) => { if (!busy && backdropPress.current && event.target === event.currentTarget) onClose(); backdropPress.current = false; }}
    >
      <div
        className="w-full rounded-[var(--ui-radius)] border border-[var(--ui-border)] bg-[var(--ui-control)] text-slate-100 shadow-2xl"
        style={{ maxWidth: width }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--ui-divider)] px-4 py-3">
          <div>
            <h2 id={titleId} className="text-balance text-sm font-semibold text-slate-100">{title}</h2>
            {description ? <p id={descriptionId} className="mt-0.5 text-pretty text-xs text-slate-400">{description}</p> : null}
          </div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </Button>
        </header>
        <div className="px-4 py-4" inert={busy}>{children}</div>
        {footer ? <footer inert={busy} className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--ui-divider)] px-4 py-3">{footer}</footer> : null}
      </div>
    </dialog>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--ui-radius)] border border-dashed border-[#2a3040] bg-[var(--ui-control)] px-6 py-10 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-slate-500">{hint}</p> : null}
      {action}
    </div>
  );
}

export function Panel({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-[var(--ui-radius)] border border-[var(--ui-border)] bg-[var(--ui-surface)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--ui-divider)] px-4 py-2">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-300">{title}</h3>
        {aside}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}
