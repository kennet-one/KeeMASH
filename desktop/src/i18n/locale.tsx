import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { english, interpolate, type TranslationKey, type TranslationValues, ukrainian } from "./catalog";

export type LocaleMode = "en" | "uk";

const STORAGE_KEY = "keemash.locale.mode";

export function readLocaleMode(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): LocaleMode {
  const saved = storage?.getItem(STORAGE_KEY);
  return saved === "uk" ? "uk" : "en";
}

export function translations(key: TranslationKey, values: TranslationValues = {}) {
  return { en: interpolate(english[key], values), uk: interpolate(ukrainian[key], values) };
}

export function localizedString(mode: LocaleMode, key: TranslationKey, values: TranslationValues = {}): string {
  const pair = translations(key, values);
  return mode === "en" ? pair.en : pair.uk;
}

interface LocaleContextValue {
  mode: LocaleMode;
  setMode: (mode: LocaleMode) => void;
  text: (key: TranslationKey, values?: TranslationValues) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<LocaleMode>(() => readLocaleMode());
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
    document.documentElement.lang = mode === "uk" ? "uk" : "en";
    document.documentElement.dataset.locale = mode;
  }, [mode]);
  const value = useMemo<LocaleContextValue>(() => ({
    mode,
    setMode: setModeState,
    text: (key, values) => localizedString(mode, key, values),
  }), [mode]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useLocale must be used inside LocaleProvider");
  return value;
}

export function LocalizedText({ textKey, values, className = "" }: { textKey: TranslationKey; values?: TranslationValues; className?: string }) {
  const { mode } = useLocale();
  const pair = translations(textKey, values);
  return <span className={className}>{mode === "en" ? pair.en : pair.uk}</span>;
}
