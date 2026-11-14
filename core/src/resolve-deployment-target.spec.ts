import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  formatDeploymentTargetOutput,
  isDeploymentTargetResolverEntrypoint,
  resolveDeploymentTargetArguments,
  runDeploymentTargetResolver,
} from "./resolve-deployment-target.js";

describe("deployment target resolver", () => {
  it("resolves a logical environment to its active central target", () => {
    expect(resolveDeploymentTargetArguments(["--environment=test"])).toMatchObject({
      name: "test",
      targetId: "test-central",
      lifecycle: "active",
      region: "us-central1",
    });
  });

  it("rejects retired WEST targets", () => {
    for (const targetId of ["test-west", "prod-west"]) {
      expect(() => resolveDeploymentTargetArguments([`--target=${targetId}`])).toThrow(
        `Unknown deployment target: ${targetId}`,
      );
      expect(() => runDeploymentTargetResolver([
        `--target=${targetId}`,
        "--reject-candidate-target",
      ])).toThrow(`Unknown deployment target: ${targetId}`);
    }
  });

  it("requires exactly one target selector", () => {
    expect(() => resolveDeploymentTargetArguments([])).toThrow(
      "Exactly one of --environment or --target is required",
    );
    expect(() => resolveDeploymentTargetArguments([
      "--environment=prod",
      "--target=prod-central",
    ])).toThrow("Exactly one of --environment or --target is required");
  });

  it("rejects unknown arguments and environments", () => {
    expect(() => resolveDeploymentTargetArguments(["--environment=dev"])).toThrow(
      "Unknown deployment environment: dev",
    );
    expect(() => resolveDeploymentTargetArguments(["--environment=build-week"])).toThrow(
      "Unknown deployment environment: build-week",
    );
    expect(() => resolveDeploymentTargetArguments(["--environment=prod", "--west"])).toThrow(
      "Unknown argument: --west",
    );
  });

  it("emits every Central value needed by workflows and shell tooling", () => {
    const output = formatDeploymentTargetOutput(
      resolveDeploymentTargetArguments(["--target=prod-central"]),
      "github",
    );

    expect(output).toContain("target_id=prod-central\n");
    expect(output).toContain("region=us-central1\n");
    expect(output).toContain("kube_context=gke_octogee_us-central1_octogee-gateway\n");
    expect(output).toContain(
      "artifact_registry_repository=us-central1-docker.pkg.dev/octogee/octogee\n",
    );
    expect(output).toContain("cloud_sql_connection_name=octogee:us-central1:octogee-pg\n");
    expect(output).toContain(
      "cloud_sql_mattermost_password_secret_name=MM_DB_PASSWORD\n",
    );
    expect(output).toContain(
      "cloud_sql_gitea_password_secret_name=gitea-db-password\n",
    );
    expect(output).toContain(
      "cloud_sql_connection_name_secret_name=cloud-sql-connection-name\n",
    );
    expect(output).toContain("secret_name_suffix=prod\n");
    expect(output).toContain("hosting_project_id=octogee\n");
    expect(output).toContain("customer_hosting_project_id=example-prod-hosting\n");
    expect(output).toContain("cloud_sql_point_in_time_recovery_enabled=false\n");
    expect(output).toContain("cloud_sql_platform_state_instance_name=octogee-platform-prod\n");
    expect(output).toContain("cloud_sql_agent_store_database_name=octogee_agents_prod\n");
    expect(output).not.toContain("compute_class");
    expect(output).toContain("network_policy_enforce_default_deny=false\n");
    expect(output).toContain("network_policy_control_plane_cidr=\n");
    expect(output).toContain("network_policy_private_services_cidr=\n");
    expect(output).toContain(
      "kms_key_name=projects/octogee/locations/us-central1/keyRings/octogee-creds/cryptoKeys/integrations-at-rest\n",
    );
  });

  it("supports JSON output for operator scripts", () => {
    const output = formatDeploymentTargetOutput(
      resolveDeploymentTargetArguments(["--environment=test"]),
      "json",
    );

    expect(JSON.parse(output)).toMatchObject({
      target_id: "test-central",
      lifecycle: "active",
      region: "us-central1",
    });
  });

  it("parses CLI output format without weakening selector validation", () => {
    expect(JSON.parse(runDeploymentTargetResolver([
      "--target=test-central",
      "--format=json",
    ]))).toMatchObject({ target_id: "test-central", region: "us-central1" });
    expect(() => runDeploymentTargetResolver([
      "--environment=test",
      "--format=dotenv",
    ])).toThrow("Unknown output format: dotenv");
  });

  it("recognizes a symlinked macOS-style entrypoint path by canonical real path", () => {
    const temp = mkdtempSync(path.join(tmpdir(), "octogee-resolver-entrypoint-"));
    const privateTemp = path.join(temp, "private", "tmp");
    const publicTemp = path.join(temp, "tmp");
    const resolver = path.join(privateTemp, "resolve-deployment-target.js");
    mkdirSync(privateTemp, { recursive: true });
    writeFileSync(resolver, "");
    symlinkSync(privateTemp, publicTemp);

    expect(realpathSync(path.join(publicTemp, "resolve-deployment-target.js")))
      .toBe(realpathSync(resolver));
    expect(isDeploymentTargetResolverEntrypoint(
      pathToFileURL(resolver).href,
      path.join(publicTemp, "resolve-deployment-target.js"),
    )).toBe(true);
  });

  it("does not throw when an entrypoint path no longer exists", () => {
    expect(isDeploymentTargetResolverEntrypoint(
      pathToFileURL("/private/tmp/missing-resolver.js").href,
      "/tmp/missing-resolver.js",
    )).toBe(false);
  });
});
