import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStubHost, REPO_ROOT, type StubHost } from "./deploy/stub-host";

const SCRIPT = join(REPO_ROOT, "scripts/ops/eks-install.sh");
const ACCOUNT = "123456789012";
const REGION = "us-west-2";
const INSTALL = `${ACCOUNT}-${REGION}`;
const SHA = "b".repeat(40);
const AMD64 = `sha256:${"1".repeat(64)}`;
const ARM64 = `sha256:${"2".repeat(64)}`;
const INDEX = JSON.stringify({
  manifests: [
    { digest: ARM64, platform: { os: "linux", architecture: "arm64" } },
    { digest: AMD64, platform: { os: "linux", architecture: "amd64" } },
  ],
});
const ASSETS = `octogee-${ACCOUNT}-${REGION}-assets`;
const WORKSPACES = `octogee-${ACCOUNT}-${REGION}-workspaces`;

const AWS = `case " $* " in
  *" sts get-caller-identity "*) echo ${ACCOUNT} ;;
  *" get-service-quota "*) echo "\${VCPU_QUOTA:-32.0}" ;;
  *" describe-instance-types "*)
    while [ "$1" != --instance-types ]; do shift; done; shift
    while [ "$1" != --query ]; do case "$1" in *.2xlarge) printf '%s\\t8\\n' "$1" ;; *) printf '%s\\t4\\n' "$1" ;; esac; shift; done ;;
  *" describe-launch-templates "*Tags*) echo "\${LT_GVISOR:-20261109.0}" ;;
  *" describe-launch-template-versions "*) echo "\${LT_TYPE:-m6i.xlarge}" ;;
  *" describe-launch-templates "*) { [ -n "\${LT_EXISTS:-}" ] || [ -f "$HOME/lt-created" ]; } || exit 1; echo lt-0abc123 ;;
  *" eks list-nodegroups "*) echo "\${NODEGROUPS-system gateways}" ;;
  *" eks describe-nodegroup "*)
    case " \${NODEGROUPS-system gateways} " in *" system "*) echo "\${SYSTEM_TYPE:-m6i.xlarge}" ;; *) echo ResourceNotFoundException >&2; exit 254 ;; esac ;;
  *" create-launch-template "*) touch "$HOME/lt-created" ;;
  *" eks describe-cluster "*vpcId*) echo vpc-1 ;;
  *" eks describe-cluster "*clusterSecurityGroupId*) echo sg-cluster ;;
  *" eks describe-cluster "*) [ -n "\${CLUSTER_EXISTS:-}" ] || exit 1 ;;
  *" describe-vpcs "*) echo 192.168.0.0/16 ;;
  *" describe-security-groups "*) echo None ;;
  *" create-security-group "*) echo sg-database ;;
  *" describe-subnets "*) printf 'subnet-a\\tsubnet-b\\n' ;;
  *" rds describe-db-instances "*--query*) echo octogee.abc123.${REGION}.rds.amazonaws.com ;;
  *" rds describe-db-"*) exit 1 ;;
  *" s3api head-bucket "* | *" iam get-user "*) exit 1 ;;
  *" iam create-access-key "*) printf 'AKIASTUBACCESS\\tstub/secret+key\\n' ;;
esac`;

const KUBECTL = `case " $* " in
  *" run sandbox-check-"*) echo "\${SANDBOX_DMESG-[    0.000000] Starting gVisor...}" ;;
  *" get endpointslice "*) echo 192.168.10.20; echo 192.168.30.40 ;;
  *"%{http_code}"*) echo 200 ;;
  *"jsonpath={.data."*) printf 'c3R1Yg==' ;;
  *" team search "*) echo '"name": "octogee"' ;;
  *" get secret "*) exit 1 ;;
  *" -f - "*) cat >> "$HOME/applied.yaml" ;;
  *" run psql-"*) cat >/dev/null ;;
  *"-o yaml"*) echo "kind: stub" ;;
esac`;

const SSH_KEYGEN = `while [ $# -gt 0 ]; do [ "$1" = -f ] && file="$2"; shift; done
echo key > "$file"; echo key > "$file.pub"`;

describe("eks-install.sh", () => {
  let host: StubHost;
  let state: string;

  beforeEach(() => {
    host = createStubHost();
    state = mkdtempSync(join(tmpdir(), "eks-install-state-"));
    symlinkSync(process.execPath, join(host.bin, "node"));
    for (const tool of ["chmod", "paste", "sort", "touch"]) {
      symlinkSync([`/bin/${tool}`, `/usr/bin/${tool}`].find(path => existsSync(path))!, join(host.bin, tool));
    }
    host.stub("sleep", "");
    host.stub("aws", AWS);
    host.stub("eksctl", "");
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
    env: { AWS_REGION: REGION, OCTOGEE_EKS_STATE: state, INDEX, OPENROUTER_API_KEY: "sk-or-eks-test", ...env },
  });
  const calls = (tool: string, fragment: string) =>
    host.calls().filter(call => call.startsWith(`${tool} `) && call.includes(fragment));
  const installed = (file: string) => readFileSync(join(state, INSTALL, file), "utf8");
  const applied = () => readFileSync(join(host.home, "applied.yaml"), "utf8");

  describe("up", () => {
    it("creates the cluster with network policy enforcement and a tainted node group for gateways", () => {
      const result = up();
      expect(result.stderr).not.toContain("eks-install:");
      expect(result.status).toBe(0);
      expect(calls("eksctl", "create cluster")).toEqual([
        `eksctl KUBECONFIG=unset create cluster -f ${join(state, INSTALL, "eksctl.yaml")} --write-kubeconfig=false`,
      ]);
      const config = installed("eksctl.yaml");
      expect(config).toContain(`'{"enableNetworkPolicy":"true"}'`);
      const gateways = config.slice(config.indexOf("- name: gateways"));
      expect(gateways).toContain("id: lt-0abc123");
      expect(gateways).toContain("privateNetworking: true");
      expect(gateways).toMatch(/taints:\n\s+- key: octogee\.io\/sandbox\n\s+value: gvisor\n\s+effect: NoSchedule/);
      expect(gateways).not.toContain("instanceType");
    });

    it("installs the pinned gVisor release on gateway nodes at boot and keeps their pods away from the instance metadata service", () => {
      expect(up().status).toBe(0);
      const template = JSON.parse(installed("gateway-launch-template.json"));
      expect(template.InstanceType).toBe("m6i.xlarge");
      expect(template.MetadataOptions).toEqual({ HttpEndpoint: "enabled", HttpTokens: "required", HttpPutResponseHopLimit: 1 });
      const userData = Buffer.from(template.UserData, "base64").toString("utf8");
      expect(userData).toContain(`curl -fsSLo gvisor.tar.bz2 "https://storage.googleapis.com/gvisor/releases/release/20261109.0/$(uname -m)/gvisor.tar.bz2"`);
      expect(userData).toContain("x86_64) sum=1a6b8f74c37b4931ef473f67ec1f601690855bedc52ac709f2fac965c69677aa0426ef44598d8eee1aed72cfdb9df87a2a5f352cb3348880fc61a7732bc10f2a ;;");
      expect(userData).toContain('echo "$sum  gvisor.tar.bz2" | sha512sum -c -');
      expect(userData).not.toContain(".sha512");
      expect(userData).toContain("tar -xjf gvisor.tar.bz2 -C /usr/local/bin");
      expect(userData).toContain("cat >> /etc/containerd/config.toml");
      expect(userData).toContain(`[plugins."$plugin".containerd.runtimes.runsc]\nruntime_type = "io.containerd.runsc.v1"`);
      expect(calls("aws", "create-launch-template")[0]).toContain(`file://${join(state, INSTALL, "gateway-launch-template.json")}`);
      expect(calls("aws", "create-launch-template")[0]).toContain("Tags=[{Key=octogee.io/gvisor-release,Value=20261109.0}]");
    });

    it("stops before changing the cluster when the gateway launch template was made with other settings", () => {
      for (const [env, made] of [[{ LT_TYPE: "m6i.large" }, "m6i.large gateway nodes with gVisor 20261109.0"], [{ LT_GVISOR: "None" }, "m6i.xlarge gateway nodes with gVisor None"]] as const) {
        const result = up({ CLUSTER_EXISTS: "1", LT_EXISTS: "1", ...env });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`Launch template octogee-gateways makes ${made}, not m6i.xlarge with gVisor 20261109.0.`);
      }
      expect(host.calls().filter(call => call.startsWith("eksctl ") || / (create|put|authorize)-/.test(call))).toEqual([]);
    });

    it("stops before changing the node groups when the system nodes are of another instance type", () => {
      const result = up({ CLUSTER_EXISTS: "1", LT_EXISTS: "1", SYSTEM_TYPE: "m6i.large" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Node group system runs m6i.large nodes, not m6i.xlarge");
      expect(host.calls().filter(call => call.startsWith("eksctl "))).toEqual([]);
    });

    it("creates the node groups of a cluster whose first run stopped before making them", () => {
      expect(up({ CLUSTER_EXISTS: "1", LT_EXISTS: "1", NODEGROUPS: "" }).status).toBe(0);
      expect(calls("aws", "describe-nodegroup")).toEqual([]);
      expect(calls("eksctl", "create nodegroup")).toHaveLength(1);
    });

    it("registers the gvisor runtime class on the gateway nodes and makes encrypted gp3 the default storage class", () => {
      expect(up().status).toBe(0);
      const runtimeClass = applied().slice(applied().indexOf("kind: RuntimeClass"));
      expect(runtimeClass).toContain("handler: runsc");
      expect(runtimeClass).toMatch(/nodeSelector:\n\s+octogee\.io\/sandbox: gvisor/);
      expect(runtimeClass).toMatch(/- key: octogee\.io\/sandbox\n\s+operator: Equal\n\s+value: gvisor\n\s+effect: NoSchedule/);
      expect(applied()).toMatch(/name: gp3\n\s+annotations:\n\s+storageclass\.kubernetes\.io\/is-default-class: "true"/);
      expect(applied()).toContain(`encrypted: "true"`);
    });

    it("stops before creating the database when a gvisor pod does not report the gVisor kernel", () => {
      const result = up({ SANDBOX_DMESG: "[    0.000000] Linux version 6.1.0" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("the gateway nodes do not sandbox gateways");
      expect(calls("aws", "create-db-instance")).toEqual([]);
    });

    it("creates a private, encrypted PostgreSQL 16 that only the cluster can reach", () => {
      expect(up().status).toBe(0);
      expect(calls("aws", "authorize-security-group-ingress")[0]).toContain("--group-id sg-database --protocol tcp --port 5432 --source-group sg-cluster");
      expect(calls("aws", "create-db-subnet-group")[0]).toContain("--subnet-ids subnet-a subnet-b");
      const database = calls("aws", "create-db-instance")[0];
      for (const flag of ["--engine postgres --engine-version 16", "--vpc-security-group-ids sg-database", "--no-publicly-accessible", "--storage-encrypted", "--backup-retention-period 7"]) {
        expect(database).toContain(flag);
      }
    });

    it("lets the blob store user use the objects of both buckets and read their versioning, and nothing else", () => {
      expect(up().status).toBe(0);
      const call = calls("aws", "put-user-policy")[0];
      expect(call).toContain("--user-name octogee-blob-store");
      const policy = JSON.parse(call.slice(call.indexOf("--policy-document ") + "--policy-document ".length));
      const grants = policy.Statement.flatMap((statement: { Action: string[]; Resource: string[] }) =>
        statement.Action.flatMap(action => statement.Resource.map(resource => `${action} ${resource}`)));
      expect(grants).toContain(`s3:GetBucketVersioning arn:aws:s3:::${WORKSPACES}`);
      expect(grants).toContain(`s3:PutObject arn:aws:s3:::${ASSETS}/*`);
      expect(grants.every((grant: string) => grant.endsWith(ASSETS) || grant.endsWith(WORKSPACES) || grant.endsWith("/*"))).toBe(true);
      expect(grants.some((grant: string) => /s3:\*|DeleteBucket|PutBucket/.test(grant))).toBe(false);
    });

    it("stores the access key exactly, with no trailing newline in either half", () => {
      expect(up().status).toBe(0);
      expect(installed("secrets/s3-access-key")).toBe("AKIASTUBACCESS");
      expect(installed("secrets/s3-secret-key")).toBe("stub/secret+key");
    });

    it("stores only the provider keys exported in its environment", () => {
      const result = up();
      expect(result.stdout).toContain("Stored OPENROUTER_API_KEY in Secret octogee-openrouter");
      const providerSecrets = host.calls().filter(call => /create secret generic octogee-(openrouter|openai|anthropic) /.test(call));
      expect(providerSecrets.map(call => /octogee-(\w+) /.exec(call)![1])).toEqual(["openrouter"]);
    });

    it("installs the linux/amd64 digest of each published image with the account's own addresses", () => {
      expect(up().status).toBe(0);
      const values = JSON.parse(installed("environment.yaml"));
      expect(values["octogee-api"].image).toEqual({ repository: "ghcr.io/octogee-ai/octogee-cloud/octogee-api", tag: "bbbbbbb", digest: AMD64 });
      expect(values["glm-controller"].platformRelease.builderImageTag).toBe(`bbbbbbb@${AMD64}`);
      expect(values.global.blobStore).toEqual({
        endpoint: `https://s3.${REGION}.amazonaws.com`, region: REGION, bucket: ASSETS, workspaceBucket: WORKSPACES,
      });
      expect(values.mattermost.db.host).toBe(`octogee.abc123.${REGION}.rds.amazonaws.com`);
      expect(values.networkPolicy.agentStorePostgresCidr).toBe("192.168.0.0/16");
      expect(values.projectRunner.apiServerEgressCidrs).toEqual(["192.168.10.20/32", "192.168.30.40/32"]);
    });

    it("runs shared gateways at the m sizing tier unless SHARED_GATEWAY_TIER names another", () => {
      expect(up().status).toBe(0);
      expect(JSON.parse(installed("environment.yaml"))["glm-controller"].gatewayValues).toEqual({ classDefaults: { shared: "m" } });
      expect(up({ SHARED_GATEWAY_TIER: "s" }).status).toBe(0);
      expect(JSON.parse(installed("environment.yaml"))["glm-controller"].gatewayValues).toEqual({ classDefaults: { shared: "s" } });
    });

    it("resizes the node groups of an existing cluster instead of creating it", () => {
      expect(up({ CLUSTER_EXISTS: "1", LT_EXISTS: "1", GATEWAY_NODES: "3" }).status).toBe(0);
      expect(calls("eksctl", "create cluster")).toEqual([]);
      expect(calls("aws", "create-launch-template")).toEqual([]);
      expect(calls("eksctl", "create nodegroup")).toHaveLength(1);
      expect(calls("eksctl", "scale nodegroup")).toEqual([
        `eksctl KUBECONFIG=unset scale nodegroup --cluster octogee --region ${REGION} --name system --nodes 2 --nodes-min 2 --nodes-max 2`,
        `eksctl KUBECONFIG=unset scale nodegroup --cluster octogee --region ${REGION} --name gateways --nodes 3 --nodes-min 3 --nodes-max 3`,
      ]);
    });

    it("stops before creating anything when the commit has no published images", () => {
      host.stub("docker", `echo "ERROR: $4: not found" >&2; exit 1`);
      const result = up();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Commit ${SHA} has no published images: its Build main run did not publish`);
      expect(host.calls().filter(call => call.startsWith("eksctl ") || / (create|put|authorize)-/.test(call))).toEqual([]);
    });

    it("stops before creating anything when the account may not run as many vCPUs as the nodes need", () => {
      const result = up({ VCPU_QUOTA: "16.0", GATEWAY_INSTANCE_TYPE: "m6i.2xlarge" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("The nodes need 24 vCPUs of standard instances, and this account may run 16 in us-west-2.");
      expect(calls("aws", "describe-instance-types")[0]).toContain("--instance-types m6i.xlarge m6i.2xlarge --query");
      expect(host.calls().filter(call => call.startsWith("eksctl ") || / (create|put|authorize)-/.test(call))).toEqual([]);
    });

    it("installs when the quota covers exactly what the nodes need", () => {
      expect(up({ VCPU_QUOTA: "16.0" }).status).toBe(0);
    });

    it("stops before creating anything when no model provider key is exported or stored", () => {
      const result = host.run(SCRIPT, ["up", `--sha=${SHA}`], { env: { AWS_REGION: REGION, OCTOGEE_EKS_STATE: state } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("agents need a model provider key");
      expect(host.calls().filter(call => call.startsWith("eksctl ") || / (create|put|authorize)-/.test(call))).toEqual([]);
    });

    it("rejects a node count or shared gateway tier it cannot use before calling AWS", () => {
      expect(up({ GATEWAY_NODES: "0" }).stderr).toContain("GATEWAY_NODES must be a whole number of nodes");
      expect(up({ SHARED_GATEWAY_TIER: "xl" }).stderr).toContain("SHARED_GATEWAY_TIER must be s, m or l");
      expect(host.calls().filter(call => call.startsWith("aws "))).toEqual([]);
    });
  });

  describe("down", () => {
    const DOWN_AWS = `case " $* " in
  *" sts get-caller-identity "*) echo ${ACCOUNT} ;;
  *" describe-security-groups "*) if [ -n "\${PRESENT:-}" ]; then echo sg-database; else echo None; fi ;;
  *" describe-launch-templates "*) [ -n "\${PRESENT:-}" ] || exit 1; echo lt-0abc123 ;;
  *" list-access-keys "*) echo AKIASTUBACCESS ;;
  *" describe-"* | *" head-bucket "* | *" get-user "* | *" get-user-policy "*) [ -n "\${PRESENT:-}" ] || exit 1 ;;
  *" \${FAIL_DELETE:-none} "*) echo "stub: deletion refused" >&2; exit 1 ;;
esac`;
    const DOWN_KUBECTL = `case " $* " in
  *" get pv "*)
    seen=$(cat "$HOME/pv-polls" 2>/dev/null || echo 0); echo $((seen + 1)) > "$HOME/pv-polls"
    if [ "$seen" -lt "\${HELD_VOLUMES:-0}" ]; then echo persistentvolume/pvc-stub; fi ;;
esac`;
    const down = (env: Record<string, string>) => {
      host.stub("aws", DOWN_AWS);
      host.stub("kubectl", DOWN_KUBECTL);
      mkdirSync(join(state, INSTALL, "secrets"), { recursive: true });
      writeFileSync(join(state, INSTALL, "secrets", "postgres-password"), "kept");
      return host.run(SCRIPT, ["down"], { env: { AWS_REGION: REGION, OCTOGEE_EKS_STATE: state, ...env } });
    };
    const deletions = () => host.calls()
      .map(call => call.replace(/ KUBECONFIG=unset| --region \S+| --kubeconfig=\S+| --context=\S+| -n \S+/g, ""))
      .filter(call => /^(aws \S+|eksctl|kubectl) (delete|rb)\b/.test(call))
      .map(call => call.split(" ").slice(0, 3).join(" "));

    it("deletes the database before the cluster whose network it uses, then everything else and its local state", () => {
      const result = down({ PRESENT: "1" });
      expect(result.status).toBe(0);
      expect(deletions()).toEqual([
        "aws rds delete-db-instance", "aws rds delete-db-subnet-group", "aws ec2 delete-security-group",
        "eksctl delete cluster", "aws ec2 delete-launch-template", "aws s3 rb", "aws s3 rb",
        "aws iam delete-access-key", "aws iam delete-user-policy", "aws iam delete-user",
      ]);
      expect(calls("aws", "rds wait db-instance-deleted")).toHaveLength(1);
      expect(existsSync(join(state, INSTALL))).toBe(false);
    });

    it("waits for the namespace's volumes to be released before deleting anything else", () => {
      mkdirSync(join(state, INSTALL), { recursive: true });
      writeFileSync(join(state, INSTALL, "kubeconfig"), "stub");
      const result = down({ PRESENT: "1", HELD_VOLUMES: "2" });
      expect(result.status).toBe(0);
      expect(deletions().slice(0, 2)).toEqual(["kubectl delete namespace", "aws rds delete-db-instance"]);
      expect(host.calls().filter(call => call.startsWith("sleep "))).toHaveLength(2);
    });

    it("skips what is already gone", () => {
      expect(down({}).status).toBe(0);
      expect(deletions()).toEqual([]);
      expect(existsSync(join(state, INSTALL))).toBe(false);
    });

    it("stops at a failed deletion and keeps the local secrets", () => {
      const result = down({ PRESENT: "1", FAIL_DELETE: "delete-db-instance" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("deletion refused");
      expect(calls("eksctl", "delete cluster")).toEqual([]);
      expect(readFileSync(join(state, INSTALL, "secrets", "postgres-password"), "utf8")).toBe("kept");
    });
  });
});
