import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(import.meta.dirname, "../..");
const STOCK_REPOSITORIES: Record<string, string> = { mattermost: "mattermost/mattermost-team-edition" };

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function deploymentSettings(path: string): string {
  type RuntimeImage = { repository?: string; digest?: string };
  const values = parse(source(path)) as {
    mattermost?: { image?: RuntimeImage };
    global?: { computer?: { bridge?: { image?: RuntimeImage } } };
  };
  const images = [
    { name: "mattermost", image: values.mattermost?.image },
    { name: "vm-bridge", image: values.global?.computer?.bridge?.image },
  ];
  for (const { name, image } of images) {
    if (!image?.repository) continue;
    if ([`ghcr.io/octogee-ai/octogee-cloud/${name}`, STOCK_REPOSITORIES[name]].includes(image.repository)) {
      delete image.repository;
      continue;
    }
    const targets = JSON.parse(source("core/src/fixtures/deployment-targets.json")) as {
      targets: Record<string, { artifactRegistry: { location: string; projectId: string; repository: string } }>;
    };
    const registry = targets.targets["test-central"].artifactRegistry;
    expect(image.repository).toBe(`${registry.location}-docker.pkg.dev/${registry.projectId}/${registry.repository}/${name}`);
    expect(image.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    delete image.repository;
  }
  return JSON.stringify(values);
}

describe("deployment target consumers", () => {

  it("keeps the reusable target action free of a regional fallback", () => {
    const contents = source("../.github/actions/resolve-deployment-target/action.yml");
    expect(contents).toContain("core/dist/resolve-deployment-target.js");
    expect(contents).toContain("does not belong to requested environment");
    expect(contents).not.toContain("us-central1");
    expect(contents).not.toContain("us-west1");
  });

  it("loads setup and verification topology from the shell target contract", () => {
    for (const script of [
      "scripts/setup-secrets.sh",
      "scripts/setup-mattermost.sh",
      "scripts/setup-gitea.sh",
      "scripts/verify-env.sh",
      "scripts/verify-secrets.sh",
      "scripts/provision-namespace.sh",
      "scripts/rotate-secret.sh",
      "scripts/teardown-env.sh",
      "scripts/setup-cloud-sql.sh",
      "scripts/shell-gateway.sh",
      "scripts/shell-gateway-ui.sh",
      "scripts/setup-monitoring.sh",
      "scripts/setup-monitoring-iap.sh",
      "scripts/ops/reconcile-gitea-org.sh",
    ]) {
      const contents = source(script);
      expect(contents, script).toContain("lib/deployment-target.sh");
      expect(contents, script).not.toContain("us-central1");
      expect(contents, script).not.toContain("gke_octogee_");
      expect(contents, script).not.toContain("-docker.pkg.dev/octogee/octogee");
    }
  });

  it("enforces the Cloud SQL recovery policy declared by the selected target", () => {
    const setup = source("scripts/setup-cloud-sql.sh");
    expect(setup).toContain('DESIRED_PITR="$TARGET_CLOUD_SQL_PITR_ENABLED"');
    expect(setup).toContain("WEST Terraform prerequisites are not converged");
    expect(setup).not.toContain("gcloud sql instances patch");
    expect(setup).not.toContain("gcloud sql databases create");
    expect(setup).not.toContain("gcloud secrets create");
    expect(setup).not.toContain("gcloud secrets add-iam-policy-binding");
    expect(setup).not.toContain('2>/dev/null || echo ""');
    expect(setup).not.toContain('DESIRED_PITR="false"');
  });

  it("forces rebuild credential rotation so a rerun repairs a half-written SQL pair", () => {
    const setup = source("scripts/setup-cloud-sql.sh");

    expect(setup).toContain("--rotate) FORCE_ROTATE=true");
    expect(setup).toContain('if ! $FORCE_ROTATE && $user_exists && $secret_exists; then');
    expect(setup).toContain('rollback_candidate_secret_version "$secret" "$candidate_version"');
  });

  it("scopes internal bootstrap credentials to the exact target", () => {
    const setupSecrets = source("scripts/setup-secrets.sh");
    const setupGitea = source("scripts/setup-gitea.sh");

    expect(setupSecrets).toContain('INTERNAL_SECRET_SUFFIX="$TARGET_SECRET_NAME_SUFFIX"');
    expect(setupSecrets).toContain('GITEA_API_TOKEN_SM_KEY="gitea-api-token-${INTERNAL_SECRET_SUFFIX}"');
    expect(setupSecrets).toContain('GITEA_ADMIN_PASSWORD_SM_KEY="gitea-admin-password-${INTERNAL_SECRET_SUFFIX}"');
    expect(setupSecrets).not.toContain('gitea-api-token-${ENV}');
    expect(setupGitea).toContain('GITEA_API_TOKEN_SM_KEY="gitea-api-token-${TARGET_SECRET_NAME_SUFFIX}"');
    expect(setupGitea).toContain('GITEA_ADMIN_PASSWORD_SM_KEY="gitea-admin-password-${TARGET_SECRET_NAME_SUFFIX}"');
    expect(setupGitea).not.toContain('gitea-api-token-${ENV}');
  });

  it("preserves exact targets through the canonical bootstrap handoff", () => {
    for (const script of [
      "scripts/setup-secrets.sh",
      "scripts/setup-mattermost.sh",
      "scripts/setup-gitea.sh",
    ]) {
      expect(source(script), script).toContain('TARGET_ARG=" --deployment-target=$TARGET_ID"');
    }

    const teardown = source("scripts/teardown-env.sh");
    expect(teardown).toContain("--deployment-target=*)");
    expect(teardown).toContain('octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"');
    expect(teardown).toContain('./scripts/setup-cloud-sql.sh --target=$TARGET_ID');
    expect(teardown).toContain('TARGET_ARG=" --deployment-target=$TARGET_ID"');
  });

  it("lets custom namespace provisioning select and retain its exact test target", () => {
    const provision = source("scripts/provision-namespace.sh");

    expect(provision).toContain("--deployment-target=*)");
    expect(provision).toContain('octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"');
    expect(provision).toContain("does not belong to environment 'test'");
    expect(provision.match(/--env=custom --namespace="\$NAMESPACE" --yes --deployment-target="\$TARGET_ID"/g)).toHaveLength(4);

    for (const script of [
      "scripts/setup-secrets.sh",
      "scripts/setup-mattermost.sh",
      "scripts/setup-gitea.sh",
    ]) {
      const contents = source(script);
      expect(contents, script).not.toContain('"--deployment-target cannot be used with --env=custom"');
      expect(contents, script).toContain('[[ "$TARGET_ENVIRONMENT" != "$TARGET_ENV" ]]');
      expect(contents, script).toContain('if [[ "$ENV" != "custom" ]]; then');
    }
  });

  it("selects candidate data and cluster targets in canonical finalizers", () => {
    for (const script of ["scripts/verify-env.sh"]) {
      const contents = source(script);
      expect(contents, script).toContain("--deployment-target=*)");
      expect(contents, script).toContain(
        'octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"',
      );
      expect(contents, script).toContain("does not belong to environment");
    }
  });

  it("keeps regional bootstrap state isolated after target activation", () => {
    for (const script of [
      "scripts/setup-secrets.sh",
      "scripts/setup-mattermost.sh",
      "scripts/setup-gitea.sh",
      "scripts/teardown-env.sh",
    ]) {
      const contents = source(script);
      expect(contents, script).toContain(
        "prod-central|test-central) ;;",
      );
      expect(contents, script).toContain(
        '*) ENV_FILE="$REPO_DIR/.env.$TARGET_ID" ;;',
      );
      expect(contents, script).not.toContain(
        '[[ "$TARGET_LIFECYCLE" == "candidate" ]] && ENV_FILE=',
      );
    }
  });

  it("preserves the candidate target in verification repairs", () => {
    const verify = source("scripts/verify-env.sh");
    expect(verify).toContain("--env=$ENV$TARGET_ARG");
  });

  it("runs fleet-control keypair verification for central and west targets", () => {
    const verify = source("scripts/verify-env.sh");

    expect(verify).toContain('if [[ "$ENV" == "custom" ]]');
    expect(verify).not.toContain('if [[ "$NAMESPACE" != "octogee"');
    expect(verify).not.toContain("Unknown namespace '$NAMESPACE' — skipping fleet-control secret checks");
  });

  it("prints a full-rebuild recipe that resolves one immutable manifest for every platform and gateway image", () => {
    const teardown = source("scripts/teardown-env.sh");

    expect(teardown).toContain(
      "PLATFORM_SOURCE_SHA=<full 40-character source SHA from the tested Central release manifest>",
    );
    expect(teardown).toContain(
      "scripts/ops/render-release-helm-values.ts",
    );
    expect(teardown).toContain(
      "\\\"\\$PLATFORM_SOURCE_SHA\\\" > \\\"\\$RELEASE_VALUES_FILE\\\" || exit 1",
    );
    expect(teardown).toContain(
      "-f \\\"\\$RELEASE_VALUES_FILE\\\"",
    );
    expect(teardown).not.toContain("BOOTSTRAP_GATEWAY_TAG=");
    expect(teardown).not.toContain(
      "The fleet controller auto-installs octogee-gw-default after step 2",
    );
  });

  it("keeps generated custom values and dependency inventory target-driven", () => {
    const customValues = source("helm/octogee/values.custom.yaml.tpl");
    const inventory = source("scripts/lib/dependency-inventory.ts");

    expect(customValues).toContain("__TARGET_ID__");
    expect(customValues).toContain("__AR_REPOSITORY__");
    expect(deploymentSettings("helm/octogee/values.custom.yaml.tpl")).not.toContain("us-central1");
    expect(inventory).toContain("@octogee/core/deployment-environment");
    expect(inventory).not.toContain("us-central1-docker.pkg.dev/octogee/octogee/");
  });

  it("keeps shared Helm defaults free of a legacy regional target", () => {
    for (const valuesFile of [
      "helm/octogee/values.yaml",
      "helm/octogee/charts/cloud-sql-proxy/values.yaml",
      "helm/octogee/charts/gateway-edge/values.yaml",
      "helm/octogee/charts/glm-controller/values.yaml",
      "helm/octogee/charts/octogee-api/values.yaml",
      "helm/octogee-gateway/values.yaml",
    ]) {
      const values = deploymentSettings(valuesFile);
      expect(values, valuesFile).not.toContain("us-central1");
      expect(values, valuesFile).not.toContain("-docker.pkg.dev/octogee/octogee");
    }
  });

  it("requires Terraform callers to provide every regional location", () => {
    for (const moduleFile of [
      "terraform/modules/cloud-sql/variables.tf",
      "terraform/modules/networking/variables.tf",
      "terraform/modules/kms/variables.tf",
      "terraform/modules/secrets/main.tf",
    ]) {
      expect(source(moduleFile), moduleFile).not.toContain("us-central1");
    }
    expect(source("terraform/modules/secrets/main.tf")).toContain("location = var.region");
  });
});
