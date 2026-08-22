import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readProjectFile = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("Tauri command ACL", () => {
  it("registers and permits every native command exposed to the renderer", () => {
    const rustSource = readProjectFile("../../src-tauri/src/lib.rs");
    const buildSource = readProjectFile("../../src-tauri/build.rs");
    const capability = JSON.parse(
      readProjectFile("../../src-tauri/capabilities/default.json"),
    ) as { permissions: string[] };

    const commands = Array.from(
      rustSource.matchAll(
        /#\[tauri::command\]\s*(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g,
      ),
      (match) => match[1],
    );

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(buildSource, `${command} missing from AppManifest`).toContain(
        `"${command}"`,
      );
      expect(
        capability.permissions,
        `${command} missing from main-window ACL`,
      ).toContain(`allow-${command.replaceAll("_", "-")}`);
    }
  });
});
