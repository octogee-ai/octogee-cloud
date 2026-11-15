import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const dashboardsRoot = resolve(root, "charts/monitoring/dashboards");

interface Target {
  expr?: string;
}

interface Panel {
  title: string;
  targets?: Target[];
  fieldConfig?: { defaults?: { links?: Array<{ title: string; url: string }> } };
  options?: { graphMode?: string };
}

interface Dashboard {
  title: string;
  panels: Panel[];
}

function dashboard(path: string): Dashboard {
  return JSON.parse(readFileSync(resolve(dashboardsRoot, path), "utf8")) as Dashboard;
}

describe("Grafana solo-operator SPOG", () => {
  it("answers the operator's action, core-path, and traffic questions on the home dashboard", () => {
    const overview = dashboard("platform/octogee-overview.json");
    const titles = overview.panels.map((panel) => panel.title);

    expect(titles).toEqual(expect.arrayContaining([
      "Act now",
      "Firing alerts",
      "Unavailable deployments",
      "Scrape targets down",
      "Active restarts (24h)",
      "Can users use the platform?",
      "Core services down",
      "Ready gateways",
      "Fleet controller reconcile age",
      "Activity projection connected",
      "Traffic and outcomes",
      "API req/s",
      "API 5xx %",
      "Agent turns/min",
    ]));
  });

  it("makes every headline signal a one-click drilldown that preserves environment and time", () => {
    const overview = dashboard("platform/octogee-overview.json");
    const headlineTitles = [
      "Firing alerts",
      "Unavailable deployments",
      "Scrape targets down",
      "Active restarts (24h)",
      "Core services down",
      "Ready gateways",
      "Fleet controller reconcile age",
      "Activity projection connected",
      "API req/s",
      "API 5xx %",
      "Agent turns/min",
    ];

    for (const title of headlineTitles) {
      const panel = overview.panels.find((candidate) => candidate.title === title);
      expect(panel, `${title} is missing`).toBeDefined();
      expect(panel?.fieldConfig?.defaults?.links, `${title} has no drilldown`).toHaveLength(1);
      expect(panel?.fieldConfig?.defaults?.links?.[0].url).toContain(
        "var-namespace=${namespace}",
      );
      expect(panel?.fieldConfig?.defaults?.links?.[0].url).toContain("from=${__from}");
      expect(panel?.fieldConfig?.defaults?.links?.[0].url).toContain("to=${__to}");
    }
  });

  it("pins every generated kube-state query to Octogee's non-duplicated KSM feed", () => {
    const generated = ["platform", "gateways"].flatMap((directory) =>
      readdirSync(resolve(dashboardsRoot, directory))
        .filter((name) => name.endsWith(".json"))
        .map((name) => resolve(dashboardsRoot, directory, name)),
    );

    for (const path of generated) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Dashboard;
      for (const panel of parsed.panels) {
        for (const target of panel.targets ?? []) {
          if (!target.expr) continue;
          for (const match of target.expr.matchAll(/\b(kube_[a-z0-9_]+)(\{([^}]*)\})?/g)) {
            expect(match[2], `${path}: ${panel.title}: ${match[1]} has no selector`).toBeDefined();
            expect(match[3], `${path}: ${panel.title}: ${match[1]} uses the wrong KSM feed`).toContain(
              'job="gmp-kube-state-metrics"',
            );
          }
        }
      }
    }
  });

  it("uses explicit zeroes for quiet headline counters instead of broken-looking blanks", () => {
    const overview = dashboard("platform/octogee-overview.json");
    for (const title of [
      "Firing alerts",
      "Unavailable deployments",
      "Scrape targets down",
      "Active restarts (24h)",
      "Core services down",
      "Ready gateways",
      "Activity projection connected",
      "API req/s",
      "API 5xx %",
      "Agent turns/min",
    ]) {
      const expr = overview.panels.find((panel) => panel.title === title)?.targets?.[0]?.expr;
      expect(expr, `${title} expression missing`).toContain("or vector(0)");
    }
  });

  it("renders planned and actual deployment state as one compact row per deployment", () => {
    for (const [path, title] of [
      ["gateways/octogee-fleet.json", "Gateway deployments — planned vs ready"],
      ["platform/octogee-container-health.json", "Deployments — planned vs ready"],
    ]) {
      const parsed = dashboard(path);
      const panel = parsed.panels.find((candidate) => candidate.title === title);
      expect(panel, `${title} is missing`).toBeDefined();
      expect(panel?.targets).toHaveLength(3);
      for (const target of panel?.targets ?? []) {
        expect(target.expr).toMatch(/^sum by \(namespace,deployment\) \(/);
      }
    }
  });

  it("limits current runtime inventories to operator-relevant identity columns", () => {
    const fleet = dashboard("gateways/octogee-fleet.json");
    const activePods = fleet.panels.find((panel) => panel.title === "Active gateway pods and nodes");
    const activeContainers = fleet.panels.find((panel) => panel.title === "Active gateway containers");
    const workload = dashboard("platform/octogee-container-health.json");
    const serviceContainers = workload.panels.find(
      (panel) => panel.title === "Active service containers",
    );

    expect(activePods?.targets?.[0].expr).toMatch(
      /^sum by \(namespace,pod,node,label_gateway_id,label_gateway_class\) \(/,
    );
    expect(activeContainers?.targets?.[0].expr).toMatch(
      /^sum by \(namespace,pod,node,container\) \(/,
    );
    expect(serviceContainers?.targets?.[0].expr).toMatch(
      /^sum by \(namespace,pod,node,container\) \(/,
    );
  });

  it("keeps headline status cards free of decorative sparklines", () => {
    const overview = dashboard("platform/octogee-overview.json");
    for (const panel of overview.panels.filter((candidate) => candidate.targets?.length)) {
      if (!panel.fieldConfig?.defaults?.links) continue;
      expect(panel.options?.graphMode, panel.title).toBe("none");
    }
  });

  it("counts restart history only for pods that are Ready now", () => {
    const overview = dashboard("platform/octogee-overview.json");
    const restartExpr = overview.panels.find(
      (panel) => panel.title === "Active restarts (24h)",
    )?.targets?.[0].expr;
    expect(restartExpr).toContain("and on(namespace,pod)");
    expect(restartExpr).toContain('kube_pod_status_ready{');

    const workload = dashboard("platform/octogee-container-health.json");
    for (const title of [
      "Active restarted containers (24h)",
      "Active restart offenders (24h)",
    ]) {
      const expr = workload.panels.find((panel) => panel.title === title)?.targets?.[0].expr;
      expect(expr, `${title} expression missing`).toContain("and on(namespace,pod)");
    }
  });
});
