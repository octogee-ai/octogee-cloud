export interface VoiceMigrationInput {
  slug: string;
  operationId: string;
  phase: 'hold' | 'resume';
}

function voiceMigrationOrigin(env: NodeJS.ProcessEnv): URL {
  const base = new URL(env.GATEWAY_EDGE_INTERNAL_URL || 'http://127.0.0.1:3001');
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('voice migration requires a bare loopback gateway-edge origin');
  }
  return base;
}

export async function updateVoiceMigration(input: VoiceMigrationInput, options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<{ activeCalls: number }> {
  const env = options.env ?? process.env;
  const token = env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) throw new Error('OPENCLAW_GATEWAY_TOKEN is required to check active voice calls');
  const base = voiceMigrationOrigin(env);
  const response = await (options.fetch ?? fetch)(new URL('/internal/openclaw/voice/v1/migration', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`voice migration ${input.phase} failed: HTTP ${response.status}`);
  const body = await response.json() as { activeCalls?: unknown };
  if (typeof body.activeCalls !== 'number' || !Number.isSafeInteger(body.activeCalls) || body.activeCalls < 0) throw new Error('voice migration returned an invalid active call count');
  return { activeCalls: body.activeCalls };
}
