#!/usr/bin/env bun

import { runPiWorkCli } from "./cli.ts";

process.exitCode = await runPiWorkCli(process.argv.slice(2));
