#!/usr/bin/env node
import { runTaskCli } from "./task-cli.js";

const exitCode = await runTaskCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exitCode = exitCode;
