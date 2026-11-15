import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePlatformModelConfig, resolveHouseModel } from "../../shared/types/platform-config.js";
import { createStubHost, REPO_ROOT, type StubHost } from "./deploy/stub-host";

const SCRIPT = join(REPO_ROOT, "scripts/ops/kind-install.sh");
const REGISTRY = "ghcr.io/octogee-ai/octogee-cloud";
const IMAGES = ["glm-controller", "octogee-api", "llm-broker", "gateway-edge", "octogee-gateway"];
const AMD64_IMAGES = [...IMAGES, "octogee-gateway-builder"];
const PUBLISHED = "b".repeat(40);
const CHECKOUT = "c".repeat(40);
const AMD64 = `sha256:${"1".repeat(64)}`;
const ARM64 = `sha256:${"2".repeat(64)}`;
const INDEX = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: AMD64, size: 1, platform: { os: "linux", architecture: "amd64" } },
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: ARM64, size: 1, platform: { os: "linux", architecture: "arm64" } },
  ],
});

const DOCKER = `case " $* " in
  *" imagetools inspect "*) printf '%s' "$INDEX" ;;
  *" imagetools create "*) exit 0 ;;
  *" bake "*) exit 1 ;;
  *"{{.State.Running}}"*) echo true ;;
  *"Networks.kind"*) echo '{}' ;;
  *" exec -i "*) cat >/dev/null ;;
esac`;

const KUBECTL = `case " $* " in
  *"%{http_code}"*) echo 200 ;;
  *"jsonpath={.data."*) printf 'c3R1Yg==' ;;
  *" team search "*) echo '"name": "octogee"' ;;
  *" -f - "* | *" exec -i "*) cat >/dev/null ;;
  *"-o yaml"*) echo "kind: stub" ;;
esac`;

const KIND = `case "$1 $2" in
  "get clusters") printf '%s\\n' "\${CLUSTERS:-}" ;;
  "get nodes") echo octogee-control-plane ;;
  "create cluster") cat >/dev/null ;;
esac`;

const SSH_KEYGEN = `while [ $# -gt 0 ]; do [ "$1" = -f ] && file="$2"; shift; done
echo key > "$file"; echo key > "$file.pub"`;

describe("kind-install.sh", () => {
  let host: StubHost;
  let state: string;

  beforeEach(() => {
    host = createStubHost();
    state = mkdtempSync(join(tmpdir(), "kind-install-state-"));
    symlinkSync(process.execPath, join(host.bin, "node"));
    symlinkSync(["/bin/chmod", "/usr/bin/chmod"].find(path => existsSync(path))!, join(host.bin, "chmod"));
    host.stub("docker", DOCKER);
    host.stub("kubectl", KUBECTL);
    host.stub("kind", KIND);
    host.stub("helm", "");
    host.stub("git", `echo ${CHECKOUT}`);
    host.stub("openssl", "echo 0123456789abcdef");
    host.stub("ssh-keygen", SSH_KEYGEN);
  });

  afterEach(() => {
    host.remove();
    rmSync(state, { recursive: true, force: true });
  });

  const run = (args: string[], machine = "arm64") => {
    host.stub("uname", `echo ${machine}`);
    return host.run(SCRIPT, args, { env: { OCTOGEE_KIND_STATE: state, INDEX, OPENROUTER_API_KEY: "sk-or-kind-test" } });
  };
  const copies = () => host.calls().filter(call => call.includes(" imagetools create "));
  const inspected = () => host.calls().filter(call => call.includes(" imagetools inspect "));
  const json = (file: string) => JSON.parse(readFileSync(join(state, "octogee", file), "utf8"));

  it("runs as an executable", () => {
    const result = spawnSync(SCRIPT, ["help"], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--pull");
  });

  it("installs the images published for a commit, copying the host platform's manifests instead of building", () => {
    const result = run(["up", "--pull", `--sha=${PUBLISHED}`]);
    expect(result.stderr).not.toContain("kind-install:");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skipping octogee-gateway-builder: the isolated gateway image is published only for linux/amd64, so isolated gateways will not run on this linux/arm64 host");
    expect(inspected()).toEqual(IMAGES.map(name => `docker KUBECONFIG=unset buildx imagetools inspect ${REGISTRY}/${name}:${PUBLISHED} --raw`));
    expect(copies()).toEqual(IMAGES.map(name =>
      `docker KUBECONFIG=unset buildx imagetools create --prefer-index=false --tag=localhost:5001/octogee/${name}:bbbbbbb ${REGISTRY}/${name}@${ARM64}`));
    expect(host.calls().filter(call => call.includes(" bake "))).toEqual([]);
    expect(json("digests.json")).toEqual({ platform: "linux/arm64", sha: PUBLISHED, images: Object.fromEntries(IMAGES.map(name => [name, ARM64])) });
    const values = json("images.yaml");
    expect(values["glm-controller"].image).toEqual({ repository: "localhost:5001/octogee/glm-controller", tag: "bbbbbbb", digest: ARM64 });
    expect(values["glm-controller"].platformRelease).toMatchObject({ sourceSha: PUBLISHED, gatewayImageTag: `bbbbbbb@${ARM64}` });
    expect(values["octogee-api"].replicas).toBeUndefined();
    expect(values).not.toHaveProperty("mattermost");
  });

  const manifest = (sha = CHECKOUT, images = IMAGES) => {
    const file = join(state, "image-manifest.json");
    writeFileSync(file, JSON.stringify({
      registry: REGISTRY,
      sha,
      images: Object.fromEntries(images.map((name, index) => [name, {
        platforms: { "linux/amd64": `sha256:${String(index + 3).repeat(64)}`, "linux/arm64": ARM64 },
      }])),
    }));
    return file;
  };

  it("installs the exact host digests from Build main without resolving image tags", () => {
    const result = run(["up", "--pull", `--manifest=${manifest(CHECKOUT, AMD64_IMAGES)}`], "x86_64");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Skipping");
    expect(inspected()).toEqual([]);
    expect(copies()).toEqual(AMD64_IMAGES.map((name, index) =>
      `docker KUBECONFIG=unset buildx imagetools create --prefer-index=false --tag=localhost:5001/octogee/${name}:ccccccc ${REGISTRY}/${name}@sha256:${String(index + 3).repeat(64)}`));
    expect(json("digests.json").images["glm-controller"]).toBe(`sha256:${"3".repeat(64)}`);
    const values = json("images.yaml");
    expect(values["glm-controller"].image.digest).toBe(`sha256:${"3".repeat(64)}`);
    expect(values["glm-controller"].platformRelease.builderImageTag).toBe(`ccccccc@sha256:${"8".repeat(64)}`);
    expect(values.global).toBeUndefined();
  });

  it("copies the VM bridge image only when asked, and points the VM bridge at it", () => {
    const extra = [...IMAGES, "vm-bridge"];
    const result = run(["up", "--pull", `--manifest=${manifest(CHECKOUT, extra)}`, `--images=${extra.join(",")}`], "x86_64");
    expect(result.status, result.stderr).toBe(0);
    expect(copies()).toEqual(extra.map((name, index) =>
      `docker KUBECONFIG=unset buildx imagetools create --prefer-index=false --tag=localhost:5001/octogee/${name}:ccccccc ${REGISTRY}/${name}@sha256:${String(index + 3).repeat(64)}`));
    expect(json("images.yaml").global.computer.bridge.image).toEqual({ repository: "localhost:5001/octogee/vm-bridge", tag: "ccccccc", digest: `sha256:${"8".repeat(64)}` });
  });

  it("refuses the isolated gateway image on an arm64 host before copying any image", () => {
    const result = run(["up", "--pull", `--sha=${PUBLISHED}`, "--images=glm-controller,octogee-gateway-builder"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("octogee-gateway-builder is not published for linux/arm64");
    expect(copies()).toEqual([]);
  });

  it("refuses a manifest from another build instead of pulling from tags", () => {
    const result = run(["up", "--pull", `--manifest=${manifest(PUBLISHED)}`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`does not match ${REGISTRY} at ${CHECKOUT}`);
    expect(inspected()).toEqual([]);
    expect(copies()).toEqual([]);
  });

  it("refuses a manifest missing a selected digest before copying any image", () => {
    const result = run(["up", "--pull", `--manifest=${manifest(CHECKOUT, IMAGES.slice(0, -1))}`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("octogee-gateway has no valid linux/arm64 digest");
    expect(inspected()).toEqual([]);
    expect(copies()).toEqual([]);
  });

  it("reinstalls the copied images under their own commit when rerun with --skip-build", () => {
    expect(run(["up", "--pull", `--sha=${PUBLISHED}`]).status).toBe(0);
    const copied = copies().length;
    const result = run(["up", "--skip-build"]);
    expect(result.status).toBe(0);
    expect(copies()).toHaveLength(copied);
    expect(json("images.yaml")["glm-controller"].platformRelease.sourceSha).toBe(PUBLISHED);
  });

  it("copies the amd64 images of the checkout's commit on an x86_64 host", () => {
    const result = run(["up", "--pull"], "x86_64");
    expect(result.status).toBe(0);
    expect(inspected()[0]).toBe(`docker KUBECONFIG=unset buildx imagetools inspect ${REGISTRY}/glm-controller:${CHECKOUT} --raw`);
    expect(copies()[0]).toBe(
      `docker KUBECONFIG=unset buildx imagetools create --prefer-index=false --tag=localhost:5001/octogee/glm-controller:ccccccc ${REGISTRY}/glm-controller@${AMD64}`);
    expect(json("digests.json").platform).toBe("linux/amd64");
  });

  it("runs the LLM broker from its own image", () => {
    expect(run(["up", "--pull", `--sha=${PUBLISHED}`]).status).toBe(0);
    expect(json("images.yaml").llmBroker).toEqual({
      image: { repository: "localhost:5001/octogee/llm-broker", tag: "bbbbbbb", digest: ARM64 },
    });
  });

  it("stores the operator's provider keys in Secrets without putting them on a command line", () => {
    const stored = mkdtempSync(join(tmpdir(), "kind-install-keys-"));
    host.stub("kubectl", `if [[ " $* " == *" create secret generic octogee-"* ]]; then
  for arg in "$@"; do
    case "$arg" in --from-file=api_key=*) cat "\${arg#--from-file=api_key=}" > "$STORED/$name" ;; esac
    [[ "$previous" == generic ]] && name="$arg"
    previous="$arg"
  done
  echo "kind: stub"
  exit 0
fi
${KUBECTL}`);
    const result = host.run(SCRIPT, ["up", "--pull", `--sha=${PUBLISHED}`], {
      env: { OCTOGEE_KIND_STATE: state, INDEX, STORED: stored, OPENROUTER_API_KEY: "sk-or-kind-test", ANTHROPIC_API_KEY: "sk-ant-kind-test" },
    });

    expect(result.status).toBe(0);
    expect(host.calls().join("\n")).not.toMatch(/sk-(or|ant)-kind-test/);
    expect(result.stdout + result.stderr).not.toMatch(/sk-(or|ant)-kind-test/);
    expect(result.stdout).toContain("Stored ANTHROPIC_API_KEY in Secret octogee-anthropic");
    expect(result.stdout).toContain("Stored OPENROUTER_API_KEY in Secret octogee-openrouter");
    expect(result.stdout).not.toContain("OPENAI_API_KEY");
    expect(readFileSync(join(stored, "octogee-openrouter"), "utf8")).toBe("sk-or-kind-test");
    expect(readFileSync(join(stored, "octogee-anthropic"), "utf8")).toBe("sk-ant-kind-test");
    expect(existsSync(join(stored, "octogee-openai"))).toBe(false);
    expect(host.calls().some(call => call.endsWith("rollout restart deployment/llm-broker"))).toBe(true);
    rmSync(stored, { recursive: true, force: true });
  });

  const upWithoutExportedKey = (env: Record<string, string> = {}) => {
    host.stub("uname", "echo arm64");
    return host.run(SCRIPT, ["up", "--pull", `--sha=${PUBLISHED}`], { env: { OCTOGEE_KIND_STATE: state, INDEX, ...env } });
  };
  const startedInstalling = () => host.calls().filter(call =>
    call.startsWith("docker ") || call.startsWith("kubectl ") || call.startsWith("helm ") || / (create|export) /.test(call));

  it("refuses to install without a model provider key, before it starts the registry, creates the cluster or copies images", () => {
    const result = upWithoutExportedKey();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("https://openrouter.ai/keys");
    for (const variable of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) expect(result.stderr).toContain(variable);
    expect(startedInstalling()).toEqual([]);
  });

  it("refuses a rerun when the existing cluster stores no provider key", () => {
    host.stub("kubectl", `if [[ " $* " == *" get secret octogee-"* ]]; then exit 1; fi
${KUBECTL}`);
    const result = upWithoutExportedKey({ CLUSTERS: "octogee" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENROUTER_API_KEY");
    expect(startedInstalling().filter(call => !call.includes(" get secret octogee-"))).toEqual([]);
  });

  it("accepts a provider key the existing cluster already stores, so a rerun need not export it", () => {
    host.stub("kubectl", `if [[ " $* " == *" get secret octogee-"* ]]; then [[ " $* " == *" get secret octogee-anthropic "* ]]; exit; fi
${KUBECTL}`);
    const result = upWithoutExportedKey({ CLUSTERS: "octogee" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("kind-install:");
  });

  describe("agent models", () => {
    let sqlDir: string;

    beforeEach(() => {
      sqlDir = mkdtempSync(join(tmpdir(), "kind-install-sql-"));
    });

    afterEach(() => {
      rmSync(sqlDir, { recursive: true, force: true });
    });

    const withStoredKeys = (stored: string[]) => host.stub("kubectl", `if [[ " $* " == *" get secret octogee-"* ]]; then
  for provider in ${stored.join(" ")}; do [[ " $* " == *" get secret octogee-$provider "* ]] && exit 0; done
  exit 1
fi
if [[ " $* " == *" exec -i statefulset/postgres -- psql "* ]]; then
  count=$(cat "$SQL_DIR/count" 2>/dev/null || echo 0); count=$((count + 1)); echo "$count" > "$SQL_DIR/count"
  cat > "$SQL_DIR/$count.sql"
  previous=""
  for arg in "$@"; do
    [[ "$previous" == -v && "$arg" == value=* ]] && printf '%s' "\${arg#value=}" > "$SQL_DIR/$count.value"
    previous="$arg"
  done
  [[ "$(cat "$SQL_DIR/$count.sql")" == *"SELECT updated_by"* ]] && printf '%s\\n' "$OWNER"
  exit 0
fi
${KUBECTL}`);
    const up = (env: Record<string, string> = {}, owner = "") => {
      host.stub("uname", "echo arm64");
      return host.run(SCRIPT, ["up", "--pull", `--sha=${PUBLISHED}`], { env: { OCTOGEE_KIND_STATE: state, INDEX, CLUSTERS: "octogee", SQL_DIR: sqlDir, OWNER: owner, ...env } });
    };
    const statements = () => {
      const count = existsSync(join(sqlDir, "count")) ? Number(readFileSync(join(sqlDir, "count"), "utf8")) : 0;
      return Array.from({ length: count }, (_, index) => ({
        sql: readFileSync(join(sqlDir, `${index + 1}.sql`), "utf8"),
        value: existsSync(join(sqlDir, `${index + 1}.value`)) ? JSON.parse(readFileSync(join(sqlDir, `${index + 1}.value`), "utf8")) : null,
      }));
    };
    const written = () => statements().filter(statement => statement.sql.includes("INSERT INTO platform.platform_config"));

    it.each([
      [["openrouter"], "openrouter"],
      [["anthropic"], "anthropic"],
      [["openai"], "openai"],
      [["anthropic", "openai"], "anthropic"],
      [["anthropic", "openai", "openrouter"], "openrouter"],
    ])("points agents and the house model at catalog models of a provider with a stored key (%j -> %s)", (stored, provider) => {
      withStoredKeys(stored);
      const result = up();

      expect(result.status, result.stderr).toBe(0);
      const [models] = written();
      expect(models.sql).toContain("'models'");
      expect(models.sql).toContain("'kind-install'");
      expect(parsePlatformModelConfig(models.value)).not.toBeNull();
      const refs = [models.value.builderAgentModelRef, models.value.builderAgentFallbackModelRef, models.value.freeTierModelRef];
      expect(refs.map(ref => resolveHouseModel(ref)?.provider)).toEqual([provider, provider, provider]);
      expect(models.value.builderAgentFallbackModelRef).not.toBe(models.value.builderAgentModelRef);
      expect(result.stdout).toContain(`Agents use ${models.value.builderAgentModelRef}`);
    });

    it("uses a key exported for this run before the cluster has its Secret", () => {
      withStoredKeys([]);
      const result = up({ OPENROUTER_API_KEY: "sk-or-kind-test" });

      expect(result.status, result.stderr).toBe(0);
      expect(resolveHouseModel(written()[0].value.builderAgentModelRef)?.provider).toBe("openrouter");
    });

    it("never defaults agents to OpenRouter's z-ai/glm-5.2", () => {
      withStoredKeys(["openrouter"]);
      expect(up().status).toBe(0);
      expect(Object.values(written()[0].value)).not.toContain("platform-openrouter/z-ai/glm-5.2");
    });

    it("sets no agent models when the install has no provider key", () => {
      withStoredKeys([]);
      const result = up();

      expect(result.status).not.toBe(0);
      expect(statements()).toEqual([]);
    });

    it("keeps agent models that someone else set", () => {
      withStoredKeys(["openrouter"]);
      const result = up({}, "kind-agent-round-trip");

      expect(result.status, result.stderr).toBe(0);
      expect(written()).toEqual([]);
      expect(result.stdout).toContain("Keeping the agent models that kind-agent-round-trip set");
    });

    it("replaces the agent models it set itself when the stored keys change", () => {
      withStoredKeys(["openai"]);
      const result = up({}, "kind-install");

      expect(result.status, result.stderr).toBe(0);
      expect(resolveHouseModel(written()[0].value.builderAgentModelRef)?.provider).toBe("openai");
    });
  });

  it.each([
    [["--pull", "--skip-build"], "Choose either --pull or --skip-build"],
    [["--manifest=manifest.json"], "--manifest needs --pull"],
    [[`--sha=${PUBLISHED}`], "--sha needs --pull"],
    [["--pull", "--sha=bbbbbbb"], "--sha needs a full commit SHA"],
  ])("refuses up %j before touching anything", (args, message) => {
    const result = run(["up", ...args]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(host.calls()).toEqual([]);
  });

  const downBeside = (node: string, pullsFromRegistry: boolean) => {
    host.stub("kind", `[[ "$1 $2 $3" == "get nodes --all-clusters" ]] && echo ${node}; exit 0`);
    host.stub("docker", `[[ "$1 $2" == "exec ${node}" ]] && exit ${pullsFromRegistry ? 0 : 1}; exit 0`);
    return run(["down"]);
  };
  const registryRemoved = () => host.calls().includes("docker KUBECONFIG=unset rm -f octogee-kind-registry");

  it("keeps the shared registry while another cluster from this script still pulls from it", () => {
    const result = downBeside("llmbroker-control-plane", true);
    expect(result.status, result.stderr).toBe(0);
    expect(registryRemoved()).toBe(false);
    expect(host.calls()).toContain(`kind KUBECONFIG=unset delete cluster --name octogee --kubeconfig ${state}/octogee/kubeconfig`);
    expect(result.stdout).toContain("Keeping registry octogee-kind-registry");
  });

  it("deletes the shared registry once no remaining kind cluster pulls from it", () => {
    const result = downBeside("unrelated-control-plane", false);
    expect(result.status, result.stderr).toBe(0);
    expect(registryRemoved()).toBe(true);
  });
});
