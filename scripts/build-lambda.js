// Bundles src/lambda.ts into a single CommonJS file for the Lambda nodejs22.x runtime.
// The AWS SDK v3 is provided by the runtime, so it is left external.
const { build } = require('esbuild');
const { version } = require('../package.json');

build({
  entryPoints: ['src/lambda.ts'],
  outfile: 'dist/lambda/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: true,
  external: ['@aws-sdk/*'],
  define: { 'process.env.BRING_MCP_VERSION': JSON.stringify(version) },
  logLevel: 'info',
}).catch(() => process.exit(1));
