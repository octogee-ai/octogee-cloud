import { GoogleAuth } from "google-auth-library";
import type { LogEntriesSource } from "@octogee/core/fleet-logs";

const ENTRIES_LIST_URL = "https://logging.googleapis.com/v2/entries:list";

type PostJson = (url: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

interface EntriesListResponse {
  readonly entries?: unknown[];
  readonly nextPageToken?: string;
}

function googlePostJson(): PostJson {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/logging.read"] });
  return async (url, body, signal) => {
    const client = await auth.getClient();
    return (await client.request<unknown>({ url, method: "POST", data: body, signal })).data;
  };
}

export function createCloudLoggingSource(resourceName: string, postJson: PostJson = googlePostJson()): LogEntriesSource {
  return {
    async list(request, signal) {
      const response = await postJson(ENTRIES_LIST_URL, {
        resourceNames: [resourceName],
        filter: request.filter,
        orderBy: request.orderBy,
        pageSize: request.pageSize,
        ...(request.pageToken === undefined ? {} : { pageToken: request.pageToken }),
      }, signal) as EntriesListResponse;
      return {
        entries: response.entries ?? [],
        ...(response.nextPageToken ? { nextPageToken: response.nextPageToken } : {}),
      };
    },
  };
}
