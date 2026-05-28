#!/usr/bin/env node
import { parseCliArgs, executeCliCommand } from "../lib/utils/cli.js"

const args = parseCliArgs(process.argv.slice(2))
const result = await executeCliCommand(args)

console.log(result.output)
process.exit(result.exitCode)
