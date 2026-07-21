import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { english, interpolate, ukrainian } from "./catalog";
import { findGlossaryEntry } from "./glossary";
import { localizedString, readLocaleMode, translations } from "./locale";

describe("KeeMASH localization", () => {
  it("keeps English and Ukrainian catalogs in exact key parity", () => {
    expect(Object.keys(ukrainian).sort()).toEqual(Object.keys(english).sort());
    expect(Object.values(english).every(Boolean)).toBe(true);
    expect(Object.values(ukrainian).every(Boolean)).toBe(true);
  });

  it("interpolates known values and preserves unknown placeholders", () => {
    expect(interpolate("Version {version}: {missing}", { version: "0.3.0" })).toBe("Version 0.3.0: {missing}");
    expect(translations("update.version", { version: "0.3.0" })).toEqual({ en: "Version 0.3.0", uk: "Версія 0.3.0" });
  });

  it("defaults to English and restores supported modes only", () => {
    expect(readLocaleMode(null)).toBe("en");
    expect(readLocaleMode({ getItem: () => "uk" })).toBe("uk");
    expect(readLocaleMode({ getItem: () => "both" })).toBe("en");
    expect(readLocaleMode({ getItem: () => "pl" })).toBe("en");
    expect(localizedString("en", "common.retry")).toBe(english["common.retry"]);
    expect(localizedString("uk", "common.retry")).toBe(ukrainian["common.retry"]);
  });

  it("has curated firmware explanations and an honest unknown fallback", () => {
    expect(findGlossaryEntry("Power Down Mode")?.provenance).toBe("observed");
    expect(findGlossaryEntry("Force ColdReset")?.warning).toContain("L6");
    expect(findGlossaryEntry("Wi-Fi SAR")?.warning).toContain("Regulatory");
    expect(findGlossaryEntry("definitely unknown")).toBeNull();
  });

  it("does not regress the old untranslated application chrome", () => {
    const sourceRoot = resolve(process.cwd(), "src");
    const files = [
      "App.tsx", "components/ConnectionBar.tsx", "components/ControlsView.tsx",
      "components/EnjoyView.tsx", "components/ResourceMonitor.tsx",
      "components/TopBar.tsx", "components/UpdateControl.tsx", "components/WeatherPanel.tsx",
    ];
    const combined = files.map((file) => readFileSync(resolve(sourceRoot, file), "utf8")).join("\n");
    for (const oldText of [
      ">Disconnect<", ">Connect<", ">Refresh<", ">No traffic<", ">Loading monitor<",
      ">Meaning<", ">Links<", ">What-if<", ">Check again<", ">Install fresh build<",
    ]) {
      expect(combined).not.toContain(oldText);
    }
  });
});
