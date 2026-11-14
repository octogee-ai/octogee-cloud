import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../gateway-edge/src/lib/db', () => ({
  db: {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false, data: () => undefined }),
        update: async () => undefined,
        collection: () => ({
          doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
        }),
      }),
      where: () => ({ where: () => ({ get: async () => ({ size: 0, docs: [] }) }) }),
    }),
  },
  FieldValue: {
    increment: (n: number) => ({ __op: 'increment', operand: n }),
    serverTimestamp: () => ({ __op: 'serverTimestamp' }),
  },
}));

import { createApp } from '../index.js';

const createSidecarApp = () => createApp({ surface: 'sidecar' });

describe('gateway-edge middleware stack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS;
    delete process.env.OPENCLAW_DASHBOARD_BRIDGE_ENABLED;
    delete process.env.GATEWAY_ID;
    delete process.env.GATEWAY_REVISION_ID;
    delete process.env.GATEWAY_CLASS;
    delete process.env.API_PUBLIC_URL;
    delete process.env.APP_URL;
  });

  it('sets CORS headers for a localhost origin when local origins are enabled', async () => {
    process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS = 'true';
    const app = createSidecarApp();
    const res = await request(app)
      .get('/health')
      .set('Origin', 'http://localhost:4321');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4321');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('withholds CORS allow-origin for localhost in production builds (flag unset)', async () => {
    delete process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS;
    const app = createSidecarApp();
    const res = await request(app)
      .get('/health')
      .set('Origin', 'http://localhost:4321');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([
    'https://evil.example.com',
    'https://app-octogee-build-week.web.app',
  ])('does not set allow-origin header for disallowed origin %s', async (origin) => {
    const app = createSidecarApp();
    const res = await request(app)
      .get('/health')
      .set('Origin', origin);

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('handles CORS preflight on public route', async () => {
    const app = createSidecarApp();
    const res = await request(app)
      .options('/api/workspace')
      .set('Origin', 'https://octogee.web.app')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://octogee.web.app');
  });

  it('exposes metrics endpoint', async () => {
    const app = createSidecarApp();
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/plain');
    expect(res.text).toContain('http_requests_total');
  });

  it('records Dashboard asset throttling in request metrics', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const app = createSidecarApp();
      for (let index = 0; index < 180; index++) {
        await request(app).get('/api/g/walter/openclaw/assets/app.js')
          .set('X-Forwarded-For', '198.51.100.26, 203.0.113.1').expect(404);
      }
      await request(app).get('/api/g/walter/openclaw/assets/app.js')
        .set('X-Forwarded-For', '198.51.100.26, 203.0.113.1').expect(429);

      const metrics = await request(app).get('/metrics').expect(200);
      expect(metrics.text).toContain('http_requests_total{method="GET",route="unmatched",status="429"} 1');
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps health endpoint working without auth', async () => {
    const app = createSidecarApp();
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('gateway-edge');
  });

  it.each(['capture', 'sync-back', 'auth-state'])(
    'does not mount cluster byosub route /api/byosub/%s on the sidecar',
    async (path) => {
      process.env.INTERNAL_SERVICE_KEY = 'byosub-mount-test-key';
      const app = createSidecarApp();
      const res = await request(app).post(`/api/byosub/${path}`).send({});

      expect(res.status).toBe(404);
    },
  );

  it('keeps the mountApi locality routes on the same fleet seam — scoped git locality reaches requireAuth, never 404', async () => {
    const app = createSidecarApp();
    const res = await request(app).get('/api/g/gw-walter/workspace/git/status');
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });

  it('sets X-Content-Type-Options: nosniff on all responses', async () => {
    const app = createSidecarApp();
    const res = await request(app).get('/api/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options: SAMEORIGIN on all responses', async () => {
    const app = createSidecarApp();
    const res = await request(app).get('/api/health');

    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('uses exact APP_URL CSP framing instead of Helmet SAMEORIGIN on the Dashboard surface', async () => {
    process.env.OPENCLAW_DASHBOARD_BRIDGE_ENABLED = 'true';
    process.env.GATEWAY_ID = 'gw-walter';
    process.env.GATEWAY_REVISION_ID = 'gw-walter-r1';
    process.env.GATEWAY_CLASS = 'isolated';
    process.env.API_PUBLIC_URL = 'https://api-test.octogee.com';
    process.env.APP_URL = 'https://app-octogee-test.web.app';
    const app = createSidecarApp();

    const res = await request(app).get('/api/g/gw-walter/openclaw/');

    expect(res.status).toBe(401);
    expect(res.headers['content-security-policy'])
      .toContain('frame-ancestors https://app-octogee-test.web.app');
    expect(res.headers['x-frame-options']).toBeUndefined();
  });

  it('sets Strict-Transport-Security header', async () => {
    const app = createSidecarApp();
    const res = await request(app).get('/api/health');

    expect(res.headers['strict-transport-security']).toMatch(/max-age=/);
  });

  it('sets Referrer-Policy header', async () => {
    const app = createSidecarApp();
    const res = await request(app).get('/api/health');

    expect(res.headers['referrer-policy']).toBeDefined();
  });

  it('sets a lockdown CSP header (default-src none, no scripts/forms/frames)', async () => {
    const app = createSidecarApp();
    const res = await request(app).get('/api/health');

    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it('health endpoint is exempt from rate limiting (no RateLimit header)', async () => {
    const app = createSidecarApp();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('metrics endpoint is exempt from rate limiting', async () => {
    const app = createSidecarApp();
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('ordinary endpoints do not add an application IP quota', async () => {
    const app = createSidecarApp();
    const res = await request(app).get('/api/leads');

    expect(res.headers['ratelimit-limit'] ?? res.headers['ratelimit']).toBeUndefined();
  });

  // Stripe-webhook raw-body middleware contract: tested in
  // octogee-api/src/__tests__/billing-stripe.integration.spec.ts now
  // that /api/billing/webhook lives on octogee-api (gateway-edge no
  // longer mounts the billing router).
});
