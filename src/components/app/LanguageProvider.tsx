"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createTranslator,
  DEFAULT_LANGUAGE,
  isLanguage,
  localeOf,
  type DictionaryKey,
  type Language,
  type TranslateVars,
  type Translator,
} from "@/lib/i18n";

const STORAGE_KEY = "tn:language";

// The stored language choice lives in localStorage (an external system), so
// the provider subscribes to it instead of copying it into state inside an
// effect. The snapshot is read once per mount — after hydration React switches
// from the server snapshot to the stored one — and is only written from
// explicit user actions, which keeps the previous behaviour of never picking
// up cross-tab changes mid-session.
const languageListeners = new Set<() => void>();
/** `null` until the current mount has taken its single localStorage reading. */
let mountedLanguage: Language | null = null;

function subscribeToLanguage(onStoreChange: () => void): () => void {
  languageListeners.add(onStoreChange);
  return () => {
    languageListeners.delete(onStoreChange);
    if (languageListeners.size === 0) {
      // Last provider unmounted: the next mount reads localStorage again.
      mountedLanguage = null;
    }
  };
}

function readLanguageSnapshot(): Language {
  if (mountedLanguage !== null) return mountedLanguage;
  if (typeof window === "undefined") return DEFAULT_LANGUAGE;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    mountedLanguage = isLanguage(stored) ? stored : DEFAULT_LANGUAGE;
  } catch {
    /* storage unavailable — keep the default */
    mountedLanguage = DEFAULT_LANGUAGE;
  }
  return mountedLanguage;
}

function serverLanguageSnapshot(): Language {
  return DEFAULT_LANGUAGE;
}

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translator;
  locale: string;
  /** Localised weekday name, e.g. "Понеділок". */
  dayName: (dayOfWeek: number) => string;
  /** Localised short weekday label, e.g. "ПН" / "MON". */
  dayShort: (dayOfWeek: number) => string;
  /** Compact weekday label for chips, e.g. "Пн" / "Mon". */
  dayTiny: (dayOfWeek: number) => string;
  formatDateTime: (iso: string, options?: Intl.DateTimeFormatOptions) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  // The server HTML and the hydration render always agree on the default
  // (no hydration mismatch); after hydration React re-reads the store and
  // applies the saved language without a synchronous setState in an effect.
  const language = useSyncExternalStore(subscribeToLanguage, readLanguageSnapshot, serverLanguageSnapshot);

  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    mountedLanguage = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore quota / private mode errors */
    }
    for (const notify of languageListeners) notify();
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const t = createTranslator(language);
    return {
      language,
      setLanguage,
      t,
      locale: localeOf(language),
      dayName: (dayOfWeek: number) => t(`day.${clampDay(dayOfWeek)}` as DictionaryKey),
      dayShort: (dayOfWeek: number) => t(`dayShort.${clampDay(dayOfWeek)}` as DictionaryKey),
      dayTiny: (dayOfWeek: number) => t(`dayTiny.${clampDay(dayOfWeek)}` as DictionaryKey),
      formatDateTime: (iso: string, options?: Intl.DateTimeFormatOptions) =>
        new Date(iso).toLocaleString(localeOf(language), options ?? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }),
    };
  }, [language, setLanguage]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function clampDay(dayOfWeek: number): number {
  if (!Number.isFinite(dayOfWeek)) return 0;
  return Math.max(0, Math.min(6, Math.round(dayOfWeek)));
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside LanguageProvider");
  return context;
}

export type { TranslateVars };
