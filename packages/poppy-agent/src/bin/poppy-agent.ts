#!/usr/bin/env node
import { runCli } from '../cli/main.js';

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`poppy-agent: ${(e as Error)?.message ?? e}\n`);
    process.exitCode = 1;
  },
);
