import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { english, ukrainian, type TranslationKey } from "../i18n/catalog";
import { parseChoinkaStatus } from "../lib/choinkaStatus";
import { ChoinkaStatusPanel } from "./ChoinkaStatusPanel";

let locale: "en" | "uk" = "en";
vi.mock("../core/appServices", () => ({ useAppServices: () => ({ meshStatus: { connected: true } }) }));
vi.mock("../i18n/locale", () => ({ useLocale: () => ({ text: (key: TranslationKey) => (locale === "en" ? english : ukrainian)[key] }) }));

describe("electrode diagnostic panel", () => {
  it("renders measured faults without a pump control in both languages", () => {
    const status = parseChoinkaStatus("C6 exec=1 l=0 p=0 b=1 v=100/2200 c=1 d=0 s=3 t=0 a=-1 x=6 z=2100/80 m=0");
    for (const language of ["en", "uk"] as const) {
      locale = language;
      const html = renderToStaticMarkup(<ChoinkaStatusPanel status={status} onSend={async () => true} />);
      const dictionary = language === "en" ? english : ukrainian;
      expect(html).toContain(dictionary["controls.choinkaTestNotLow"]);
      expect(html).toContain(dictionary["controls.choinkaTestAsymmetry"]);
      expect(html).toContain("2100 mV");
      expect(html).toContain(dictionary["controls.choinkaTestDiagnostic"]);
      expect(html).not.toContain(`<dd>${dictionary["controls.choinkaTestConsistent"]}</dd>`);
      expect(html.match(/<button/g)).toHaveLength(1);
    }
  });
  it("does not claim a successful test before diagnostics arrive", () => {
    locale = "en";
    const html = renderToStaticMarkup(<ChoinkaStatusPanel status={null} onSend={async () => true} />);
    expect(html).toContain(english["controls.choinkaNoData"]);
    expect(html).not.toContain(`<dd>${english["controls.choinkaTestConsistent"]}</dd>`);
    expect(html).toContain(english["controls.choinkaTestLimit"]);
  });
});
