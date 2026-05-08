'use strict';
// Only print the getting-started message on global installs.
// npm sets npm_config_global=true; yarn/pnpm set BERRY_BIN_LINKS or similar.
const isGlobal = process.env.npm_config_global === 'true'
  || process.env.npm_config_global === '1';
if (isGlobal) {
  process.stdout.write(
    '\n  Run \x1b[36msousmcp install\x1b[0m to get started.\n\n'
  );
}
