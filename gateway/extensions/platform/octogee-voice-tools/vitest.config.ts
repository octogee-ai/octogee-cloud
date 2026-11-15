import { fileURLToPath } from 'node:url';
export default {
  resolve: { alias: { '@octogee/core': fileURLToPath(new URL('../../../../core/src', import.meta.url)) } },
  test: { include: ['__tests__/**/*.spec.ts'] },
};
