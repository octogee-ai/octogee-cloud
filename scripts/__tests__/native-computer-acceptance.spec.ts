import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

type Failure = "none" | "input" | "tree-without-window" | "degraded-window";

function accept(failure: Failure) {
  const root = mkdtempSync(join(tmpdir(), "computer-acceptance-"));
  roots.push(root);
  const log = join(root, "calls");
  writeFileSync(join(root, "openclaw"), `#!/bin/bash
printf '%s\\n' "$*" >> "$CALL_LOG"
[[ "$*" != *"--url"* && "$*" != *"--password"* ]] || exit 64
[[ "$OPENCLAW_GATEWAY_PASSWORD" == fixture ]] || exit 65
chromium='{"windowRef":"w1","appName":"chromium","title":"Example Domain - Chromium"}'
case "$*" in
  *"nodes status"*) echo '{"nodes":[{"nodeId":"fixture","displayName":"octogee-desktop","paired":true,"commands":["computer.act","screen.snapshot"]}]}' ;;
  *"screen.snapshot"*) echo '{"payload":{"displayFrameId":"fixture-frame","width":1440,"height":900}}' ;;
  *"__close_execution"*) echo '{}' ;;
  *'"action":"get_accessibility_tree"'*)
    if [[ "$FAILURE" == tree-without-window ]]; then windows='[]'; else windows="[$chromium]"; fi
    printf '{"payloadJSON":%s}\\n' "$(printf '{"ok":true,"details":{"windows":%s,"processes":[]}}' "$windows" | jq -Rs .)" ;;
  *'"action":"list_windows"'*) echo "{\\"payload\\":{\\"ok\\":true,\\"details\\":{\\"windows\\":[$chromium]}}}" ;;
  *'"action":"get_window_state"'*)
    if [[ "$FAILURE" == degraded-window ]]; then
      echo '{"payload":{"ok":true,"details":{"degraded":true,"degradedReason":"atspi_walk_failed"},"observation":{"kind":"window","observationId":"o1"}}}'
    else
      echo '{"payload":{"ok":true,"details":{"coordinateSpace":"image-pixels"},"observation":{"kind":"window","observationId":"o1","elements":[{"elementRef":"e1","role":"link","label":"Learn more","bounds":{"x":1,"y":2,"width":3,"height":4}}]}}}'
    fi ;;
  *"computer.act"*) [[ "$FAILURE" != input ]] || exit 42; echo '{}' ;;
  *) exit 66 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(root, "curl"), '#!/bin/bash\necho \'[{"class":"chromium","title":"Example Domain"}]\'\n', { mode: 0o755 });
  const result = spawnSync("bash", [resolve(__dirname, "../../desktop/acceptance/native-computer.sh")], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CALL_LOG: log, OPENCLAW_GATEWAY_TOKEN: "fixture", FAILURE: failure },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n");
  return { ...result, calls };
}

it.each(["none", "input", "tree-without-window", "degraded-window"] as const)(
  "releases the native execution after acceptance (failure: %s)", (failure) => {
    const result = accept(failure);
    expect(result.status, result.stderr).toBe({ none: 0, input: 42, "tree-without-window": 1, "degraded-window": 1 }[failure]);
    expect(result.calls.at(-1)).toContain("__close_execution");
    const executionIds = result.calls.flatMap((line) => [...line.matchAll(/"executionId":"([^"]+)"/g)].map((match) => match[1]));
    expect(executionIds.length).toBeGreaterThanOrEqual(3);
    expect(new Set(executionIds).size).toBe(1);
  },
);

it("reads the Chromium window's accessibility elements before driving the pointer", () => {
  const result = accept("none");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("accessibility elements=1");
  const index = (needle: string) => result.calls.findIndex((line) => line.includes(needle));
  expect(index('"action":"get_accessibility_tree"')).toBeGreaterThan(index('"action":"key"'));
  expect(result.calls[index('"action":"get_window_state"')]).toContain('"windowRef":"w1"');
  expect(result.calls[index('"action":"get_window_state"')]).toContain('"includeScreenshot":false');
  expect(index('"action":"get_window_state"')).toBeLessThan(index('"action":"mouse_move"'));
  expect(result.calls.some((line) => line.includes('"action":"left_click"'))).toBe(true);
});

it.each([
  ["tree-without-window", "get_accessibility_tree does not list the Chromium window"],
  ["degraded-window", "the Chromium window has no accessibility elements"],
] as const)("fails acceptance when the accessibility bus is not serving Chromium (%s)", (failure, message) => {
  const result = accept(failure);
  expect(result.stdout).toContain(`native computer acceptance failed: ${message}`);
  expect(result.calls.some((line) => line.includes('"action":"mouse_move"'))).toBe(false);
});
