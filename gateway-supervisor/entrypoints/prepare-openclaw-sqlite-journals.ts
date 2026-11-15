import * as path from "node:path";
import { prepareOpenClawSqliteJournals } from "../lib/openclaw-sqlite-journal-preflight.js";

const stateDir = process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_DIR || "/home/node/.openclaw";
const result = prepareOpenClawSqliteJournals({ stateDir: path.resolve(stateDir), configPath: process.env.OPENCLAW_CONFIG_PATH });
process.stderr.write(`[openclaw-journal] prepared ${result.converted.length} existing WAL store(s) for 9p storage\n`);
