import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanTree } from "../ci/factory-deny-list-scan.js";
import { DENY_LIST, DENY_LIST_MODULE, THIRD_PARTY_AUTHOR_FILES, VENDORED_FILES, denyListHits, isTestFile } from "../lib/factory-deny-list.js";

const scriptsDir = fileURLToPath(new URL("..", import.meta.url));
const script = join(scriptsDir, "ci/factory-deny-list-scan.ts");
const run = (root: string) => execFileSync(process.execPath, [join(scriptsDir, "node_modules/tsx/dist/cli.mjs"), script, root], { encoding: "utf8", stdio: "pipe" });

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "deny-scan-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("factory deny-list scan", () => {
  it("reports a clean tree, skipping node_modules, .git, and the deny list module itself", () => {
    const root = tree({
      "README.md": "clean",
      "node_modules/dep/index.js": "octogee-test",
      ".git/config": "mail chris@gmail.com",
      [DENY_LIST_MODULE]: "octogee-test 94934561284",
    });
    expect(scanTree(root)).toEqual({ files: 2, hits: [] });
    expect(run(root)).toContain("deny list: clean across 2 files");
  });

  it("fails with the file and line of every hit", () => {
    const root = tree({ "docs/a.md": "fine\nsee octogee-test", "b.md": "costs $5" });
    const hits = scanTree(root).hits.sort((x, y) => (x.file < y.file ? -1 : 1));
    expect(hits).toEqual([
      { file: "b.md", line: 1, rule: "price", text: "$5" },
      { file: "docs/a.md", line: 2, rule: "TEST environment identity", text: "octogee-test" },
    ]);
    expect(() => run(root)).toThrow(/docs\/a\.md:2 TEST environment identity: "octogee-test"/);
  });

  it("skips test files and still reports the same text in the code beside them", () => {
    const denied = "project: octogee-test, a 14-day trial";
    const root = tree({ "fleet-controller/src/__tests__/reconcile.spec.ts": denied, "fleet-controller/src/reconcile.ts": denied });
    expect(scanTree(root).hits).toEqual([
      { file: "fleet-controller/src/reconcile.ts", line: 1, rule: "TEST environment identity", text: "octogee-test" },
      { file: "fleet-controller/src/reconcile.ts", line: 1, rule: "trial", text: "trial" },
    ]);
  });
});

const ruleHits = (file: string, content: string) => denyListHits(new Map([[file, content]])).map(hit => [hit.rule, hit.text]);

describe("factory deny-list price rule", () => {
  it.each([
    ["docs/plans.md", "Personal plans are $20, $100 or $200 a month."],
    ["docs/costs.md", "it costs $5 per seat"],
    ["docs/refund.md", "cancel before it ends and you pay $0)."],
    ["docs/range.md", "about ~$6–24/mo on a VPS"],
    ["docs/scale.md", "a $150k salary and $2.5B ARR"],
    ["docs/thousands.md", "an annual price of $1,000"],
    ["src/nudge.ts", 'const nudge = "Octogee Personal at $20/mo";'],
    ["src/label.ts", 'const label = "$49";'],
    ["src/rate.ts", "const line = `usage: 12 tokens ($0.1235)`;"],
    ["docs/monthly.md", "billed at 20/mo"],
    ["docs/usd.md", "a 20 USD credit"],
    ["src/legacy.ts", "// openclaw's own cost, which is $0 for every call"],
    ["docs/free.md", "the first month would charge at $0."],
    ["src/per-month.ts", "console.log(`${label}: $${(amount / 100).toFixed(2)}/mo`);"],
    ["docs/unit.md", "the modal shows one $/mo figure"],
    ["src/allowance.ts", 'const title = "meters a free user against the $1 weekly house allowance";'],
    ["src/quoted.ts", 'const label = "$5/month";'],
    ["src/quoted-per.ts", "const label = '$9 per seat';"],
    ["docs/capital.md", "Costs $5."],
    ["docs/only.md", "Only $5!"],
    ["docs/currency.md", "The plan costs US$20 per year"],
    ["docs/currency-single.md", "about US$5 per seat"],
  ])("refuses the price in %s", (file, content) => {
    expect(ruleHits(file, content).map(([rule]) => rule)).toContain("price");
  });

  it.each([
    ["scripts/run.sh", 'local plan_file="$1"'],
    ["scripts/args.sh", "cp $1 $2"],
    ["scripts/case.sh", 'case "$1 $2" in'],
    ["scripts/bare-case.sh", "case $1 in"],
    ["src/query.ts", 'client.query("SELECT 1 FROM pg_roles WHERE rolname = $1 AND rolcanlogin", [name])'],
    ["src/lock.ts", "client.query(`SELECT last_version FROM ${table} WHERE name = $1 FOR UPDATE`, [name])"],
    ["src/fake-cli.ts", 'const fake = `#!/bin/sh\ncat <<EOF\nexec "$0" "$@"\nEOF`;'],
    ["scripts/fields.sh", "awk '{print $2}' list.txt"],
    ["scripts/fields2.sh", "awk -F, '{ total += $3 } END { print total }'"],
    ["src/rewrite.ts", 'html.replace(/<head([^>]*)>/, "<head$1><base>")'],
    ["src/swap.ts", "name.replace(/(\\w+)-(\\w+)/, '$1-$2')"],
    ["src/escaped.sh", 'echo "\\$1 stays literal"'],
    ["scripts/usage.sh", 'echo "usage: $0 <file>"; cd "$(dirname $0)"'],
    ["docs/volume.md", "below ~50–100k sends/mo and 421 h/mo"],
    ["scripts/join.sh", 'echo "$1-$2"'],
    ["src/sql-is.ts", 'client.query("SELECT 1 WHERE a IS $1", [a])'],
  ])("does not read the reference in %s as a price", (file, content) => {
    expect(ruleHits(file, content)).not.toContainEqual(["price", expect.anything()]);
  });
});

describe("factory deny-list personal email rule", () => {
  it.each([
    "mail chris@gmail.com",
    "a.b+tag@company.io",
    "notify ops@example.company.com",
    "email: `${uid}@octogee.local`,",
    "const addr = `bounce-${Date.now()}@bounces.com`;",
    "use `@resend.dev` simulator addresses",
    "contact ops@alerts.target.com",
    "page oncall@billing.service.io",
  ])("refuses the address in %s", content => {
    expect(ruleHits("x.md", content).map(([rule]) => rule)).toContain("personal email");
  });

  it.each([
    "user@example.test",
    "owner@example.com, a@example.net, b@example.org",
    "admin@gitea.test and agent@octogee.test",
    "bot@service.example",
    "nobody@octogee.invalid",
    "dev@app.localhost",
    "    @unittest.skipUnless(sys.platform == 'linux', 'linux only')",
    "support@octogee.com",
    "owner: someone@squarepointconsulting.com",
    "member = \"serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com\"",
    "After=network-online.target user-runtime-dir@1000.service user@1000.service",
    "| `systemd-zram-setup@zram0.service` | compressed swap |",
  ])("does not refuse the reserved or non-address text %s", content => {
    expect(ruleHits("x.md", content)).not.toContainEqual(["personal email", expect.anything()]);
  });
});

describe("factory deny-list TEST environment identity rule", () => {
  it.each([
    "project: octogee-test",
    "namespace=octogee-test-west",
    "https://api-test.octogee.com",
    "--context=gke_octogee-test_us-central1_octogee-gateway",
    "--context=gke_octogee_us-central1_octogee-gateway",
    "kubectl --context gke_us-west1_octogee get pods",
    "kubectl --context=gke_us-central1_octogee-gateway",
  ])("refuses the identity in %s", content => {
    expect(ruleHits("x.sh", content).map(([rule]) => rule)).toContain("TEST environment identity");
  });

  it.each([
    'agentId: "octogee-tester10-coach"',
    "resource \"google_pubsub_topic\" \"gke_notifications\" {",
    "member = google_service_account.gke_nodes.email",
    'KUBE_CONTEXT="gke_${PROJECT_ID}_${REGION}_${CLUSTER_NAME}"',
  ])("does not refuse the non-identity %s", content => {
    expect(ruleHits("x.sh", content)).not.toContainEqual(["TEST environment identity", expect.anything()]);
  });
});

describe("factory deny-list service account rule", () => {
  it.each([
    "deployer@octogee.iam.gserviceaccount.com",
    "serviceAccount:octogee-release-${env}@octogee-test.iam.gserviceaccount.com",
    "publisher@octogee-customer-hosting-test.iam.gserviceaccount.com",
    "sa@proj.iam.gserviceaccount.com",
    "/v1/projects/-/serviceAccounts/octogee-gw%40octogee.iam.gserviceaccount.com",
    "serviceAccount:123456789012-compute@developer.gserviceaccount.com",
  ])("refuses the account in %s", content => {
    expect(ruleHits("x.tf", content).map(([rule]) => rule)).toContain("service account");
  });

  it.each([
    'local sa="github-actions@${PROJECT_ID}.iam.gserviceaccount.com"',
    "member = \"serviceAccount:${var.name}@${var.project_id}.iam.gserviceaccount.com\"",
    'GATEWAY_SA="octogee-gateway@__FIREBASE_PROJECT__.iam.gserviceaccount.com"',
    "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com",
    "service-${n}@serverless-robot-prod.iam.gserviceaccount.com",
    "deployer@example.iam.gserviceaccount.com",
    'if (!email.endsWith(".iam.gserviceaccount.com")) throw error;',
  ])("does not refuse the non-identity %s", content => {
    expect(ruleHits("x.tf", content)).not.toContainEqual(["service account", expect.anything()]);
  });
});

it("reports a service account address under the service account rule only", () => {
  expect(ruleHits("x.tf", "deployer@octogee.iam.gserviceaccount.com")).toEqual([["service account", "@octogee.iam.gserviceaccount.com"]]);
});

describe("factory deny-list margin rule", () => {
  it.each([
    "65% gross margin at 12 h/day",
    "| **Margin** | **$1.89 (10%)** |",
    "thin margins on the Hobby plan",
    "Gross margin: 65%",
    "the target margins: 40% on Personal",
    "Gross margin - 65%",
    "Gross margin > 60%",
    "gross-margin targets",
    "GROSS MARGIN: 65%",
    "margin = 40%",
    "(margin)",
    "gross/margin targets",
  ])("refuses the business margin in %s", content => {
    expect(ruleHits("x.md", content).map(([rule]) => rule)).toContain("margin");
  });

  it.each([
    "html, body { margin: 0; min-height: 100%; }",
    "  margin: 12px 0 0;",
    "    anchors.margins: Style.spacing.md",
    "      margins {",
    "  <margins><top>0</top></margins>",
    'gum style --border rounded --margin "0 0 1 0" "Dock"',
    "<style>body{margin:0}</style>",
    "  margin-top: 4px;",
    '<View style={{margin: 4}}>',
    '"margin": 4,',
    'margin="0 0 1 0"',
    "  margin-inline-start: auto;",
  ])("does not refuse the layout property in %s", content => {
    expect(ruleHits("x.css", content)).not.toContainEqual(["margin", expect.anything()]);
  });
});

it("reports a line once per rule even when several of the rule's patterns match", () => {
  expect(ruleHits("x.md", "Personal is $20/mo, about $2.5k a year")).toEqual([["price", "$20"]]);
  expect(ruleHits("x.md", "Dan at Studio")).toEqual([["partner or portfolio name", "Dan"]]);
});

describe("factory deny-list identity exceptions do not shelter a real identity beside them", () => {
  it.each([
    ["reserved domain as a prefix", "personal email", "write to user@example.com.evil.io"],
    ["reserved TLD as a prefix", "personal email", "write to user@example.test.evil.io"],
    ["reserved label as a subdomain", "personal email", "admin@test.company.com"],
    ["localhost label as a subdomain", "personal email", "dev@localhost.company.com"],
    ["company domain as a prefix", "personal email", "x@octogee.com.evil.io"],
    ["operator company domain as a prefix", "personal email", "x@squarepointconsulting.com.evil.io"],
    ["operator company domain as a suffix", "personal email", "x@notsquarepointconsulting.com"],
    ["address opening a line", "personal email", "chris@gmail.com"],
    ["indented address opening a line", "personal email", "\tchris@gmail.com"],
    ["unit suffix as a subdomain", "personal email", "ops@alerts.target.com"],
    ["unit name as a prefix", "personal email", "x@1000.service.evil.io"],
    ["service-account domain as a prefix", "personal email", "x@gcp-sa-fake.iam.gserviceaccount.com.attacker.net"],
    ["example project as a prefix", "personal email", "sa@example.iam.gserviceaccount.com.evil.io"],
    ["example-like project", "service account", "name@example-prod.iam.gserviceaccount.com"],
    ["robot-like project", "service account", "ci@serverless-robot-prod2.iam.gserviceaccount.com"],
    ["agent-like project", "service account", "ci@gcpsa-pubsub.iam.gserviceaccount.com"],
    ["project number inside a service agent", "GCP project number", "service-94934561284@gcp-sa-pubsub.iam.gserviceaccount.com"],
    ["kube context inside a longer token", "TEST environment identity", "CTX_gke_octogee_us-central1_octogee-gateway"],
    ["kube context for a numbered project", "TEST environment identity", "gke_acme-123_europe-west4_prod"],
    ["TEST project with a digit suffix", "TEST environment identity", "project: octogee-test2"],
    ["TEST host as a prefix", "TEST environment identity", "https://api-test.octogee.com.evil.io"],
  ])("refuses a real identity beside the %s exception", (_exception, rule, content) => {
    expect(ruleHits("x.md", content).map(([name]) => name)).toContain(rule);
  });
});

it("reports an App Engine default account under the service account rule", () => {
  expect(ruleHits("x.tf", 'account = "octogee@appspot.gserviceaccount.com"')).toContainEqual(["service account", "@appspot.gserviceaccount.com"]);
});

describe("factory deny-list price rule contract", () => {
  const priced = (content: string) => ruleHits("x.md", content).some(([rule]) => rule === "price");

  it.each([
    ["a price-shaped amount", ["$20", "$0.99", "$20.00", "$1,200", "$2.5B", "$150k", '"$20"', "($20)", "[$20]"], ["cp $1 $2", "$0"]],
    ["a currency-prefixed amount", ["The plan costs US$20 per year", "about US$5 per seat", "about us$5 per seat", "costs US\\$20 a year"], ["VAR$1", "echo ${US}$1"]],
    ["a Markdown-escaped amount", ["The annual plan costs \\$20 per year.", "An annual credit of \\$100.", "costs \\$5."], ['echo "\\$1 stays literal"', "cat <<EOF\n\\$1 \\$2\nEOF", 'sed "s/^/\\$1 /" file']],
    ["a single digit with a unit or range", ["$5 per seat", "$5/mo", "$5 PER SEAT", "$5/MO", "~$6–24/mo", "$6 - $24"], ['echo "$1-$2"', 'path="$1/$2"']],
    ["a single digit after a price word", ["costs $5.", "Only $5!", "pay $0)", "Price: $5"], ['WHERE a IS $1', "set at=$1"]],
    ["a single digit before a lowercase word", ["the $1 weekly allowance", "the  $1  weekly allowance"], ["cp $1 $2", "case $1 in", "WHERE id = $1 AND", "if [ $1 -gt 2 ]"]],
    ["a currency code", ["20 USD", "USD 20", "a 20 usd credit", "EUR 15", "20 Usd", "usd 20"], ["USDC", "USD balance"]],
    ["a currency symbol", ["€20", "£20", "20€", "¥500"], ["€", "price in £"]],
    ["a spelled-out currency", ["20 dollars", "500 euros", "Twenty-five cents is 25 cents"], ["dollars", "the euro zone"]],
    ["a per-month figure", ["20/mo", "billed at 20/month", "20/MONTH", "$20/Mo", "${price}/mo", "one $/mo figure"], ["421 h/mo", "50–100k sends/mo"]],
  ])("reports %s and leaves its look-alikes clear", (_form, reported: string[], clear: string[]) => {
    for (const content of reported) expect(priced(content), content).toBe(true);
    for (const content of clear) expect(priced(content), content).toBe(false);
  });

  it.each([
    ["a single digit with no price context", "you get it for $5."],
    ["a spaced dollar sign", "only $ 20 a month"],
    ["a trailing dollar sign", "it costs 20$"],
    ["an HTML entity", "&#36;20 per seat"],
    ["a per-year figure without a dollar sign", "20/yr"],
    ["an escaped single digit before a word", "the \\$1 weekly allowance"],
  ])("knowingly leaves %s unreported", (_gap, content) => {
    expect(priced(content)).toBe(false);
  });

  it.each([
    "this charges you for $1 on your agent's computer",
    "the hook refuses to $1 registry",
    "usage: $0 baseline",
  ])("knowingly reports the shell reference in prose %s", content => {
    expect(priced(content)).toBe(true);
  });
});

describe("factory deny-list identity rules together", () => {
  const identityRules = new Set(DENY_LIST.filter(rule => rule.scope === "identity").map(rule => rule.name));
  const identityHits = (content: string) => ruleHits("x.tf", content).filter(([rule]) => identityRules.has(rule));

  it.each([
    "deployer@acme-prod.iam.gserviceaccount.com",
    "/v1/projects/-/serviceAccounts/deployer%40acme-prod.iam.gserviceaccount.com",
    "acme-prod@appspot.gserviceaccount.com",
    "octogee@appspot.gserviceaccount.com",
    "123456789012-compute@developer.gserviceaccount.com",
    "123456789012@cloudbuild.gserviceaccount.com",
    "123456789012@cloudservices.gserviceaccount.com",
    "service-123456789012@gcp-sa-pubsub.iam.gserviceaccount.com",
    "service-123456789012@serverless-robot-prod.iam.gserviceaccount.com",
    "service-123456789012@container-engine-robot.iam.gserviceaccount.com",
    "service-123456789012@gs-project-accounts.iam.gserviceaccount.com",
    "robot@acme-prod.svc.gserviceaccount.com",
    "chris@gmail.com",
    "owner@acme.co.uk",
    "project: octogee-test",
    "https://api-test.octogee.com",
    "gke_acme-prod_us-central1_cluster",
    "projects/94934561284/locations/global",
    "https://admin.octogee.com",
    "https://monitoring.octogee.com",
  ])("reports the real identity %s under at least one identity rule", content => {
    expect(identityHits(content)).not.toEqual([]);
  });

  it.each([
    'account = "${project}@appspot.gserviceaccount.com"',
    "member = \"serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com\"",
    "PROJECT_NUMBER-compute@developer.gserviceaccount.com",
    "${n}@cloudbuild.gserviceaccount.com",
    "service-${n}@gcp-sa-pubsub.iam.gserviceaccount.com",
    "deployer@example.iam.gserviceaccount.com",
    "example@appspot.gserviceaccount.com",
    'local sa="github-actions@${PROJECT_ID}.iam.gserviceaccount.com"',
  ])("reports no identity for the placeholder %s", content => {
    expect(identityHits(content)).toEqual([]);
  });

  it("accepts the operator's own company domain under every rule", () => {
    expect(DENY_LIST.map(rule => rule.name)).not.toContain("company domain");
    expect(ruleHits("x.tf", 'members = ["user:someone@squarepointconsulting.com"] # squarepointconsulting')).toEqual([]);
  });
});

describe("factory deny-list Google AI Studio", () => {
  it.each([
    "tagline: 'Gemini API key (Google AI Studio)',",
    'return { accountLabel: "AI Studio key" };',
  ])("does not read the Google product name in %s as a partner", content => {
    expect(ruleHits("x.ts", content)).toEqual([]);
  });

  it.each([
    "the Studio",
    "Studio AI",
    "AI Studio and Studio",
    "OpenAI Studio",
  ])("still reports the partner name in %s", content => {
    expect(ruleHits("x.ts", content)).toEqual([["partner or portfolio name", "Studio"]]);
  });
});

describe("factory deny-list third-party author files", () => {
  const author = THIRD_PARTY_AUTHOR_FILES[0]!;

  it("lists third-party author files by exact path, never by pattern", () => {
    expect(THIRD_PARTY_AUTHOR_FILES).toContain("gateway/openclaw-tarball/npm-12.2.1.patch");
    for (const path of THIRD_PARTY_AUTHOR_FILES) expect(path).toMatch(/^[\w./-]+\.[a-z]+$/);
  });

  it.each(THIRD_PARTY_AUTHOR_FILES)("does not apply the personal email rule to %s", path => {
    expect(ruleHits(path, '"author": "Beau Gunderson <beau@beaugunderson.com>"')).toEqual([]);
  });

  it("still applies every other identity rule to a listed third-party author file", () => {
    const hits = ruleHits(author, "octogee-test 94934561284 deployer@x.iam.gserviceaccount.com admin.octogee.com Seven Peaks").map(([rule]) => rule);
    expect(new Set(hits)).toEqual(new Set(["TEST environment identity", "GCP project number", "service account", "admin host", "partner or portfolio name"]));
  });

  it("applies the personal email rule to an unlisted file beside a third-party author file", () => {
    const sibling = author.replace(/[^/]+$/, "ours.ts");
    expect(ruleHits(sibling, "mail chris@gmail.com")).toEqual([["personal email", "@gmail.com"]]);
  });
});

describe("factory deny-list vendored files", () => {
  const vendored = VENDORED_FILES.find(path => !THIRD_PARTY_AUTHOR_FILES.includes(path))!;

  it("lists vendored third-party files by exact path, never by pattern", () => {
    expect(VENDORED_FILES.length).toBeGreaterThan(0);
    for (const path of VENDORED_FILES) expect(path).toMatch(/^[\w./-]+\.[a-z]+$/);
  });

  it("does not apply wording rules to a listed vendored file", () => {
    expect(ruleHits(vendored, 'if (token.markup === "```") price = "$5"; // stripe trial margin')).toEqual([]);
  });

  it("still applies every identity rule to a listed vendored file", () => {
    const hits = ruleHits(vendored, "octogee-test chris@gmail.com 94934561284 deployer@x.iam.gserviceaccount.com admin.octogee.com Seven Peaks").map(([rule]) => rule);
    expect(new Set(hits)).toEqual(new Set(["TEST environment identity", "personal email", "GCP project number", "service account", "admin host", "partner or portfolio name"]));
  });

  it("applies wording rules to an unlisted file beside a vendored one", () => {
    const sibling = vendored.replace(/[^/]+$/, "ours.ts");
    expect(ruleHits(sibling, "const markup = 1;").map(([rule]) => rule)).toEqual(["markup"]);
  });
});

describe("factory deny-list test files", () => {
  it.each([
    "scripts/__tests__/factory-deny-list-scan.spec.ts",
    "scripts/__tests__/source-transfer-launcher.test.py",
    "fleet-controller/src/__tests__/fixtures/placement-policy.ts",
    "core/src/fleet-signature.spec.ts",
    "platform-api/src/__tests__/byok-broker.emulator.spec.ts",
    "gateway/openclaw-tarball/npm-distribution.test.mjs",
    "gateway-edge/src/test-setup/public-app-origins.ts",
    "core/src/fixtures/fleet-keys.ts",
    "desktop/fixtures/computer-tool-acceptance.html",
    "desktop/image/test_firewall.py",
    "tests/vitest.config.ts",
  ])("classifies %s as a test file", path => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each([
    "terraform/environments/test/main.tf",
    "terraform/product/posthog/test/main.tf",
    "charts/octogee/values.test.yaml",
    "charts/octogee/templates/tests/test-mm-admin-token.yaml",
    "platform-api/src/test-helpers/fixture-accounts.ts",
    "core-testing/src/journal-store.ts",
    "scripts/ops/rebuild-test-env.sh",
    "scripts/ci/factory-deny-list-scan.ts",
    "desktop/acceptance/display-resize.py",
    "desktop/image/attest_boot.py",
    "fleet-controller/src/latest-release.ts",
  ])("does not classify %s as a test file", path => {
    expect(isTestFile(path)).toBe(false);
  });

  it("reports no rule on a test file and reports the same text in a non-test file", () => {
    const denied = "deploy to octogee-test, then run the trial checkout";
    expect(ruleHits("gateway-edge/src/__tests__/billing.spec.ts", denied)).toEqual([]);
    expect(ruleHits("gateway-edge/src/billing.ts", denied)).toEqual([["TEST environment identity", "octogee-test"], ["trial", "trial"]]);
  });
});
