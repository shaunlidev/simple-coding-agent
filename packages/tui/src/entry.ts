#!/usr/bin/env node
import { runTui } from "./index.js";

const exitCode = await runTui(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exitCode = exitCode;
