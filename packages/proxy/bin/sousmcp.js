#!/usr/bin/env node
'use strict';
// Remove all warning listeners before requiring any modules so the
// node:sqlite experimental warning never surfaces in CLI output.
process.removeAllListeners('warning');
require('../dist/cli.js');
