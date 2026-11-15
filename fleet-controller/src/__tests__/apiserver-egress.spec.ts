import { describe, expect, it, vi } from "vitest";

import {
  createCachedApiServerEgressResolver,
  resolveApiServerEgressCidrs,
  type KubectlRunner,
} from "../apiserver-egress";

function runner(map: Record<string, { stdout?: string; code?: number; stderr?: string }>): KubectlRunner {
  return vi.fn(async (args: string[]) => {
    const kind = args[1]; // get <kind> ...
    const r = map[kind] ?? { code: 1, stderr: "unexpected" };
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
  });
}

describe("resolveApiServerEgressCidrs", () => {
  it("returns endpoint + ClusterIP as sorted /32s", async () => {
    const cidrs = await resolveApiServerEgressCidrs(
      runner({ endpoints: { stdout: "10.128.0.2" }, service: { stdout: "34.118.224.1" } }),
      vi.fn(),
    );
    expect(cidrs).toEqual(["10.128.0.2/32", "34.118.224.1/32"]);
  });

  it("handles an HA control plane (multiple endpoints, space-separated) and dedupes", async () => {
    const cidrs = await resolveApiServerEgressCidrs(
      runner({ endpoints: { stdout: "10.128.0.2 10.128.0.3" }, service: { stdout: "10.128.0.2" } }),
      vi.fn(),
    );
    expect(cidrs).toEqual(["10.128.0.2/32", "10.128.0.3/32"]);
  });

  it("returns [] when both reads fail — caller keeps the prior egress", async () => {
    const log = vi.fn();
    const cidrs = await resolveApiServerEgressCidrs(
      runner({ endpoints: { code: 1, stderr: "forbidden" }, service: { code: 1, stderr: "forbidden" } }),
      log,
    );
    expect(cidrs).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("resolved no apiserver CIDRs"));
  });

  it("still returns the ClusterIP if only the endpoints read fails", async () => {
    const cidrs = await resolveApiServerEgressCidrs(
      runner({ endpoints: { code: 1 }, service: { stdout: "34.118.224.1" } }),
      vi.fn(),
    );
    expect(cidrs).toEqual(["34.118.224.1/32"]);
  });

  it("ignores non-IPv4 garbage in output", async () => {
    const cidrs = await resolveApiServerEgressCidrs(
      runner({ endpoints: { stdout: "not-an-ip" }, service: { stdout: "34.118.224.1" } }),
      vi.fn(),
    );
    expect(cidrs).toEqual(["34.118.224.1/32"]);
  });
});

describe("createCachedApiServerEgressResolver", () => {
  it.each(["cold", "expired"])("coalesces concurrent lookups when the cache is %s", async state => {
    const kubectl = runner({ endpoints: { stdout: "10.128.0.2" }, service: { stdout: "34.118.224.1" } });
    let t = 1000;
    const resolve = createCachedApiServerEgressResolver(kubectl, vi.fn(), 5000, () => t);
    if (state === "expired") {
      await resolve();
      t += 5001;
      vi.mocked(kubectl).mockClear();
    }

    const results = await Promise.all(Array.from({ length: 4 }, () => resolve()));

    expect(results).toEqual(Array.from({ length: 4 }, () => ["10.128.0.2/32", "34.118.224.1/32"]));
    expect(kubectl).toHaveBeenCalledTimes(2);
  });

  it("coalesces a failed lookup and allows the next call to retry", async () => {
    const kubectl = runner({ endpoints: { code: 1 }, service: { code: 1 } });
    const resolve = createCachedApiServerEgressResolver(kubectl, vi.fn());

    expect(await Promise.all([resolve(), resolve()])).toEqual([[], []]);
    expect(kubectl).toHaveBeenCalledTimes(2);
    expect(await resolve()).toEqual([]);
    expect(kubectl).toHaveBeenCalledTimes(4);
  });

  it("caches a successful resolve within the TTL, then refreshes after it", async () => {
    const kubectl = runner({ endpoints: { stdout: "10.128.0.2" }, service: { stdout: "34.118.224.1" } });
    let t = 1000;
    const resolve = createCachedApiServerEgressResolver(kubectl, vi.fn(), 5000, () => t);

    expect(await resolve()).toEqual(["10.128.0.2/32", "34.118.224.1/32"]);
    await resolve(); // within TTL → served from cache
    expect(kubectl).toHaveBeenCalledTimes(2); // 2 = endpoints + service, from the first call only

    t = 7000; // past TTL
    await resolve();
    expect(kubectl).toHaveBeenCalledTimes(4); // refreshed
  });

  it("does not cache an empty (failed) resolve — retries next call", async () => {
    const kubectl = runner({ endpoints: { code: 1 }, service: { code: 1 } });
    const resolve = createCachedApiServerEgressResolver(kubectl, vi.fn(), 5000, () => 1000);

    expect(await resolve()).toEqual([]);
    await resolve();
    expect(kubectl).toHaveBeenCalledTimes(4); // both calls re-ran (no cache of empty)
  });
});
