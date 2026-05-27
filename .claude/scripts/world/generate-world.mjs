#!/usr/bin/env node
import { copyFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  downloadFile,
  ensureDir,
  inferMime,
  isUrl,
  many,
  one,
  parseArgs,
  pathExists,
  readJson,
  requireEnv,
  stripBase64,
  writeJson
} from "../asset-pipeline/fal-queue.mjs";
import {
  artifactPath,
  isVisibleFile,
  nextIndex,
  parseIndexedName,
  requestPath
} from "../asset-pipeline/request-metadata.mjs";
import { pathToFileURL } from "node:url";

const ENDPOINT = "https://api.worldlabs.ai/marble/v1";
const MODEL = "marble-1.1";
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".webp"]);

async function downloadAsset(url, destPath) {
  if (await pathExists(destPath)) return destPath;
  return downloadFile(url, destPath);
}

async function copyWorldPlate(image, outputDir, index) {
  if (!image || isUrl(image)) return undefined;
  const ext = path.extname(image).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return undefined;

  const sourcePath = path.resolve(image);
  if (!(await pathExists(sourcePath))) return undefined;

  const destPath = artifactPath(outputDir, index, "world-plate", ext);
  if (!(await pathExists(destPath))) await copyFile(sourcePath, destPath);
  return destPath;
}

function extensionFromUrl(url, fallback) {
  try {
    return path.extname(new URL(url).pathname) || fallback;
  } catch {
    return fallback;
  }
}

function assetKeyForFilename(key) {
  return String(key).replace(/[^a-z0-9_-]/gi, "_");
}

async function downloadWorldAssets(worldResponse, outputDir, index) {
  const assets = worldResponse.assets || {};
  const result = { spz: {} };

  const glbUrl = assets.mesh?.collider_mesh_url;
  if (glbUrl) {
    result.glb = await downloadAsset(glbUrl, path.join(outputDir, `${index}-world.glb`));
  }

  const panoUrl = assets.imagery?.pano_url;
  if (panoUrl) {
    const ext = extensionFromUrl(panoUrl, ".png");
    result.pano = await downloadAsset(panoUrl, path.join(outputDir, `${index}-world-pano${ext}`));
  }

  const thumbnailUrl = assets.thumbnail_url;
  if (thumbnailUrl) {
    const ext = extensionFromUrl(thumbnailUrl, ".webp");
    result.thumbnail = await downloadAsset(thumbnailUrl, path.join(outputDir, `${index}-world-thumbnail${ext}`));
  }

  const spzUrls = assets.splats?.spz_urls || {};
  for (const [key, url] of Object.entries(spzUrls)) {
    if (!url) continue;
    result.spz[key] = await downloadAsset(url, path.join(outputDir, `${index}-world-${assetKeyForFilename(key)}.spz`));
  }

  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonIfExists(filePath) {
  return (await pathExists(filePath)) ? readJson(filePath) : undefined;
}

async function latestSourceImage(sourceDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  const images = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(sourceDir, entry.name))
    .filter((filePath) => isVisibleFile(filePath) && IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .map((filePath) => parseIndexedName(filePath) || { index: 0, path: filePath, slug: path.basename(filePath) });

  return images.sort((a, b) => b.index - a.index || a.slug.localeCompare(b.slug))[0]?.path;
}

async function promptFromImageJson(world) {
  const imageJson = await readJsonIfExists(`worlds/${world}/image.json`);
  if (!imageJson) return undefined;

  return [
    imageJson.scene_name,
    imageJson.literal_description,
    imageJson.environment,
    imageJson.visual_style,
    imageJson.lighting,
    imageJson.atmosphere
  ]
    .filter(Boolean)
    .join("\n");
}

async function imagePrompt(image, textPrompt) {
  if (isUrl(image)) {
    return {
      type: "image",
      image_prompt: {
        source: "uri",
        uri: image
      },
      ...(textPrompt ? { text_prompt: textPrompt } : {})
    };
  }

  const data = await readFile(image);
  const extension = path.extname(image).replace(/^\./, "") || "png";
  return {
    type: "image",
    image_prompt: {
      source: "data_base64",
      data_base64: data.toString("base64"),
      extension,
      mime_type: inferMime(image)
    },
    ...(textPrompt ? { text_prompt: textPrompt } : {})
  };
}

async function buildRequest({ world, image, prompt }) {
  const textPrompt = prompt || await promptFromImageJson(world);
  if (image) {
    return {
      display_name: world,
      model: MODEL,
      world_prompt: await imagePrompt(image, textPrompt)
    };
  }

  if (!textPrompt) {
    throw new Error("World generation requires a source image, prompt, or worlds/<world>/image.json.");
  }

  return {
    display_name: world,
    model: MODEL,
    world_prompt: {
      type: "text",
      text_prompt: textPrompt
    }
  };
}

async function submitWorld(request) {
  const apiKey = await requireEnv("WORLD_LABS_API_KEY");
  const response = await fetch(`${ENDPOINT}/worlds:generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "WLT-Api-Key": apiKey
    },
    body: JSON.stringify(request)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`World Labs submit failed (${response.status}).`);
  }

  return body;
}

function operationId(operation) {
  const id = operation?.operation_id || operation?.id || operation?.name;
  if (!id) throw new Error("World Labs operation did not include operation_id.");
  return String(id).split("/").at(-1);
}

function requestStatus(operation) {
  if (operation?.error) return "failed";
  return operation?.done ? "completed" : "running";
}

async function writeWorldRequest(metadataPath, metadata) {
  await writeJson(metadataPath, {
    schema_version: 1,
    kind: "world",
    provider: "world-labs",
    endpoint: ENDPOINT,
    model: MODEL,
    ...metadata,
    result: stripBase64(metadata.result)
  });
}

async function worldRequests(outputDir) {
  const entries = await readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const requests = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseIndexedName(entry.name);
    if (!parsed?.hidden || parsed.slug !== "world") continue;
    const request = await readJsonIfExists(path.join(outputDir, entry.name));
    if (!request) continue;
    requests.push({ index: parsed.index, path: path.join(outputDir, entry.name), data: request });
  }
  return requests.sort((a, b) => b.index - a.index);
}

function isActiveRequest(request) {
  return request?.data?.request_id && !["completed", "failed", "cancelled", "canceled"].includes(request.data.status);
}

async function latestWorldArtifact(outputDir) {
  const entries = await readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const worlds = entries
    .filter((entry) => entry.isFile())
    .map((entry) => parseIndexedName(entry.name))
    .filter((entry) => entry?.slug === "world" && entry.extension === ".json");
  return worlds.sort((a, b) => b.index - a.index || b.name.localeCompare(a.name))[0];
}

async function nextWorldIndex(outputDir) {
  return nextIndex(outputDir, "world");
}

async function pollOperation(operation, metadataPath, baseMetadata, pollIntervalMs) {
  const apiKey = await requireEnv("WORLD_LABS_API_KEY");
  let current = operation;
  const id = operationId(current);

  while (!current.done) {
    await sleep(pollIntervalMs);
    const response = await fetch(`${ENDPOINT}/operations/${id}`, {
      headers: {
        "WLT-Api-Key": apiKey
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`World Labs poll failed (${response.status}).`);
    }
    current = body;
    await writeWorldRequest(metadataPath, {
      ...baseMetadata,
      status: requestStatus(current),
      result: current
    });
  }

  return current;
}

export async function generateWorld(options) {
  const {
    world,
    image,
    prompt,
    regenerate = false,
    pollIntervalMs = 15000
  } = options;

  if (!world) throw new Error("world is required.");

  const outputDir = `worlds/${world}/output/world`;
  await ensureDir(outputDir);

  const existingWorld = regenerate ? undefined : await latestWorldArtifact(outputDir);
  if (existingWorld) {
    return {
      world,
      index: existingWorld.index,
      skipped: true,
      skip_reason: `${existingWorld.name} already exists. Pass --regenerate to create a new world.`,
      world_json: existingWorld.path
    };
  }

  const activeRequest = regenerate ? undefined : (await worldRequests(outputDir)).find(isActiveRequest);
  const requestIndex = activeRequest?.index ?? await nextWorldIndex(outputDir);
  const metadataPath = activeRequest?.path ?? requestPath(outputDir, requestIndex, "world");
  const worldPath = artifactPath(outputDir, requestIndex, "world", ".json");
  const request = activeRequest?.data?.request || await buildRequest({ world, image, prompt });
  const submittedAt = activeRequest?.data?.submitted_at || new Date().toISOString();
  const inputFiles = image ? [image] : [];
  const textPrompt = prompt || request.world_prompt?.text_prompt || request.world_prompt?.image_prompt?.text_prompt;
  const baseMetadata = {
    index: requestIndex,
    status: "submitted",
    request_id: activeRequest?.data?.request_id,
    submitted_at: submittedAt,
    prompt: textPrompt,
    input_files: inputFiles,
    output_files: [],
    downloaded_files: [],
    request: stripBase64(request)
  };
  const operation = activeRequest?.data?.result || await submitWorld(request);
  const requestId = operationId(operation);

  await writeWorldRequest(metadataPath, {
    ...baseMetadata,
    request_id: requestId,
    status: requestStatus(operation),
    result: operation
  });

  const completed = await pollOperation(operation, metadataPath, {
    ...baseMetadata,
    request_id: requestId
  }, Number(pollIntervalMs));

  if (completed.error) {
    await writeWorldRequest(metadataPath, {
      ...baseMetadata,
      request_id: requestId,
      status: "failed",
      completed_at: new Date().toISOString(),
      result: completed,
      error: completed.error
    });
    const message = typeof completed.error === "string" ? `: ${completed.error}` : "";
    throw new Error(`World Labs generation failed${message}.`);
  }
  if (!completed.response) {
    throw new Error("World Labs operation completed without response.");
  }

  await writeJson(worldPath, completed.response);

  const plate = await copyWorldPlate(image, outputDir, requestIndex);
  const downloaded = await downloadWorldAssets(completed.response, outputDir, requestIndex);
  const downloadedFiles = [
    plate,
    downloaded.glb,
    downloaded.pano,
    downloaded.thumbnail,
    ...Object.values(downloaded.spz)
  ].filter(Boolean);
  await writeWorldRequest(metadataPath, {
    ...baseMetadata,
    request_id: requestId,
    status: "completed",
    completed_at: new Date().toISOString(),
    output_files: [worldPath],
    downloaded_files: downloadedFiles,
    result: completed
  });

  return {
    world,
    index: requestIndex,
    operation_id: operationId(completed),
    request_metadata: metadataPath,
    world_json: worldPath,
    ...(plate ? { plate } : {}),
    ...downloaded,
    route: `/${world}`
  };
}

async function main() {
  const { flags } = parseArgs();
  const world = one(flags, "world");
  if (!world) {
    throw new Error("Usage: node generate-world.mjs --world <world-name> [--image <path-or-url>] [--prompt <text>] [--regenerate]");
  }

  const prompt = [...many(flags, "prompt"), ...many(flags, "description")].join("\n").trim() || undefined;
  const explicitImage = one(flags, "image");
  const image = explicitImage || await latestSourceImage(`worlds/${world}/source`);

  const result = await generateWorld({
    world,
    image,
    prompt,
    regenerate: Boolean(flags.regenerate),
    pollIntervalMs: one(flags, "poll-interval-ms", 15000)
  });

  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
