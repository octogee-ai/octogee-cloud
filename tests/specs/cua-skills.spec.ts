import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const installer = path.resolve(__dirname, "../../gateway/install-cua-skills.mjs");
const vendored = path.resolve(__dirname, "../../gateway/cua-skills");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(driverVersion = "0.38.0") {
  const root = mkdtempSync(path.join(tmpdir(), "cua-skills-"));
  roots.push(root);
  const openclaw = path.join(root, "openclaw");
  const native = path.join(openclaw, `node_modules/@trycua/cua-driver-linux-${process.arch}-gnu`);
  const sdk = path.join(openclaw, "node_modules/@trycua/cua-driver");
  mkdirSync(native, { recursive: true });
  mkdirSync(sdk, { recursive: true });
  writeFileSync(path.join(native, "package.json"), JSON.stringify({ version: driverVersion }));
  writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ version: driverVersion }));
  const plugin = path.join(openclaw, "dist/extensions/cua-computer");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ dependencies: { "@trycua/cua-driver": driverVersion } }));
  const source = path.join(root, "source");
  cpSync(vendored, source, { recursive: true });
  return { openclaw, native, sdk, plugin, source, destination: path.join(root, "skills") };
}

function install(f: ReturnType<typeof fixture>) {
  try {
    execFileSync(process.execPath, [installer, f.openclaw, f.source, f.destination], { stdio: "pipe" });
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr ?? error));
  }
}

describe("vendored CUA computer skills", () => {
  it("installs each pinned skill with its provenance for the matching driver", () => {
    const f = fixture();
    install(f);
    for (const skill of ["cua-driver", "cua-omarchy"]) {
      expect(readFileSync(path.join(f.destination, skill, "SKILL.md"), "utf8"))
        .toBe(readFileSync(path.join(vendored, skill, "SKILL.md"), "utf8"));
    }
    const provenance = JSON.parse(readFileSync(path.join(f.destination, "provenance.json"), "utf8"));
    expect(provenance.driverVersion).toBe("0.38.0");
    expect(provenance.driverSourceCommit).toBe("85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19");
    expect(provenance.skills["cua-driver"]).toMatchObject({
      repository: "https://github.com/trycua/cua",
      commit: "85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19",
      version: "0.38.0",
    });
    expect(provenance.skills["cua-omarchy"]).toMatchObject({
      repository: "https://github.com/omacom/omarchy",
      commit: "94e97055daca90bfe4248f7a419648ed71f97c49",
    });
  });

  it("refuses skills written for a different driver than the image installs", () => {
    const f = fixture("0.28.2");
    expect(() => install(f)).toThrow("CUA skills target driver 0.38.0, but the installed driver is 0.28.2");
    expect(existsSync(f.destination)).toBe(false);
  });

  it("refuses a skill whose own version drifts from the driver", () => {
    const f = fixture();
    const skill = path.join(f.source, "cua-driver/SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replace("version: 0.38.0", "version: 0.28.2"));
    expect(() => install(f)).toThrow("cua-driver version 0.28.2 does not match driver 0.38.0");
    expect(existsSync(f.destination)).toBe(false);
  });

  it("refuses mismatched installed JavaScript bindings before copying skills", () => {
    const f = fixture();
    writeFileSync(path.join(f.sdk, "package.json"), JSON.stringify({ version: "0.28.2" }));
    expect(() => install(f)).toThrow("CUA skills target driver 0.38.0");
    expect(existsSync(f.destination)).toBe(false);
  });

  it("refuses provenance that does not name the official release source before copying skills", () => {
    const f = fixture();
    const file = path.join(f.source, "provenance.json");
    const provenance = JSON.parse(readFileSync(file, "utf8"));
    provenance.driverSourceCommit = "0".repeat(40);
    writeFileSync(file, JSON.stringify(provenance));
    expect(() => install(f)).toThrow("must pin the official driver release source");
    expect(existsSync(f.destination)).toBe(false);
  });

  it("refuses a plugin that targets different bindings before copying skills", () => {
    const f = fixture();
    writeFileSync(path.join(f.plugin, "package.json"), JSON.stringify({ dependencies: { "@trycua/cua-driver": "0.37.0" } }));
    expect(() => install(f)).toThrow("CUA skills target driver 0.38.0");
    expect(existsSync(f.destination)).toBe(false);
  });

  it.each([
    ["an unlisted file", (source: string) => writeFileSync(path.join(source, "cua-driver/MACOS.md"), "# macOS"), "cua-driver vendors"],
    ["an unlisted skill", (source: string) => {
      mkdirSync(path.join(source, "extra"));
      writeFileSync(path.join(source, "extra/SKILL.md"), "---\nname: extra\n---\n");
    }, "do not match provenance"],
  ])("refuses %s without provenance", (_label, mutate, message) => {
    const f = fixture();
    mutate(f.source);
    expect(() => install(f)).toThrow(message);
    expect(existsSync(f.destination)).toBe(false);
  });

  it("refuses a source that is not pinned to an exact commit", () => {
    const f = fixture();
    const file = path.join(f.source, "provenance.json");
    const provenance = JSON.parse(readFileSync(file, "utf8"));
    provenance.skills["cua-omarchy"].commit = "add-cua-ai-menu";
    writeFileSync(file, JSON.stringify(provenance));
    expect(() => install(f)).toThrow("cua-omarchy is not pinned to an exact commit");
  });
});
