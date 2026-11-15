import {
  FEATURE_FLAG_KEYS,
  USER_VISIBLE_FEATURE_FLAG_KEYS,
  featureFlagBypassedForAdmin,
  isFeatureFlagKey,
  type FeatureDecision,
  type FeatureFlagKey,
  type FeaturePolicy as FeaturePolicyContract,
  type FeatureSubject,
} from "@octogee/shared/types/feature-flags";

export interface FeatureFlagProvider {
  evaluate(subject: FeatureSubject, keys: readonly FeatureFlagKey[]): Promise<{
    isEnabled(key: FeatureFlagKey): boolean;
  }>;
}

export interface FeaturePolicyMetrics {
  evaluation(flag: FeatureFlagKey, outcome: "enabled" | "disabled" | "unavailable"): void;
  providerError(reason: "timeout" | "provider_error"): void;
}

export interface FeaturePolicyLogger {
  error(message: string, fields: Record<string, unknown>): void;
}

class FeatureEvaluationTimeout extends Error {
  constructor() {
    super("Feature flag evaluation timed out");
    this.name = "FeatureEvaluationTimeout";
  }
}

function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new FeatureEvaluationTimeout()), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function unavailableReason(error: unknown): "timeout" | "provider_error" {
  return error instanceof FeatureEvaluationTimeout ? "timeout" : "provider_error";
}

export class FeaturePolicy implements FeaturePolicyContract {
  constructor(
    private readonly provider: FeatureFlagProvider,
    private readonly options: {
      timeoutMs?: number;
      metrics?: FeaturePolicyMetrics;
      logger?: FeaturePolicyLogger;
    } = {},
  ) {}

  async evaluate(
    key: FeatureFlagKey,
    subject: FeatureSubject,
    context: string,
  ): Promise<FeatureDecision> {
    const decisions = await this.evaluateMany([key], subject, context);
    return decisions[key];
  }

  async userVisibleDecisions(
    subject: FeatureSubject,
    context: string,
  ): Promise<Record<FeatureFlagKey, FeatureDecision>> {
    return this.evaluateMany(USER_VISIBLE_FEATURE_FLAG_KEYS, subject, context);
  }

  private async evaluateMany(
    keys: readonly FeatureFlagKey[],
    subject: FeatureSubject,
    context: string,
  ): Promise<Record<FeatureFlagKey, FeatureDecision>> {
    const bypassed = keys.filter((key) => featureFlagBypassedForAdmin(key, subject));
    const adminDecisions = bypassed.map((key) => {
      this.options.metrics?.evaluation(key, "enabled");
      return [key, { state: "enabled", value: true } satisfies FeatureDecision] as const;
    });
    const remaining = keys.filter((key) => !featureFlagBypassedForAdmin(key, subject));
    if (remaining.length === 0) {
      return Object.fromEntries(adminDecisions) as Record<FeatureFlagKey, FeatureDecision>;
    }

    try {
      const values = await within(
        this.provider.evaluate(subject, remaining),
        this.options.timeoutMs ?? 2_000,
      );
      return Object.fromEntries([...adminDecisions, ...remaining.map((key) => {
        const decision: FeatureDecision = values.isEnabled(key)
          ? { state: "enabled", value: true }
          : { state: "disabled", value: false };
        this.options.metrics?.evaluation(key, decision.state);
        return [key, decision];
      })]) as Record<FeatureFlagKey, FeatureDecision>;
    } catch (error) {
      const reason = unavailableReason(error);
      this.options.metrics?.providerError(reason);
      this.options.logger?.error("Feature flag evaluation failed", {
        context,
        reason,
        err: error,
      });
      return Object.fromEntries([...adminDecisions, ...remaining.map((key) => {
        this.options.metrics?.evaluation(key, "unavailable");
        return [key, { state: "unavailable", value: false, reason } satisfies FeatureDecision];
      })]) as Record<FeatureFlagKey, FeatureDecision>;
    }
  }
}

export class DisabledFeatureFlagProvider implements FeatureFlagProvider {
  async evaluate(_subject: FeatureSubject, _keys: readonly FeatureFlagKey[]): Promise<{
    isEnabled(key: FeatureFlagKey): boolean;
  }> {
    return { isEnabled: () => false };
  }
}

export class StaticFeatureFlagProvider implements FeatureFlagProvider {
  private readonly enabled: ReadonlySet<FeatureFlagKey>;

  constructor(enabled: Iterable<FeatureFlagKey>) {
    this.enabled = new Set(enabled);
  }

  async evaluate(_subject: FeatureSubject, _keys: readonly FeatureFlagKey[]): Promise<{
    isEnabled(key: FeatureFlagKey): boolean;
  }> {
    return { isEnabled: (key) => this.enabled.has(key) };
  }
}

const ENABLED_FEATURE_FLAGS = "ENABLED_FEATURE_FLAGS";

export function configuredFeatureFlagProvider(env: NodeJS.ProcessEnv): FeatureFlagProvider {
  const configured = env[ENABLED_FEATURE_FLAGS];
  if (configured === undefined) return new DisabledFeatureFlagProvider();
  const keys = configured.split(",").map((key) => key.trim()).filter((key) => key.length > 0);
  const unknown = keys.filter((key) => !isFeatureFlagKey(key));
  if (unknown.length > 0) {
    throw new Error(
      `${ENABLED_FEATURE_FLAGS} names unknown feature flags: ${unknown.join(", ")}. `
      + `Known flags: ${FEATURE_FLAG_KEYS.join(", ")}`,
    );
  }
  return new StaticFeatureFlagProvider(keys.filter(isFeatureFlagKey));
}
