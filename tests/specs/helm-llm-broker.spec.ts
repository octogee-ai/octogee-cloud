import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { findDoc, useUmbrellaChart } from "./helpers/umbrella-chart";

const chart = useUmbrellaChart("octogee-llm-broker-");

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean } };
}

interface BrokerContainer {
  image: string;
  command: string[];
  env: EnvVar[];
}

function brokerContainer(sets: Record<string, string> = {}): BrokerContainer {
  const deployment = findDoc(chart.helmTemplate({ sets }), "Deployment", "llm-broker");
  expect(deployment, "the kind values render the llm-broker Deployment").not.toBeNull();
  const parsed = parse(deployment!) as { spec: { template: { spec: { containers: BrokerContainer[] } } } };
  return parsed.spec.template.spec.containers[0];
}

function env(container: BrokerContainer, name: string): EnvVar | undefined {
  return container.env.find((entry) => entry.name === name);
}

describe("the LLM broker on a platform-only install", () => {
  it("runs the platform broker entry from the octogee-api image", () => {
    const container = brokerContainer();

    expect(container.image).toMatch(/^registry\.example\/octogee-api:aaaaaaa@sha256:/);
    expect(container.command).toEqual(["node", "node_modules/@octogee/llm-broker/dist/main.js"]);
  });

  it.each([
    ["ANTHROPIC_API_KEY", "octogee-anthropic"],
    ["OPENROUTER_API_KEY", "octogee-openrouter"],
    ["OPENAI_API_KEY", "octogee-openai"],
  ])("reads %s only from the optional Secret %s", (name, secret) => {
    const variable = env(brokerContainer(), name);

    expect(variable?.value).toBeUndefined();
    expect(variable?.valueFrom?.secretKeyRef).toEqual({ name: secret, key: "api_key", optional: true });
  });

  it("sets a price markup only when the values name one", () => {
    expect(env(brokerContainer(), "PLATFORM_CREDIT_MARKUP_MULTIPLIER")).toBeUndefined();
    expect(env(brokerContainer({ "llmBroker.prepaidCreditMarkupMultiplier": "1.25" }), "PLATFORM_CREDIT_MARKUP_MULTIPLIER"))
      .toEqual({ name: "PLATFORM_CREDIT_MARKUP_MULTIPLIER", value: "1.25" });
  });
});
