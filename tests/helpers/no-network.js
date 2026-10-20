'use strict';
// Preload for tests: any network use throws.
const boom = (name) => () => { throw new Error(`network use: ${name}`); };
for (const mod of ['net', 'http', 'https', 'dns', 'tls']) {
  const m = require(`node:${mod}`);
  for (const k of Object.keys(m)) if (typeof m[k] === 'function' && /^(connect|createConnection|request|get|lookup|resolve)/.test(k)) m[k] = boom(`${mod}.${k}`);
}
globalThis.fetch = boom('fetch');
