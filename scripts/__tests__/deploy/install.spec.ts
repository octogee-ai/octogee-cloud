import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT, type StubHost, createStubHost, stubUname } from "./stub-host";

const CLOUD_SETTINGS = {
  DOMAIN: "platform.your-company.com",
  ACME_EMAIL: "ops@octogee.com",
  GCP_PROJECT: "stub-project",
  GCP_REGION: "us-central1",
  AWS_REGION: "us-east-1",
};
const LOCAL_TOOLS = ["docker", "kind", "kubectl", "helm", "openssl", "curl", "git"];
const GCP_TOOLS = ["kubectl", "helm", "openssl", "curl", "git", "gcloud", "gke-gcloud-auth-plugin"];

let host: StubHost;
let checkout: string;

function recipe(path: string, body = ""): void {
  const file = join(checkout, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `echo "ran ${path}" >> "\${CALLS}"\n${body}\n`);
}

function stubTools(names: readonly string[]): void {
  for (const name of names) host.stub(name, "exit 0");
}

function install(args: readonly string[], env: Record<string, string> = {}, input = "") {
  return host.run(join(checkout, "install.sh"), [...args, "--no-prompt"], { env, input });
}

function ranRecipes(): string[] {
  return host.calls().filter((line) => line.startsWith("ran "));
}

beforeEach(() => {
  host = createStubHost();
  checkout = join(host.home, "checkout");
  mkdirSync(checkout);
  copyFileSync(join(REPO_ROOT, "install.sh"), join(checkout, "install.sh"));
  recipe("deploy/lib.sh");
  recipe("deploy/local/up.sh", 'cat > "${HOME}/stdin-seen-by-up"');
  recipe("deploy/local/check.sh");
  recipe("deploy/cloud/gcp.sh", 'echo "domain=${DOMAIN} project=${GCP_PROJECT}" > "${HOME}/gcp-settings"');
  recipe("deploy/cloud/aws.sh");
});

afterEach(() => host.remove());

describe("choosing where it runs", () => {
  it("stops in Git Bash and points to WSL2", () => {
    stubUname(host, "MINGW64_NT-10.0-26100", "3.5.4");
    const run = install(["--target=local"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("wsl --install");
  });

  it("refuses an unknown target", () => {
    stubUname(host, "Linux", "6.17.0-arch1-1");
    const run = install(["--target=azure"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("unknown target 'azure'");
  });

  it("asks for a target by flag when it cannot prompt", () => {
    stubUname(host, "Linux", "6.17.0-arch1-1");
    const run = install([]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--target=local");
  });
});

describe("verifying the machine", () => {
  it("gives pacman commands on Omarchy and Arch", () => {
    stubUname(host, "Linux", "6.17.0-arch1-1");
    host.stub("pacman", "exit 0");
    const run = install(["--target=local", "--check-only"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("sudo pacman -S --needed docker");
    expect(run.stdout).toContain("sudo pacman -S --needed kind");
    expect(run.stdout).toContain("sudo pacman -S --needed helm");
  });

  it("gives Homebrew commands on macOS", () => {
    stubUname(host, "Darwin", "27.2.0");
    const run = install(["--target=local", "--check-only"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("brew install kubernetes-cli");
    expect(run.stdout).toContain("brew install kind");
  });

  it("points at WSL integration when Docker is unreachable under WSL2", () => {
    stubUname(host, "Linux", "6.6.87.2-microsoft-standard-WSL2");
    host.stub("apt-get", "exit 0");
    stubTools(LOCAL_TOOLS);
    host.stub("docker", "exit 1");
    const run = install(["--target=local", "--check-only"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("WSL integration");
  });

  it("reports success and installs nothing with --check-only", () => {
    stubUname(host, "Linux", "6.17.0-arch1-1");
    stubTools(LOCAL_TOOLS);
    const run = install(["--target=local", "--check-only"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("This machine is ready.");
    expect(ranRecipes()).toEqual([]);
  });

  it("names every missing cloud setting", () => {
    stubUname(host, "Linux", "6.17.0-arch1-1");
    stubTools(GCP_TOOLS);
    const run = install(["--target=gcp", "--check-only"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("GCP_PROJECT is not set");
    expect(run.stdout).toContain("DOMAIN is not set");
    expect(run.stdout).toContain("ACME_EMAIL is not set");
  });

  it("rejects a domain written as a URL", () => {
    stubUname(host, "Linux", "6.17.0-arch1-1");
    stubTools(GCP_TOOLS);
    const run = install(["--target=gcp", "--check-only"], { ...CLOUD_SETTINGS, DOMAIN: "https://chat.octogee.com" });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("is not a valid domain");
  });

  it("rejects a malformed certificate email", () => {
    stubUname(host, "Linux", "6.17.0-arch1-1");
    stubTools(GCP_TOOLS);
    const run = install(["--target=gcp", "--check-only"], { ...CLOUD_SETTINGS, ACME_EMAIL: "not-an-address" });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("is not an email address");
  });

  it("reports an expired cloud sign-in", () => {
    stubUname(host, "Linux", "6.17.0-arch1-1");
    stubTools(GCP_TOOLS);
    host.stub("gcloud", "exit 1");
    const run = install(["--target=gcp", "--check-only"], CLOUD_SETTINGS);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("gcloud auth login");
  });
});

describe("installing", () => {
  beforeEach(() => stubUname(host, "Linux", "6.17.0-arch1-1"));

  it("installs nothing without confirmation when it cannot ask", () => {
    stubTools(LOCAL_TOOLS);
    const run = install(["--target=local"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("pass --yes");
    expect(ranRecipes()).toEqual([]);
  });

  it("brings up the local stack, then checks it, with stdin closed to the recipes", () => {
    stubTools(LOCAL_TOOLS);
    const run = install(["--target=local", "--yes"], {}, "rest of a piped script");
    expect(run.status).toBe(0);
    expect(ranRecipes()).toEqual(["ran deploy/local/up.sh", "ran deploy/local/check.sh"]);
    expect(readFileSync(join(host.home, "stdin-seen-by-up"), "utf8")).toBe("");
  });

  it("names the model keys it will copy without printing their values", () => {
    stubTools(LOCAL_TOOLS);
    const run = install(["--target=local", "--yes"], { OPENAI_API_KEY: "secret-value" });
    expect(run.stdout).toContain("copies these model keys from your shell into the cluster: OPENAI_API_KEY");
    expect(run.stdout).not.toContain("secret-value");
  });

  it("says when no model key is available", () => {
    stubTools(LOCAL_TOOLS);
    const run = install(["--target=local", "--yes"]);
    expect(run.stdout).toContain("No model keys are set");
  });

  it("passes the cloud settings to the provider recipe", () => {
    stubTools(GCP_TOOLS);
    const run = install(["--target=gcp", "--yes"], CLOUD_SETTINGS);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("billable resources");
    expect(ranRecipes()).toEqual(["ran deploy/cloud/gcp.sh"]);
    expect(readFileSync(join(host.home, "gcp-settings"), "utf8")).toContain(
      "domain=platform.your-company.com project=stub-project",
    );
  });

  it.each([
    { settings: {}, location: "region us-central1", availability: "REGIONAL" },
    {
      settings: { GCP_ZONE: "us-central1-a", SQL_AVAILABILITY: "ZONAL" },
      location: "zone us-central1-a",
      availability: "ZONAL",
    },
  ])("shows the selected GCP location and database availability: $availability", ({ settings, location, availability }) => {
    stubTools(GCP_TOOLS);
    const run = install(["--target=gcp", "--yes"], { ...CLOUD_SETTINGS, ...settings });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`GKE cluster in ${location}`);
    expect(run.stdout).toContain(`Cloud SQL for PostgreSQL 16 (${availability})`);
  });

  it("clones the repository when piped from curl, then runs from the clone", () => {
    stubTools(LOCAL_TOOLS);
    host.stub(
      "git",
      `target="\${*: -1}"; mkdir -p "\${target}/deploy/local"; printf 'echo "ran cloned up" >> "\${CALLS}"' > "\${target}/deploy/local/up.sh"; printf 'echo "ran cloned check" >> "\${CALLS}"' > "\${target}/deploy/local/check.sh"`,
    );
    const script = readFileSync(join(REPO_ROOT, "install.sh"), "utf8");
    const run = host.run("-", ["--target=local", "--yes", "--no-prompt"], { input: script });
    expect(run.status).toBe(0);
    expect(host.calls().some((line) => line.includes(`clone --quiet --depth 1 --branch main`))).toBe(true);
    expect(ranRecipes()).toEqual(["ran cloned up", "ran cloned check"]);
  });

  it("refuses to overwrite a folder that is not a checkout", () => {
    stubTools(LOCAL_TOOLS);
    mkdirSync(join(host.home, "octogee-cloud"));
    const script = readFileSync(join(REPO_ROOT, "install.sh"), "utf8");
    const run = host.run("-", ["--target=local", "--yes", "--no-prompt"], { input: script });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("is not a git checkout");
    expect(ranRecipes()).toEqual([]);
  });
});
