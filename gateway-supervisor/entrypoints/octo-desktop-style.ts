import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runDeskCli } from "../lib/desk-control.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runDeskCli("octo-desktop-style", process.argv.slice(2), {
    env: process.env,
    fetchImpl: fetch,
    readFile: (path) => readFile(path, "utf8"),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
}
