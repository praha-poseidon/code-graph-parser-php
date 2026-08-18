#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PhpCodeGraphParser } from "./parser.js";
import type { ParseRequest } from "./model.js";

interface CliArgs {
  project?: string;
  projectName?: string;
  request?: string;
  out?: string;
  stdio?: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const request = await createRequest(args);
  const delta = new PhpCodeGraphParser().parse(request);
  const output = `${JSON.stringify(delta, null, 2)}\n`;
  if (args.out) fs.writeFileSync(path.resolve(args.out), output, "utf8");
  else process.stdout.write(output);
  process.stderr.write(
    `Parsed ${delta.scope.sourceFiles.length} PHP files, ${delta.units.length} units, ` +
    `${delta.functions.length} functions, ${delta.relationships.length} relationships.\n`
  );
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "--project" || arg === "-p") && next) {
      result.project = next;
      index += 1;
    } else if (arg === "--project-name" && next) {
      result.projectName = next;
      index += 1;
    } else if ((arg === "--request" || arg === "-r") && next) {
      result.request = next;
      index += 1;
    } else if ((arg === "--out" || arg === "-o") && next) {
      result.out = next;
      index += 1;
    } else if (arg === "--stdio") {
      result.stdio = true;
    }
  }
  return result;
}

async function createRequest(args: CliArgs): Promise<ParseRequest> {
  if (args.request) {
    return JSON.parse(fs.readFileSync(path.resolve(args.request), "utf8")) as ParseRequest;
  }
  if (args.stdio) {
    return JSON.parse(await readStdin()) as ParseRequest;
  }
  if (!args.project) {
    throw new Error("Use --project <directory>, --request <json>, or --stdio");
  }
  const projectRoot = path.resolve(args.project);
  return {
    projectName: args.projectName ?? path.basename(projectRoot),
    language: "php",
    projectRoot,
    sourceFiles: [],
    changeType: "SOURCE_MODIFIED"
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

