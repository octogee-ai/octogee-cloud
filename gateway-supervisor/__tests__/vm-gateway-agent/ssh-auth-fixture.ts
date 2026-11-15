import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function sshAuthentication(root: string, authorized: string) {
  const keys = `${root}/ssh-test-keys`;
  await mkdir(keys, { mode: 0o700 });
  for (const key of ["host", "A", "B", "C"]) await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", `${keys}/${key}`]);
  const publicKey = (key: string) => readFile(`${keys}/${key}.pub`, "utf8");
  await writeFile(authorized, await publicKey("B"), { mode: 0o600 });
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const config = `${keys}/sshd_config`;
  await writeFile(config, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${keys}/host\nAuthorizedKeysFile ${authorized}\nPidFile ${keys}/pid\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nStrictModes no\nPerSourcePenalties no\nLogLevel ERROR\n`);
  const server = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
  let diagnostics = "";
  server.stderr.on("data", (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-2_000); });
  const close = async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
    server.kill();
    await exited;
  };
  const authenticate = async (key: string, command = "true") => {
    try {
      await exec("ssh", ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=2", "-i", `${keys}/${key}`, "-p", String(port), `${userInfo().username}@127.0.0.1`, command], { timeout: 5_000 });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code !== 255) throw error;
      return false;
    }
  };
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await authenticate("B")) return { publicKey, authenticate, close, diagnostics: () => diagnostics };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("local SSH authentication fixture could not admit its current key");
  } catch (error) {
    await close();
    throw error;
  }
}
