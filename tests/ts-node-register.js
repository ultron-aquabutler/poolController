'use strict';

// Minimal ts-node loader so `node --test --require ./tests/ts-node-register.js tests/...`
// runs TypeScript files without a separate build step.
//
// Why: node:test is built into Node 20+, but it doesn't speak TypeScript on its
// own. ts-node is already in devDependencies, so we just register it here and
// node:test picks up .ts files via the require hook.
//
// Pitfall: ts-node's transpile-only mode is the fastest path — full type-check
// would re-run tsc every test run. The repo's `npm run build` script handles
// type-checking separately.

require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'commonjs', target: 'es2019' },
});