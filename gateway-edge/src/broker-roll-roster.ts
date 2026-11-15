import { isAssignmentState } from "@octogee/shared/types/gateway-releases";
import { internalFetch, type InternalFetchOptions } from "@octogee/core/internal-fetch";
import type { RosterDocSnapshot } from "./roll-roster.js";

type BrokerFetcher = (
  url: string | URL,
  init?: RequestInit,
  opts?: InternalFetchOptions,
) => Promise<Response>;

type Schedule = (callback: () => void, delayMs: number) => () => void;

export interface BrokerRollRosterOptions {
  brokerUrl: string;
  gatewayId: string;
  revisionId: string;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  fetcher?: BrokerFetcher;
  schedule?: Schedule;
}

function trustedBrokerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("fleet broker URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("fleet broker URL must be an absolute http(s) URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname !== "octogee-api" &&
    !isOctogeeApiServiceHostname(hostname) &&
    hostname !== "localhost" &&
    hostname !== "127.0.0.1"
  ) {
    throw new Error("fleet broker URL must target octogee-api or localhost");
  }
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function isOctogeeApiServiceHostname(hostname: string): boolean {
  const prefix = "octogee-api.";
  const suffix = ".svc.cluster.local";
  if (!hostname.startsWith(prefix) || !hostname.endsWith(suffix)) return false;
  const namespace = hostname.slice(prefix.length, -suffix.length);
  if (!namespace || !isLowerDnsLabel(namespace[0]) || !isLowerDnsLabel(namespace.at(-1))) {
    return false;
  }
  for (const character of namespace) {
    if (!isLowerDnsLabel(character) && character !== "-") return false;
  }
  return true;
}

function isLowerDnsLabel(character: string | undefined): boolean {
  return !!character && (
    (character >= "a" && character <= "z") ||
    (character >= "0" && character <= "9")
  );
}

function malformedRoster(): Error {
  return new Error("fleet broker returned malformed assignment roster");
}

function rosterDocs(value: unknown): RosterDocSnapshot[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { assignments?: unknown }).assignments)) {
    throw malformedRoster();
  }
  const seenUids = new Set<string>();
  return (value as { assignments: unknown[] }).assignments.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw malformedRoster();
    const { uid, state, epoch } = entry as Record<string, unknown>;
    if (
      typeof uid !== "string" ||
      uid.length === 0 ||
      seenUids.has(uid) ||
      !isAssignmentState(state) ||
      typeof epoch !== "number" ||
      !Number.isSafeInteger(epoch) ||
      epoch < 0
    ) {
      throw malformedRoster();
    }
    seenUids.add(uid);
    return { id: uid, data: () => ({ uid, state, epoch }) };
  });
}

export async function readBrokerRollRoster(opts: BrokerRollRosterOptions): Promise<RosterDocSnapshot[]> {
  const brokerUrl = trustedBrokerUrl(opts.brokerUrl);
  const fetcher = opts.fetcher ?? internalFetch;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("roll roster request timeout must be a positive integer");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadlineError = new Error(
    `fleet broker assignment roster request timed out after ${requestTimeoutMs}ms`,
  );
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(deadlineError);
      controller.abort();
    }, requestTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  // The deadline must survive until the BODY is parsed, not just the headers: a
  // read that black-holes mid-body would otherwise neither resolve nor error,
  // leaving the last roster authoritative forever (no-double-serve hazard).
  let body: unknown;
  try {
    const response = await Promise.race([
      fetcher(`${brokerUrl}/internal/fleet/assignment-roster`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gatewayId: opts.gatewayId, revisionId: opts.revisionId }),
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (!response.ok) {
      throw new Error(`fleet broker assignment roster returned ${response.status}`);
    }
    try {
      body = await Promise.race([response.json(), deadline]);
    } catch (error) {
      if (error === deadlineError) throw error;
      throw malformedRoster();
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  return rosterDocs(body);
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearTimeout(timer);
}

export function createBrokerRollRosterSubscription(
  opts: BrokerRollRosterOptions,
): (onDocs: (docs: RosterDocSnapshot[]) => void, onError: (err: Error) => void) => () => void {
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("roll roster poll interval must be a positive integer");
  }
  const schedule = opts.schedule ?? defaultSchedule;
  return (onDocs, onError) => {
    let stopped = false;
    let cancelNextPoll: (() => void) | null = null;
    const poll = async (): Promise<void> => {
      try {
        const docs = await readBrokerRollRoster(opts);
        if (stopped) return;
        onDocs(docs);
        cancelNextPoll = schedule(() => {
          void poll();
        }, pollIntervalMs);
      } catch (error) {
        if (stopped) return;
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    };
    void poll();
    return () => {
      stopped = true;
      cancelNextPoll?.();
    };
  };
}
