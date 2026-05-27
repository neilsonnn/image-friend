#!/usr/bin/env node
import { readdir, rename } from "node:fs/promises";
import path from "node:path";
import {
  ensureDir,
  one,
  parseArgs,
  pathExists,
  readJson,
  slugify,
  writeJson
} from "../asset-pipeline/fal-queue.mjs";
import {
  artifactPath,
  isHiddenRequestMetadata,
  isVisibleFile,
  latestIndexed,
  parseIndexedName
} from "../asset-pipeline/request-metadata.mjs";
import { pathToFileURL } from "node:url";

const PROJECT_DIRS = ["source", "output", "output/world", "output/sfx"];
const RESERVED_OUTPUT_DIRS = new Set(["world", "sfx"]);
const MODEL_EXTENSIONS = new Set([".glb", ".obj", ".fbx", ".usdz"]);
const STAGE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp"
]);
const ANALYSIS_EXTENSION = ".json";

async function readJsonIfExists(filePath) {
  return (await pathExists(filePath)) ? readJson(filePath) : undefined;
}

function displayNameFromSlug(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function listDirFiles(dirPath) {
  if (!(await pathExists(dirPath))) return [];

  const files = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function isSourceImage(filePath) {
  return isVisibleFile(filePath) && STAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isSourceAnalysis(filePath) {
  return isVisibleFile(filePath) && path.extname(filePath).toLowerCase() === ANALYSIS_EXTENSION;
}

function isVisibleGeneratedFile(filePath) {
  const fileName = path.basename(filePath);
  return !isHiddenRequestMetadata(filePath) && isVisibleFile(filePath) && fileName !== "sfx.json";
}

function isWorldRequest(filePath) {
  const parsed = parseIndexedName(filePath);
  return parsed?.hidden && parsed.slug === "world";
}

async function nextAvailablePath(filePath) {
  if (!(await pathExists(filePath))) return filePath;

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let index = 1;

  while (true) {
    const candidate = path.join(dir, `${base}-${index}${ext}`);
    if (!(await pathExists(candidate))) return candidate;
    index += 1;
  }
}

async function stageInputFiles(worldDir, inputDir = "input") {
  if (!(await pathExists(inputDir))) return [];

  const sourceDir = path.join(worldDir, "source");
  await ensureDir(sourceDir);
  const staged = [];
  const entries = await readdir(inputDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!STAGE_EXTENSIONS.has(extension)) continue;

    const from = path.join(inputDir, entry.name);
    const parsed = parseIndexedName(entry.name);
    const stagedName = parsed?.index === 0
      ? entry.name
      : path.basename(artifactPath(sourceDir, 0, slugify(path.basename(entry.name, extension)), extension));
    const to = await nextAvailablePath(path.join(sourceDir, stagedName));
    await rename(from, to);
    staged.push({ from, to });
  }

  return staged;
}

async function scanObjects(worldDir) {
  const outputDir = path.join(worldDir, "output");
  if (!(await pathExists(outputDir))) return [];

  const entries = await readdir(outputDir, { withFileTypes: true });
  const objects = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || RESERVED_OUTPUT_DIRS.has(entry.name)) continue;

    const objectDir = path.join(outputDir, entry.name);
    const objectPath = path.join(objectDir, "object.json");
    const objectJson = await readJsonIfExists(objectPath);
    if (!objectJson) continue;

    const object = objectJson.object || objectJson;
    const objectFiles = await listDirFiles(objectDir);
    const hasModel = objectFiles.some((filePath) =>
      isVisibleFile(filePath) && MODEL_EXTENSIONS.has(path.extname(filePath).toLowerCase())
    );
    const sfxDir = path.join(objectDir, "sfx");
    const hasSfx = (await listDirFiles(sfxDir)).some(isVisibleGeneratedFile);

    objects.push({
      id: object.id || entry.name,
      name: object.name || entry.name,
      status: hasModel ? "completed" : "pending",
      working_dir: object.working_dir || objectDir,
      object_json: objectPath,
      has_sfx: hasSfx,
      updated_at: objectJson.updated_at
    });
  }

  return objects.sort((a, b) => a.id.localeCompare(b.id));
}

function objectCounts(objects) {
  const counts = { pending: 0, completed: 0 };
  for (const summary of objects) {
    const status = summary.status || "pending";
    if (counts[status] === undefined) counts[status] = 0;
    counts[status] += 1;
  }
  return counts;
}

function minimalProject({ slug, displayName, existingProject }) {
  return {
    schema_version: 1,
    slug,
    display_name: displayName || existingProject?.display_name || displayNameFromSlug(slug),
    created_at: existingProject?.created_at || new Date().toISOString(),
    notes: existingProject?.notes || undefined
  };
}

export async function ensureProjectState(options) {
  const {
    slug: rawSlug,
    description,
    displayName,
    write = true,
    stageInput = false,
    inputDir = "input"
  } = options;
  const slug = slugify(rawSlug || description || displayName || "");
  if (!slug) throw new Error("A project slug or description is required.");

  const worldDir = path.join("worlds", slug);
  for (const dir of PROJECT_DIRS) {
    await ensureDir(path.join(worldDir, dir));
  }

  const projectPath = path.join(worldDir, "project.json");
  const existingProject = await readJsonIfExists(projectPath);
  const project = minimalProject({ slug, displayName, existingProject });
  if (write) await writeJson(projectPath, project);

  const staged_files = stageInput ? await stageInputFiles(worldDir, inputDir) : [];
  const imagePath = path.join(worldDir, "image.json");
  const worldOutputPath = path.join(worldDir, "output", "world");
  const worldSfxPath = path.join(worldDir, "output", "sfx");
  const scenePath = path.join(worldDir, "scene.json");
  const objects = await scanObjects(worldDir);
  const sourceFiles = await listDirFiles(path.join(worldDir, "source"));
  const worldOutputFiles = await listDirFiles(worldOutputPath);
  const sourceImageFiles = sourceFiles.filter(isSourceImage);
  const sourceAnalysisFiles = sourceFiles.filter(isSourceAnalysis);
  const worldSfxFiles = (await listDirFiles(worldSfxPath)).filter(isVisibleGeneratedFile);
  const objectSfxCount = objects.filter((object) => object.has_sfx).length;

  return {
    schema_version: 1,
    project,
    project_json: projectPath,
    staged_files,
    objects,
    paths: {
      root: worldDir,
      source: path.join(worldDir, "source"),
      output: path.join(worldDir, "output"),
      world: path.join(worldDir, "output", "world"),
      sfx: worldSfxPath,
      scene_json: scenePath,
      image: imagePath
    },
    state: {
      has_world: Boolean(await latestIndexed(worldOutputPath, "world")),
      has_world_operation: worldOutputFiles.some(isWorldRequest) || await pathExists(path.join(worldOutputPath, "operation.json")),
      has_image: await pathExists(imagePath),
      source_image_count: sourceImageFiles.length,
      source_analysis_count: sourceAnalysisFiles.length,
      object_counts: objectCounts(objects),
      has_sfx: worldSfxFiles.length > 0 || objectSfxCount > 0,
      world_sfx_count: worldSfxFiles.length,
      object_sfx_count: objectSfxCount,
      has_scene: await pathExists(scenePath)
    }
  };
}

async function main() {
  const { flags, positionals } = parseArgs();
  const slug = one(flags, "world") || one(flags, "slug") || positionals[0];
  const description = one(flags, "description") || positionals.join(" ");
  const state = await ensureProjectState({
    slug,
    description,
    displayName: one(flags, "display-name"),
    write: one(flags, "write", "true") !== "false",
    stageInput: Boolean(flags["stage-input"]),
    inputDir: one(flags, "input-dir", "input")
  });

  console.log(JSON.stringify(state, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
