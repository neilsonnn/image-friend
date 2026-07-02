#!/usr/bin/env node
import path from "node:path";
import {
  collectRemoteFiles,
  downloadFile,
  ensureDir,
  extensionForFile,
  one,
  parseArgs,
  pathExists,
  readJson,
  safeFileName
} from "../asset-pipeline/fal-queue.mjs";
import {
  artifactPath,
  parseIndexedName
} from "../asset-pipeline/request-metadata.mjs";

const ALLOWED_ROOTS = ["worlds", "input"];

function usage() {
  return "Usage: node .claude/scripts/project/ensure-local-assets.mjs --from <world-json-or-request-json> [--force] [--dry-run]";
}

function extensionFromUrl(url, fallback) {
  try {
    return path.extname(new URL(url).pathname) || fallback;
  } catch {
    return fallback;
  }
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

function indexedJsonInfo(filePath, json) {
  const parsed = parseIndexedName(filePath);
  if (parsed) return parsed;
  if (Number.isInteger(json.index) && typeof json.kind === "string") {
    return { index: json.index, slug: json.kind, hidden: true };
  }
  return undefined;
}

function worldCandidates(json, dir, index) {
  const assets = json.response?.assets || json.assets;
  if (!assets) return [];

  const candidates = [];
  const glbUrl = assets.mesh?.collider_mesh_url;
  if (glbUrl) candidates.push({ role: "world-collider", url: glbUrl, path: path.join(dir, `${index}-world.glb`) });

  const panoUrl = assets.imagery?.pano_url;
  if (panoUrl) candidates.push({
    role: "world-pano",
    url: panoUrl,
    path: path.join(dir, `${index}-world-pano${extensionFromUrl(panoUrl, ".png")}`)
  });

  const thumbnailUrl = assets.thumbnail_url;
  if (thumbnailUrl) candidates.push({
    role: "world-thumbnail",
    url: thumbnailUrl,
    path: path.join(dir, `${index}-world-thumbnail${extensionFromUrl(thumbnailUrl, ".webp")}`)
  });

  for (const [key, url] of Object.entries(assets.splats?.spz_urls || {})) {
    if (!url) continue;
    candidates.push({
      role: `world-${key}`,
      url,
      path: path.join(dir, `${index}-world-${safeFileName(key)}.spz`)
    });
  }

  return candidates;
}

function downloadedFileCandidates(json, dir, index, slug) {
  const candidates = [];
  for (const file of json.downloaded_files || []) {
    if (!file || typeof file !== "object") continue;
    const url = file.source?.url || file.file?.url || file.url;
    if (!url || !file.path) continue;
    candidates.push({
      role: file.label || "downloaded-file",
      url,
      path: file.path
    });
  }

  if (candidates.length) return candidates;

  return collectRemoteFiles(json.result).map(({ label, file }, offset) => {
    const safeLabel = safeFileName(label || `file-${offset + 1}`);
    const outputSlug = safeLabel === "file" ? slug : `${slug}-${safeLabel}`;
    return {
      role: label,
      url: file.url,
      path: artifactPath(dir, index, outputSlug, extensionForFile(file))
    };
  });
}

async function ensureCandidate(candidate, options) {
  const { force, dryRun } = options;
  const { resolved, relative } = resolveProjectPath(candidate.path);
  const exists = await pathExists(resolved);
  if (exists && !force) {
    return { ...candidate, path: relative, action: "exists" };
  }
  if (dryRun) {
    return { ...candidate, path: relative, action: exists ? "would-overwrite" : "would-download" };
  }

  await ensureDir(path.dirname(resolved));
  await downloadFile(candidate.url, resolved);
  return { ...candidate, path: relative, action: exists ? "overwritten" : "downloaded" };
}

async function main() {
  const { flags, positionals } = parseArgs();
  const from = one(flags, "from") || positionals[0];
  const force = Boolean(flags.force);
  const dryRun = Boolean(flags["dry-run"]);
  if (!from) throw new Error(usage());

  const { resolved: fromPath, relative: fromRelative } = resolveProjectPath(from);
  if (!(await pathExists(fromPath))) throw new Error(`Metadata file does not exist: ${from}`);

  const json = await readJson(fromPath);
  const info = indexedJsonInfo(fromPath, json);
  if (!info || !Number.isInteger(info.index)) throw new Error(`Could not infer indexed asset metadata from ${from}`);

  const dir = path.dirname(fromPath);
  const candidates = [
    ...worldCandidates(json, dir, info.index),
    ...downloadedFileCandidates(json, dir, info.index, info.slug || "file")
  ];
  const deduped = [...new Map(candidates.map((candidate) => [candidate.path, candidate])).values()];
  const results = [];
  for (const candidate of deduped) {
    results.push(await ensureCandidate(candidate, { force, dryRun }));
  }

  console.log(JSON.stringify({
    source: fromRelative,
    index: info.index,
    slug: info.slug,
    force,
    dry_run: dryRun,
    count: results.length,
    results
  }, null, 2));
}

if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
