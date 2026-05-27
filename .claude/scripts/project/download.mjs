#!/usr/bin/env node
import path from "node:path";
import {
  downloadFile,
  ensureDir,
  one,
  parseArgs,
  pathExists
} from "../asset-pipeline/fal-queue.mjs";
import { pathToFileURL } from "node:url";

const ALLOWED_ROOTS = ["worlds", "input"];

function usage() {
  return "Usage: node .claude/scripts/project/download.mjs --url <url-or-data-uri> --out <path> [--force] [--dry-run]";
}

function resolveProjectPath(value) {
  const resolved = path.resolve(value);
  const cwd = process.cwd();
  const insideRepo = resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`);
  if (!insideRepo) throw new Error(`Output path must stay inside this repository: ${value}`);

  const relative = path.relative(cwd, resolved);
  const top = relative.split(path.sep)[0];
  if (!ALLOWED_ROOTS.includes(top)) {
    throw new Error(`Output path must be under one of: ${ALLOWED_ROOTS.join(", ")}.`);
  }
  return { resolved, relative };
}

async function main() {
  const { flags } = parseArgs();
  const url = one(flags, "url");
  const out = one(flags, "out") || one(flags, "output");
  const force = Boolean(flags.force);
  const dryRun = Boolean(flags["dry-run"]);

  if (!url || !out) throw new Error(usage());

  const { resolved, relative } = resolveProjectPath(out);
  const exists = await pathExists(resolved);
  if (exists && !force) {
    console.log(JSON.stringify({
      action: "skip",
      reason: "exists",
      path: relative,
      force: false
    }, null, 2));
    return;
  }

  if (dryRun) {
    console.log(JSON.stringify({
      action: exists ? "would-overwrite" : "would-download",
      url,
      path: relative,
      force
    }, null, 2));
    return;
  }

  await ensureDir(path.dirname(resolved));
  await downloadFile(url, resolved);
  console.log(JSON.stringify({
    action: exists ? "overwritten" : "downloaded",
    url,
    path: relative,
    force
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
