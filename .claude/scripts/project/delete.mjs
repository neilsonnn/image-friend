#!/usr/bin/env node
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  one,
  parseArgs,
  pathExists
} from "../asset-pipeline/fal-queue.mjs";
import { pathToFileURL } from "node:url";

const ALLOWED_ROOTS = ["worlds", "input"];

function usage() {
  return "Usage: node .claude/scripts/project/delete.mjs --path <path> [--yes] [--recursive]";
}

function resolveProjectPath(value) {
  const resolved = path.resolve(value);
  const cwd = process.cwd();
  const insideRepo = resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`);
  if (!insideRepo) throw new Error(`Path must stay inside this repository: ${value}`);

  const relative = path.relative(cwd, resolved);
  const top = relative.split(path.sep)[0];
  if (!ALLOWED_ROOTS.includes(top)) {
    throw new Error(`Path must be under one of: ${ALLOWED_ROOTS.join(", ")}.`);
  }
  return { resolved, relative };
}

async function main() {
  const { flags, positionals } = parseArgs();
  const target = one(flags, "path") || positionals[0];
  const confirmed = Boolean(flags.yes);
  const recursive = Boolean(flags.recursive);
  if (!target) throw new Error(usage());

  const { resolved, relative } = resolveProjectPath(target);
  const exists = await pathExists(resolved);
  if (!exists) {
    console.log(JSON.stringify({ action: "skip", reason: "missing", path: relative }, null, 2));
    return;
  }

  if (!confirmed) {
    console.log(JSON.stringify({
      action: "dry-run",
      path: relative,
      recursive,
      next: `node .claude/scripts/project/delete.mjs --path ${JSON.stringify(relative)} --yes${recursive ? " --recursive" : ""}`
    }, null, 2));
    return;
  }

  await rm(resolved, { recursive, force: false });
  console.log(JSON.stringify({ action: "deleted", path: relative, recursive }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
