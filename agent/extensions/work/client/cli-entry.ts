#!/usr/bin/env bun

import { runEffectPiWorkCli } from "./effect-cli.ts";

process.exitCode = await runEffectPiWorkCli(process.argv.slice(2));
