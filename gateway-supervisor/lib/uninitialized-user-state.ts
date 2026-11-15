import fs from 'node:fs';
import path from 'node:path';
import { isolatedNativeInitialStateMatches } from './isolated-native-initial-state.js';

const GENERATED_AGENT_FILES = new Set(['models.json', '.platform-openai-managed', '.platform-openrouter-managed', '.platform-vertex-managed', '.platform-meta-managed']);

function entries(directory: string): fs.Dirent[] | null {
  try {
    if (!fs.lstatSync(directory).isDirectory()) return null;
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function absent(file: string): boolean {
  try { fs.lstatSync(file); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function onlyGeneratedAgentFiles(stateDir: string, agentId: string): boolean {
  const root = path.join(stateDir, 'agents', agentId);
  const dirs = entries(root);
  if (!dirs || dirs.some(entry => entry.name !== 'agent' || !entry.isDirectory())) return false;
  const files = entries(path.join(root, 'agent'));
  return files !== null && files.every(entry => entry.isFile() && GENERATED_AGENT_FILES.has(entry.name));
}

export function uninitializedUserState(stateDir: string, agentIds: readonly string[], database: {
  engine?: string;
  families?: { state?: { engine?: string } };
}, podUid?: string): boolean {
  const engine = database.families?.state?.engine ?? database.engine ?? 'sqlite';
  if (engine !== 'sqlite') return false;
  const state = entries(path.join(stateDir, 'state'));
  const agents = entries(path.join(stateDir, 'agents'));
  const client = entries(path.join(stateDir, 'client'));
  return state !== null && (state.length === 0 && client?.length === 0 || isolatedNativeInitialStateMatches(stateDir, podUid)) &&
    agents !== null && agents.every(agent => agent.isDirectory()) &&
    absent(path.join(stateDir, 'workspace-identity-ready')) &&
    absent(path.join(stateDir, 'workspace-identity-bootstrap.json')) &&
    [...new Set([...agentIds, ...agents.map(agent => agent.name)])].every(agentId => onlyGeneratedAgentFiles(stateDir, agentId));
}
