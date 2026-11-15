import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { deploymentEnvironmentSettings } from '@octogee/core/deployment-environment';

const exec = promisify(execFile);

export async function withFleetStore(deps, run) {
  const settings = await deps.inspect();
  if (!['require', 'verify-full'].includes(settings.sslmode)) throw new Error(`Fleet database tunnel does not support SSL mode ${settings.sslmode}`);
  const tunnel = await deps.tunnel(settings);
  let value;
  let failure;
  try {
    value = await run({
      PLATFORM_DB_HOST: '127.0.0.1',
      PLATFORM_DB_PORT: String(tunnel.port),
      PLATFORM_DB_NAME: settings.database,
      PLATFORM_DB_USER: settings.user,
      PLATFORM_DB_PASSWORD: settings.password,
      PLATFORM_DB_SSLMODE: settings.sslmode,
      PLATFORM_DB_TLS_SERVER_IDENTITY: settings.sslmode === 'verify-full' ? (settings.tlsServerIdentity || settings.host) : '',
      PLATFORM_DB_CA_CERT: settings.caCertificate ?? '',
    });
  } catch (error) {
    failure = error;
  }
  try {
    await tunnel.close();
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], 'Fleet convergence and database tunnel cleanup failed');
    throw error;
  }
  if (failure) throw failure;
  return value;
}

export function fleetStoreDependencies(environment) {
  const target = deploymentEnvironmentSettings(environment);
  const base = ['--context', target.kubeContext, '--namespace', target.namespace];
  const kubectl = async (args) => (await exec('kubectl', [...base, ...args], { maxBuffer: 4 * 1024 * 1024 })).stdout;
  return {
    async inspect() {
      const deployment = JSON.parse(await kubectl(['get', 'deployment', 'glm-controller', '-o', 'json']));
      const container = deployment.spec.template.spec.containers.find(item => item.name === 'glm-controller');
      if (!container) throw new Error('Fleet controller container is missing from the deployed workload');
      if (typeof container.image !== 'string' || !container.image.includes('@sha256:')) throw new Error('Fleet controller image is not digest-addressed');
      const secret = JSON.parse(await kubectl(['get', 'secret', 'platform-state-postgres', '-o', 'json']));
      const value = (key, fallback) => {
        const encoded = secret.data?.[key];
        if (encoded === undefined && fallback !== undefined) return fallback;
        if (typeof encoded !== 'string') throw new Error(`Platform database secret is missing ${key}`);
        const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
        if (!decoded) throw new Error(`Platform database secret has an empty ${key}`);
        return decoded;
      };
      const host = value('host');
      const port = Number(value('port', '5432'));
      if (!/^[a-zA-Z0-9.:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid platform database address');
      return {
        host, port, image: container.image,
        database: value('database'),
        user: value('runtime-user'),
        password: value('runtime-password'),
        sslmode: value('sslmode'),
        tlsServerIdentity: value('tls-server-identity', ''),
        caCertificate: value('ca-cert', ''),
      };
    },
    async tunnel(settings) {
      const name = `platform-state-fleet-${randomBytes(6).toString('hex')}`;
      const server = `const n=require('net');n.createServer(c=>{const s=n.connect(${settings.port},${JSON.stringify(settings.host)});c.on('error',()=>s.destroy());s.on('error',()=>c.destroy());c.pipe(s).pipe(c)}).listen(15432,'0.0.0.0')`;
      const pod = { spec: { automountServiceAccountToken: false, activeDeadlineSeconds: 7200, nodeSelector: { 'cloud.google.com/private-node': 'true' }, containers: [{ name: 'tunnel', image: settings.image, command: ['node', '-e', server], ports: [{ containerPort: 15432 }] }] } };
      let forward;
      try {
        await kubectl(['run', name, `--image=${settings.image}`, '--restart=Never', '--labels=app=platform-state-migrate', `--overrides=${JSON.stringify(pod)}`]);
        await kubectl(['wait', '--for=create', `pod/${name}`, '--timeout=60s']);
        await kubectl(['wait', '--for=condition=Ready', `pod/${name}`, '--timeout=180s']);
        // eslint-disable-next-line sonarjs/no-os-command-from-path
        forward = spawn('kubectl', [...base, 'port-forward', '--address=127.0.0.1', `pod/${name}`, ':15432'], { stdio: ['ignore', 'pipe', 'pipe'] });
        const port = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Platform database port-forward did not start')), 30_000);
          let output = '';
          const read = (chunk) => {
            output += chunk.toString();
            const match = /Forwarding from 127\.0\.0\.1:(\d+) -> 15432/.exec(output);
            if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
          };
          forward.stdout.on('data', read);
          forward.stderr.on('data', read);
          forward.once('error', error => { clearTimeout(timeout); reject(error); });
          forward.once('exit', code => { clearTimeout(timeout); reject(new Error(`Platform database port-forward exited: ${code}`)); });
        });
        return { port, close: async () => { forward.kill(); await kubectl(['delete', 'pod', name, '--ignore-not-found', '--wait=false']); } };
      } catch (error) {
        forward?.kill();
        try { await kubectl(['delete', 'pod', name, '--ignore-not-found', '--wait=false']); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Platform database tunnel setup and cleanup failed'); }
        throw error;
      }
    },
  };
}
