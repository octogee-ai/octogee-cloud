import {
  inspectContainer,
  setContainerPaused,
  setContainerRestartPolicy,
  type DockerEngine,
} from "./docker-engine.js";

export interface HeldContainerWriter {
  name: string;
  id: string;
}

const dockerId = /^[a-f0-9]{64}$/;

export async function acquireHeldContainerWriters(deps: {
  engine: DockerEngine;
  writers: readonly HeldContainerWriter[];
  assertHostHold: () => Promise<void>;
}) {
  const { engine, assertHostHold } = deps;
  const writers = structuredClone(deps.writers);
  if (!writers.length || writers.some(writer => !writer.name || !dockerId.test(writer.id)) ||
      new Set(writers.map(writer => writer.name)).size !== writers.length ||
      new Set(writers.map(writer => writer.id)).size !== writers.length) {
    throw new Error("The Native home writer roster is incomplete or ambiguous");
  }

  async function assertWriter(writer: HeldContainerWriter, paused: boolean, policy: "on-failure" | "no") {
    const current = await inspectContainer(engine, writer.name);
    const restart = current?.HostConfig?.RestartPolicy;
    if (current?.Id !== writer.id || current.State?.Running !== true || current.State.Paused !== paused ||
        restart?.Name !== policy || (restart.MaximumRetryCount ?? 0) !== 0) {
      throw new Error(`Native home writer ${writer.name} no longer matches its expected identity and hold`);
    }
  }

  await assertHostHold();
  for (const writer of writers) await assertWriter(writer, false, "on-failure");
  for (const writer of writers) {
    await assertHostHold();
    await assertWriter(writer, false, "on-failure");
    await setContainerRestartPolicy(engine, writer.id, "no");
    await assertHostHold();
    await assertWriter(writer, false, "no");
    await setContainerPaused(engine, writer.id, true);
  }

  let releasing = false;
  async function assertHeld() {
    if (releasing) throw new Error("The Native home writer hold is ending");
    await assertHostHold();
    for (const writer of writers) await assertWriter(writer, true, "no");
    await assertHostHold();
  }
  await assertHeld();

  return {
    assertHeld,
    async release() {
      await assertHeld();
      if (releasing) throw new Error("The Native home writer hold is already ending");
      releasing = true;
      for (const writer of writers) {
        await assertHostHold();
        await assertWriter(writer, true, "no");
        await setContainerRestartPolicy(engine, writer.id, "on-failure");
        await assertHostHold();
        await assertWriter(writer, true, "on-failure");
        await setContainerPaused(engine, writer.id, false);
        await assertWriter(writer, false, "on-failure");
      }
      await assertHostHold();
    },
  };
}
