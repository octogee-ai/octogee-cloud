import { strict as assert } from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function loadOpenClawBundledFunction(packageRoot: string, filePrefix: string, functionName: string) {
  const files = (await readdir(`${packageRoot}/dist`)).filter((file) => file.startsWith(filePrefix) && /\.m?js$/u.test(file)).sort();
  for (const file of files) {
    const modulePath = `${packageRoot}/dist/${file}`;
    const text = await readFile(modulePath, "utf8");
    for (const declaration of text.matchAll(/export\s+\{([^}]+)\}/gu)) {
      const entry = declaration[1].split(",").map((value) => value.trim().split(" as ")).find(([name]) => name === functionName);
      if (!entry) continue;
      const exportName = entry[1] ?? functionName;
      const module = await import(pathToFileURL(modulePath).href);
      assert.equal(typeof module[exportName], "function", `${functionName} must be an actual exported runtime function`);
      return { fn: module[exportName], modulePath, exportName };
    }
  }
  throw new Error(`OpenClaw artifact does not export ${functionName} from ${filePrefix}*.js`);
}
