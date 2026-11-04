import { en, uk, type DictionaryKey } from "@/lib/i18n/dictionaries";

export type Language = "en" | "uk";

export const LANGUAGES: { value: Language; labelKey: DictionaryKey; nativeLabel: string }[] = [
  { value: "en", labelKey: "settings.languageEn", nativeLabel: "English" },
  { value: "uk", labelKey: "settings.languageUk", nativeLabel: "Українська" },
];

export const DICTIONARIES: Record<Language, Record<DictionaryKey, string>> = { en, uk };

/**
 * Risen Team is a Ukrainian-first product: the interface opens in Ukrainian
 * unless the operator intentionally switches to English.
 */
export const DEFAULT_LANGUAGE: Language = "uk";

export type TranslateVars = Record<string, string | number>;

/**
 * Translator type used across the app (React components and pure logic alike).
 * Pure modules (conflict detection, editor change log) accept an optional
 * translator and fall back to English, so they stay testable and framework-free.
 */
export type Translator = (key: DictionaryKey, vars?: TranslateVars) => string;

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "uk";
}

export function translate(language: Language, key: DictionaryKey, vars?: TranslateVars): string {
  const dictionary = DICTIONARIES[language] ?? en;
  const template = dictionary[key] ?? en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, token: string) =>
    token in vars ? String(vars[token]) : match,
  );
}

export const englishTranslator: Translator = (key, vars) => translate("en", key, vars);

export function createTranslator(language: Language): Translator {
  return (key, vars) => translate(language, key, vars);
}

/** Locale string handed to Intl / toLocaleString so dates and times match the UI language. */
export function localeOf(language: Language): string {
  return language === "uk" ? "uk-UA" : "en-GB";
}

export type { DictionaryKey };
