#!/usr/bin/env node
import path from "node:path";
import {
  one,
  parseArgs
} from "../asset-pipeline/fal-queue.mjs";
import {
  artifactPath,
  latestIndexed,
  nextIndex,
  requestPath
} from "../asset-pipeline/request-metadata.mjs";

function usage() {
  return [
    "Usage: node .claude/scripts/project/indexed-path.mjs --dir <dir> --slug <slug> (--ext <ext> | --request) (--index N | --next | --latest) [--scope <role>]",
    "",
    "Examples:",
    "  node .claude/scripts/project/indexed-path.mjs --dir worlds/demo/output/world --slug world --ext .glb --next",
    "  node .claude/scripts/project/indexed-path.mjs --dir worlds/demo/output/chair --slug chair --request --index 0 --scope model"
  ].join("\n");
}

async function resolveIndex(dir, slug, flags) {
  const explicit = one(flags, "index");
  if (explicit !== undefined) {
    const index = Number(explicit);
    if (!Number.isInteger(index) || index < 0) throw new Error("index must be a non-negative integer.");
    return index;
  }
  if (flags.next) return nextIndex(dir, slug);
  if (flags.latest) {
    const latest = await latestIndexed(dir, slug);
    if (!latest) throw new Error(`No indexed artifact found for slug "${slug}" in ${dir}.`);
    return latest.index;
  }
  throw new Error("Choose one of: --index N, --next, or --latest.");
}

async function main() {
  const { flags } = parseArgs();
  const dir = one(flags, "dir");
  const slug = one(flags, "slug");
  const extension = one(flags, "ext");
  const isRequest = Boolean(flags.request);
  const scope = one(flags, "scope");

  if (!dir || !slug || (!extension && !isRequest)) throw new Error(usage());
  if (extension && isRequest) throw new Error("Use either --ext or --request, not both.");

  const index = await resolveIndex(dir, slug, flags);
  const outputPath = isRequest
    ? requestPath(dir, index, slug, scope)
    : artifactPath(dir, index, slug, extension.startsWith(".") ? extension : `.${extension}`);

  console.log(JSON.stringify({
    dir,
    slug,
    index,
    path: path.normalize(outputPath),
    request: isRequest,
    ...(scope ? { scope } : {}),
    ...(extension ? { extension: extension.startsWith(".") ? extension : `.${extension}` } : {})
  }, null, 2));
}

if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
