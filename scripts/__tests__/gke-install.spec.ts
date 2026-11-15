import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStubHost, REPO_ROOT, type StubHost } from "./deploy/stub-host";

const SCRIPT = join(REPO_ROOT, "scripts/ops/gke-install.sh");
const PROJECT = "proof-project";
const SHA = "b".repeat(40);
const AMD64 = `sha256:${"1".repeat(64)}`;
const ARM64 = `sha256:${"2".repeat(64)}`;
const INDEX = JSON.stringify({
  manifests: [
    { digest: ARM64, platform: { os: "linux", architecture: "arm64" } },
    { digest: AMD64, platform: { os: "linux", architecture: "amd64" } },
  ],
});
const BLOB_ACCOUNT = `serviceAccount:octogee-blob-store@${PROJECT}.iam.gserviceaccount.com`;

const GCLOUD = `case " $* " in
  *" container clusters describe "*--format*) echo "\${DNS_ACCESS:-}" ;;
  *" container clusters describe "*) [ -n "\${CLUSTER_EXISTS:-}" ] || exit 1 ;;
  *" sql instances describe "*--format*) echo 10.20.0.3 ;;
  *" vpc-peerings list "*) ;;
  *" add-iam-policy-binding "*)
    seen=$(cat "$HOME/binding-failures" 2>/dev/null || echo 0)
    if [ "$seen" -lt "\${BINDING_FAILURES:-0}" ]; then echo $((seen + 1)) > "$HOME/binding-failures"; exit 1; fi ;;
  *" storage hmac create "*) printf 'GOOG1STUBACCESS\\tstub/secret+key\\n' ;;
  *" describe "*) exit 1 ;;
esac`;

const KUBECTL = `case " $* " in
  *" get endpointslice "*) echo 172.16.0.2 ;;
  *"%{http_code}"*) echo 200 ;;
  *"jsonpath={.data."*) printf 'c3R1Yg==' ;;
  *" team search "*) echo '"name": "octogee"' ;;
  *" get secret "*) exit 1 ;;
  *" -f - "* | *" run psql-"*) cat >/dev/null ;;
  *"-o yaml"*) echo "kind: stub" ;;
esac`;

const SSH_KEYGEN = `while [ $# -gt 0 ]; do [ "$1" = -f ] && file="$2"; shift; done
echo key > "$file"; echo key > "$file.pub"`;

describe("gke-install.sh up", () => {
  let host: StubHost;
  let state: string;

  beforeEach(() => {
    host = createStubHost();
    state = mkdtempSync(join(tmpdir(), "gke-install-state-"));
    symlinkSync(process.execPath, join(host.bin, "node"));
    for (const tool of ["chmod", "paste", "sort"]) {
      symlinkSync([`/bin/${tool}`, `/usr/bin/${tool}`].find(path => existsSync(path))!, join(host.bin, tool));
    }
    host.stub("sleep", "");
    host.stub("gcloud", GCLOUD);
    host.stub("gke-gcloud-auth-plugin", "");
    host.stub("kubectl", KUBECTL);
    host.stub("helm", "");
    host.stub("docker", `printf '%s' "$INDEX"`);
    host.stub("git", `echo ${SHA}`);
    host.stub("openssl", "echo 0123456789abcdef");
    host.stub("ssh-keygen", SSH_KEYGEN);
  });

  afterEach(() => {
    host.remove();
    rmSync(state, { recursive: true, force: true });
  });

  const up = (env: Record<string, string> = {}) => host.run(SCRIPT, ["up", `--sha=${SHA}`], {
    env: { GCP_PROJECT: PROJECT, OCTOGEE_GKE_STATE: state, INDEX, OPENROUTER_API_KEY: "sk-or-gke-test", DNS_ACCESS: "True", ...env },
  });
  const gcloud = (fragment: string) => host.calls().filter(call => call.startsWith("gcloud ") && call.includes(fragment));
  const secret = (name: string) => readFileSync(join(state, PROJECT, "secrets", name), "utf8");

  it("creates the cluster with a DNS endpoint and reaches its control plane through it", () => {
    const result = up();
    expect(result.stderr).not.toContain("gke-install:");
    expect(result.status).toBe(0);
    expect(gcloud("clusters create")[0]).toContain("--enable-dns-access");
    expect(gcloud("clusters update")).toEqual([]);
    expect(gcloud("clusters get-credentials")[0]).toContain("--dns-endpoint");
  });

  it("turns on DNS access for an existing cluster that was created without it", () => {
    expect(up({ CLUSTER_EXISTS: "1", DNS_ACCESS: "" }).status).toBe(0);
    expect(gcloud("clusters create")).toEqual([]);
    expect(gcloud("clusters update")[0]).toContain("--enable-dns-access");
  });

  it("lets the blob store account use the objects of both buckets and read each bucket's settings", () => {
    expect(up().status).toBe(0);
    const grants = gcloud("add-iam-policy-binding").map(call => {
      const [, bucket] = /gs:\/\/(\S+)/.exec(call)!;
      expect(call).toContain(`--member=${BLOB_ACCOUNT}`);
      return `${bucket} ${/--role=(\S+)/.exec(call)![1]}`;
    });
    expect(grants.sort()).toEqual([
      `${PROJECT}-octogee-assets roles/storage.legacyBucketReader`,
      `${PROJECT}-octogee-assets roles/storage.objectAdmin`,
      `${PROJECT}-octogee-workspaces roles/storage.legacyBucketReader`,
      `${PROJECT}-octogee-workspaces roles/storage.objectAdmin`,
    ]);
    expect(gcloud("storage hmac create")[0]).toContain(`octogee-blob-store@${PROJECT}.iam.gserviceaccount.com`);
  });

  it("retries a grant while a new service account is not yet visible to Cloud Storage", () => {
    const result = up({ BINDING_FAILURES: "2" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("is not visible to Cloud Storage yet; retrying");
    expect(gcloud("add-iam-policy-binding")).toHaveLength(6);
  });

  it("stores the HMAC key exactly, with no trailing newline in either half", () => {
    expect(up().status).toBe(0);
    expect(secret("s3-access-key")).toBe("GOOG1STUBACCESS");
    expect(secret("s3-secret-key")).toBe("stub/secret+key");
  });

  it("stores only the provider keys exported in its environment", () => {
    const result = up();
    expect(result.stdout).toContain("Stored OPENROUTER_API_KEY in Secret octogee-openrouter");
    const providerSecrets = host.calls().filter(call => /create secret generic octogee-(openrouter|openai|anthropic) /.test(call));
    expect(providerSecrets.map(call => /octogee-(\w+) /.exec(call)![1])).toEqual(["openrouter"]);
  });

  it("installs the linux/amd64 digest of each image published for the commit", () => {
    expect(up().status).toBe(0);
    const values = JSON.parse(readFileSync(join(state, PROJECT, "environment.yaml"), "utf8"));
    expect(values["octogee-api"].image).toEqual({ repository: "ghcr.io/octogee-ai/octogee-cloud/octogee-api", tag: "bbbbbbb", digest: AMD64 });
    expect(values["glm-controller"].platformRelease.builderImageTag).toBe(`bbbbbbb@${AMD64}`);
    expect(values.networkPolicy.agentStorePostgresCidr).toBe("10.20.0.3/32");
    expect(values.projectRunner.apiServerEgressCidrs).toEqual(["172.16.0.2/32"]);
  });

  describe("down", () => {
    const DOWN_GCLOUD = `case " $* " in
  *" vpc-peerings list "*) [ -n "\${PRESENT:-}" ] && echo "\${PEERING_NAME:-servicenetworking-googleapis-com}" ;;
  *" hmac list "*) echo GOOG1STUBACCESS ;;
  *" compute networks describe "*--format*) [ -n "\${PRESENT:-}" ] || exit 1; echo "\${NETWORK_PEERINGS-servicenetworking-googleapis-com}" ;;
  *" describe "*) [ -n "\${PRESENT:-}" ] || exit 1 ;;
  *" vpc-peerings delete "*)
    if [ -n "\${PEERING_ERROR:-}" ]; then echo "stub: \${PEERING_ERROR}" >&2; exit 1; fi
    seen=$(cat "$HOME/peering-refusals" 2>/dev/null || echo 0)
    if [ "$seen" -lt "\${PEERING_REFUSALS:-0}" ]; then
      echo $((seen + 1)) > "$HOME/peering-refusals"
      echo "stub: Producer services (e.g. CloudSQL) are still using this connection." >&2; exit 1
    fi ;;
  *" delete "*) case " $* " in *" \${FAIL_DELETE:-none} "*) echo "stub: deletion refused" >&2; exit 1 ;; esac ;;
esac`;
    const down = (env: Record<string, string>) => {
      host.stub("gcloud", DOWN_GCLOUD);
      mkdirSync(join(state, PROJECT, "secrets"), { recursive: true });
      writeFileSync(join(state, PROJECT, "secrets", "postgres-password"), "kept");
      return host.run(SCRIPT, ["down"], { env: { GCP_PROJECT: PROJECT, OCTOGEE_GKE_STATE: state, ...env } });
    };
    const deletes = () => host.calls().filter(call => call.startsWith("gcloud ") && / delete /.test(call));

    it("deletes every resource it finds, then its local state", () => {
      const result = down({ PRESENT: "1" });
      expect(result.status).toBe(0);
      expect(deletes().map(call => call.replace(/^gcloud KUBECONFIG=unset --project \S+ --quiet /, "").split(" ").slice(0, 3).join(" "))).toEqual([
        "container clusters delete", "sql instances delete", "storage hmac delete",
        "iam service-accounts delete", "services vpc-peerings delete", "compute addresses delete",
        "compute routers delete", "compute networks delete",
      ]);
      expect(existsSync(join(state, PROJECT))).toBe(false);
    });

    it("skips what is already gone", () => {
      expect(down({}).status).toBe(0);
      expect(deletes()).toEqual([]);
      expect(existsSync(join(state, PROJECT))).toBe(false);
    });

    it("stops at a failed deletion and keeps the local secrets", () => {
      const result = down({ PRESENT: "1", FAIL_DELETE: "instances" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("deletion refused");
      expect(deletes().some(call => call.includes("networks delete"))).toBe(false);
      expect(readFileSync(join(state, PROJECT, "secrets", "postgres-password"), "utf8")).toBe("kept");
    });

    const peeringDeletes = () => deletes().filter(call => call.includes("vpc-peerings delete"));

    const peeringRemovals = () => deletes().filter(call => call.includes(" compute networks peerings delete "));

    it("removes the network's own peering when Cloud SQL keeps the service networking connection, then the network", () => {
      const result = down({ PRESENT: "1", PEERING_REFUSALS: "99", PEERING_NAME: "listed-peering", NETWORK_PEERINGS: "other-peering;listed-peering" });
      expect(result.status).toBe(0);
      expect(peeringDeletes()).toHaveLength(1);
      expect(peeringRemovals()).toEqual([expect.stringContaining("compute networks peerings delete listed-peering --network=octogee")]);
      expect(host.calls().some(call => /^sleep /.test(call))).toBe(false);
      expect(deletes().map(call => call.replace(/^gcloud KUBECONFIG=unset --project \S+ --quiet /, "").split(" ").slice(0, 3).join(" ")).slice(-4)).toEqual([
        "compute networks peerings", "compute addresses delete", "compute routers delete", "compute networks delete",
      ]);
      expect(existsSync(join(state, PROJECT))).toBe(false);
    });

    it("goes on to the address range, router and network on a rerun after the network's own peering is already gone", () => {
      const result = down({ PRESENT: "1", PEERING_REFUSALS: "99", NETWORK_PEERINGS: "" });
      expect(result.status).toBe(0);
      expect(peeringRemovals()).toEqual([]);
      expect(deletes().map(call => call.replace(/^gcloud KUBECONFIG=unset --project \S+ --quiet /, "").split(" ").slice(0, 3).join(" ")).slice(-3)).toEqual([
        "compute addresses delete", "compute routers delete", "compute networks delete",
      ]);
      expect(existsSync(join(state, PROJECT))).toBe(false);
    });

    it("removes each listed peering that the network still has", () => {
      const result = down({ PRESENT: "1", PEERING_REFUSALS: "99", PEERING_NAME: "first-peering\nsecond-peering", NETWORK_PEERINGS: "first-peering;second-peering" });
      expect(result.status).toBe(0);
      expect(peeringRemovals()).toEqual([
        expect.stringContaining("compute networks peerings delete first-peering --network=octogee"),
        expect.stringContaining("compute networks peerings delete second-peering --network=octogee"),
      ]);
    });

    it("stops with gcloud's error when the network's own peering cannot be removed, keeping the network and local secrets", () => {
      const result = down({ PRESENT: "1", PEERING_REFUSALS: "99", FAIL_DELETE: "peerings" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("deletion refused");
      expect(deletes().some(call => call.includes("networks delete octogee"))).toBe(false);
      expect(readFileSync(join(state, PROJECT, "secrets", "postgres-password"), "utf8")).toBe("kept");
    });

    it("fails at once with gcloud's own error when the connection's deletion is refused for another reason", () => {
      const result = down({ PRESENT: "1", PEERING_ERROR: "PERMISSION_DENIED: servicenetworking.services.deleteConnection" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("PERMISSION_DENIED: servicenetworking.services.deleteConnection");
      expect(peeringRemovals()).toEqual([]);
      expect(peeringDeletes()).toHaveLength(1);
      expect(host.calls().some(call => /^sleep /.test(call))).toBe(false);
      expect(deletes().some(call => call.includes("networks delete"))).toBe(false);
      expect(readFileSync(join(state, PROJECT, "secrets", "postgres-password"), "utf8")).toBe("kept");
    });
  });

  it("stops before creating anything when the commit has no published images", () => {
    host.stub("docker", `echo "ERROR: $4: not found" >&2; exit 1`);
    const result = up();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Commit ${SHA} has no published images: its Build main run did not publish`);
    expect(result.stderr).toContain("releases/latest");
    expect(host.calls().filter(call => call.startsWith("gcloud "))).toEqual([]);
  });

  it("stops before creating anything when no model provider key is exported or stored", () => {
    const result = host.run(SCRIPT, ["up", `--sha=${SHA}`], { env: { GCP_PROJECT: PROJECT, OCTOGEE_GKE_STATE: state } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("agents need a model provider key");
    expect(host.calls().filter(call => call.startsWith("gcloud "))).toEqual([]);
  });
});
