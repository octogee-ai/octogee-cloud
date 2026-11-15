import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  getAccessToken: vi.fn(),
  GoogleAuth: vi.fn(function GoogleAuth(this: { getAccessToken: unknown }) {
    this.getAccessToken = h.getAccessToken;
  }),
  awsSend: vi.fn(),
  STSClient: vi.fn(function STSClient(this: { send: unknown }) {
    this.send = h.awsSend;
  }),
  GetCallerIdentityCommand: vi.fn(function GetCallerIdentityCommand(this: { input: unknown }, input: unknown) {
    this.input = input;
  }),
}));

vi.mock("google-auth-library", () => ({ GoogleAuth: h.GoogleAuth }));
vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: h.STSClient,
  GetCallerIdentityCommand: h.GetCallerIdentityCommand,
}));

const { githubConnector } = await import("./github.js");
const { googleConnector } = await import("./google.js");
const { microsoftConnector } = await import("./microsoft.js");
const { dockerConnector } = await import("./docker.js");
const { azureConnector } = await import("./azure.js");
const { gcpConnector } = await import("./gcp.js");
const { awsConnector } = await import("./aws.js");

function response(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("connector provider definitions", () => {
  beforeEach(() => {
    h.fetch.mockReset();
    h.getAccessToken.mockReset();
    h.GoogleAuth.mockClear();
    h.awsSend.mockReset();
    h.STSClient.mockClear();
    h.GetCallerIdentityCommand.mockClear();
    vi.stubGlobal("fetch", h.fetch);
  });

  it("keeps provider metadata wired to the shared connector catalog", () => {
    expect(githubConnector.meta.displayName).toBe("GitHub");
    expect(googleConnector.meta.id).toBe("google");
    expect(microsoftConnector.meta.id).toBe("microsoft");
    expect(dockerConnector.meta.captureMethods).toContain("fields");
    expect(azureConnector.meta.id).toBe("azure");
    expect(gcpConnector.meta.id).toBe("gcp");
    expect(awsConnector.meta.id).toBe("aws");
  });

  it("fetches GitHub identity with the expected API headers", async () => {
    h.fetch.mockResolvedValue(response(200, { login: "octo" }));

    await expect(githubConnector.fetchIdentity("gh-token")).resolves.toEqual({ accountLabel: "octo" });

    expect(h.fetch).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer gh-token",
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "octogee-connect",
        }),
      }),
    );
  });

  it("fetches Google identity and deep-probes the granted capabilities", async () => {
    h.fetch
      .mockResolvedValueOnce(response(200, { email: "builder@example.com" }))
      .mockResolvedValueOnce(response(200, { user: { emailAddress: "drive@example.com" } }));

    await expect(googleConnector.fetchIdentity("google-token")).resolves.toEqual({
      accountLabel: "builder@example.com",
    });
    await expect(
      googleConnector.deepProbe?.("google-token", ["https://www.googleapis.com/auth/drive.file"]),
    ).resolves.toEqual({
      probe: "drive.about",
      detail: "drive",
    });
  });

  it("probes Calendar through an endpoint authorized by calendar.events", async () => {
    h.fetch.mockResolvedValue(response(200, { items: [] }));

    await expect(
      googleConnector.deepProbe?.("google-token", [
        "https://www.googleapis.com/auth/calendar.events",
      ]),
    ).resolves.toEqual({
      probe: "calendar.events",
      detail: "calendar",
    });

    expect(h.fetch).toHaveBeenCalledWith(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1",
      { headers: { Authorization: "Bearer google-token" } },
    );
  });

  it("probes Tasks through an endpoint authorized by the tasks scope", async () => {
    h.fetch.mockResolvedValue(response(200, { items: [] }));

    await expect(
      googleConnector.deepProbe?.("google-token", ["https://www.googleapis.com/auth/tasks"]),
    ).resolves.toEqual({
      probe: "tasks.tasklists",
      detail: "tasks",
    });

    expect(h.fetch).toHaveBeenCalledWith(
      "https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1",
      { headers: { Authorization: "Bearer google-token" } },
    );
  });

  it("probes Contacts through an endpoint authorized by contacts.readonly", async () => {
    h.fetch.mockResolvedValue(response(200, { connections: [] }));

    await expect(
      googleConnector.deepProbe?.("google-token", [
        "https://www.googleapis.com/auth/contacts.readonly",
      ]),
    ).resolves.toEqual({
      probe: "people.connections",
      detail: "contacts",
    });

    expect(h.fetch).toHaveBeenCalledWith(
      "https://people.googleapis.com/v1/people/me/connections?personFields=names&pageSize=1",
      { headers: { Authorization: "Bearer google-token" } },
    );
  });

  it("uses Microsoft mail first and userPrincipalName as fallback", async () => {
    h.fetch
      .mockResolvedValueOnce(response(200, { mail: "mail@example.com", userPrincipalName: "upn@example.com" }))
      .mockResolvedValueOnce(response(200, { userPrincipalName: "upn@example.com" }));

    await expect(microsoftConnector.fetchIdentity("ms-token")).resolves.toEqual({
      accountLabel: "mail@example.com",
    });
    await expect(microsoftConnector.fetchIdentity("ms-token")).resolves.toEqual({
      accountLabel: "upn@example.com",
    });
  });

  it("validates Docker Hub username/token fields via the login endpoint", async () => {
    h.fetch.mockResolvedValue(response(200, { token: "docker-session" }));

    await expect(
      dockerConnector.validateFields?.({ username: "octo", token: "dckr_pat" }),
    ).resolves.toEqual({ accountLabel: "octo" });

    expect(h.fetch).toHaveBeenCalledWith(
      "https://hub.docker.com/v2/users/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "octo", password: "dckr_pat" }),
      }),
    );
  });

  it("validates Azure service principal fields only for tenant-like IDs", async () => {
    await expect(
      azureConnector.validateFields?.({ tenantId: "not a tenant", clientId: "client", clientSecret: "secret" }),
    ).rejects.toThrow("Tenant ID does not look like a tenant GUID or domain");

    h.fetch.mockResolvedValue(response(200, { access_token: "azure-token" }));
    await expect(
      azureConnector.validateFields?.({
        tenantId: "example.onmicrosoft.com",
        clientId: "client-123456789",
        clientSecret: "secret",
      }),
    ).resolves.toEqual({ accountLabel: expect.stringMatching(/^app client-1/) });
  });

  it("validates GCP service account JSON by minting a token", async () => {
    h.getAccessToken.mockResolvedValue("gcp-token");

    await expect(
      gcpConnector.validateFields?.({
        serviceAccountJson: JSON.stringify({
          type: "service_account",
          client_email: "svc@example.iam.gserviceaccount.com",
          private_key: "key",
        }),
      }),
    ).resolves.toEqual({ accountLabel: "svc@example.iam.gserviceaccount.com" });
    expect(h.GoogleAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
      }),
    );
  });

  it("validates AWS access key fields through GetCallerIdentity", async () => {
    h.awsSend.mockResolvedValue({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/octo" });

    await expect(
      awsConnector.validateFields?.({ accessKeyId: "AKIA", secretAccessKey: "secret" }),
    ).resolves.toEqual({ accountLabel: "123456789012 · octo" });
    expect(h.STSClient).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "us-east-1",
        credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      }),
    );
    expect(h.GetCallerIdentityCommand).toHaveBeenCalledWith({});
  });
});
