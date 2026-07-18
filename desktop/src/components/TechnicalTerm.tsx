import { CircleHelp } from "lucide-react";
import { findGlossaryEntry } from "../i18n/glossary";
import { useLocale } from "../i18n/locale";

export function TechnicalTerm({ term, showLabel = true, fallback = false }: { term: string; showLabel?: boolean; fallback?: boolean }) {
  const { text } = useLocale();
  const entry = findGlossaryEntry(term);
  if (!entry && !fallback) return showLabel ? <>{term}</> : null;
  const explanation = entry?.explanation ?? text("technical.unverified");
  const accessible = `${text("technical.explanation", { term })}: ${explanation}`;
  return (
    <span className="technical-term">
      {showLabel && <span>{term}</span>}
      <button className="technical-help" type="button" aria-label={accessible} title={accessible}>
        <CircleHelp size={13} aria-hidden="true" />
        <span className="technical-tooltip" role="tooltip" lang="uk">
          <strong>{term}</strong>
          <span>{explanation}</span>
          {entry && <small>{text("technical.provenance", { value: entry.provenance })}</small>}
          {entry?.warning && <em>{entry.warning}</em>}
        </span>
      </button>
    </span>
  );
}
