#!/usr/bin/env node
import { readdir, rename } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_HUNYUAN_ENABLE_PBR,
  DEFAULT_HUNYUAN_FACE_COUNT,
  DEFAULT_HUNYUAN_GENERATE_TYPE,
  DEFAULT_HUNYUAN_POLYGON_TYPE,
  HUNYUAN_3D_PROVIDER,
  runHunyuan3D
} from "./hunyuan-3d.mjs";
import {
  DEFAULT_MESHY_ANIMATION_ACTION_ID,
  DEFAULT_MESHY_ENABLE_ANIMATION,
  DEFAULT_MESHY_ENABLE_PBR,
  DEFAULT_MESHY_ENABLE_RIGGING,
  DEFAULT_MESHY_ENABLE_SAFETY_CHECKER,
  DEFAULT_MESHY_RIGGING_HEIGHT_METERS,
  DEFAULT_MESHY_SHOULD_REMESH,
  DEFAULT_MESHY_SHOULD_TEXTURE,
  DEFAULT_MESHY_SYMMETRY_MODE,
  DEFAULT_MESHY_TARGET_POLYCOUNT,
  DEFAULT_MESHY_TOPOLOGY,
  MESHY_3D_PROVIDER,
  runMeshy3D
} from "./meshy-3d.mjs";
import { runImageEdit } from "./image-edit.mjs";
import {
  downloadRemoteFiles,
  ensureDir,
  getFalQueueResult,
  one,
  parseArgs,
  pathExists,
  pollFalQueue,
  readJson,
  safeFileName,
  sanitizeForMetadata,
  slugify,
  writeJson
} from "./fal-queue.mjs";
import {
  artifactPath,
  buildRequestSummary,
  nextIndex,
  parseIndexedName,
  requestPath
} from "./request-metadata.mjs";
import { pathToFileURL } from "node:url";

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const MODEL_EXTENSIONS = new Set([".blend", ".fbx", ".glb", ".obj", ".stl", ".usdz"]);
const GENERATED_OBJECT_FIELDS = new Set(["status"]);
export const DEFAULT_3D_PROVIDER = HUNYUAN_3D_PROVIDER;
const MODEL_PROVIDER_ALIASES = new Map([
  ["meshy", MESHY_3D_PROVIDER],
  ["fal-ai/meshy/v6/image-to-3d", MESHY_3D_PROVIDER],
  ["hunyuan", HUNYUAN_3D_PROVIDER],
  ["hunyuan-3d", HUNYUAN_3D_PROVIDER],
  ["hunyuan3d-v3", HUNYUAN_3D_PROVIDER],
  ["fal-ai/hunyuan3d-v3/image-to-3d", HUNYUAN_3D_PROVIDER],
  ["fal-ai/hunyuan-3d/v3.1/pro/image-to-3d", HUNYUAN_3D_PROVIDER]
]);

async function readJsonIfExists(filePath) {
  return (await pathExists(filePath)) ? readJson(filePath) : undefined;
}

async function directoryFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name));
}

function cleanObject(object, workingDir) {
  const cleaned = { ...object, working_dir: object.working_dir || workingDir };
  for (const field of GENERATED_OBJECT_FIELDS) delete cleaned[field];
  return cleaned;
}

function collectSourceImages(object, directImage) {
  const images = new Set();

  if (directImage) images.add(directImage);

  for (const image of object.source_images || []) {
    images.add(image);
  }

  for (const evidence of object.evidence || []) {
    if (evidence.image) images.add(evidence.image);
  }

  return [...images];
}

function firstGeneratedImage(imageEditSummary) {
  return (imageEditSummary.downloaded_files || []).find((downloaded) => {
    const contentType = downloaded.source?.content_type || "";
    return contentType.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(downloaded.path);
  });
}

function buildDirectObject({ objectId, objectName, description, image, world }) {
  const name = objectName || objectId || path.basename(image, path.extname(image));
  const id = objectId || slugify(name);
  return {
    id,
    name,
    description: description || name,
    source_images: image ? [image] : [],
    evidence: image ? [{ image, notes: "Direct single-image object input" }] : [],
    generate_as_3d_object: true,
    working_dir: `worlds/${world}/output/${id}`
  };
}

function resolve3DProvider(value = DEFAULT_3D_PROVIDER) {
  const normalized = String(value || DEFAULT_3D_PROVIDER).trim().toLowerCase();
  const provider = MODEL_PROVIDER_ALIASES.get(normalized);
  if (!provider) {
    throw new Error(`Unsupported 3D provider "${value}". Use one of: meshy, hunyuan.`);
  }
  return provider;
}

function modelRequestPrefix(request, fallbackProvider) {
  if (request?.data?.provider_slug) return request.data.provider_slug;
  if (request?.data?.endpoint?.includes("hunyuan")) return HUNYUAN_3D_PROVIDER;
  if (request?.data?.endpoint?.includes("meshy")) return MESHY_3D_PROVIDER;
  return fallbackProvider || DEFAULT_3D_PROVIDER;
}

async function run3DProvider(options) {
  const { provider } = options;
  if (provider === HUNYUAN_3D_PROVIDER) {
    return runHunyuan3D(options);
  }
  if (provider === MESHY_3D_PROVIDER) {
    return runMeshy3D(options);
  }
  throw new Error(`Unsupported 3D provider "${provider}".`);
}

function nowIso() {
  return new Date().toISOString();
}

function statusText(value) {
  return String(value || "").toLowerCase();
}

function isCompletedRequest(request) {
  return ["completed", "succeeded", "success"].includes(statusText(request.data?.status));
}

function isFailedRequest(request) {
  const status = statusText(request.data?.status);
  return Boolean(request.data?.error) || ["failed", "error", "cancelled", "canceled"].includes(status);
}

function isUsableRequest(request) {
  return Boolean(request.data?.request_id && request.data?.endpoint) && !isFailedRequest(request);
}

function isActiveRequest(request) {
  return isUsableRequest(request) && !isCompletedRequest(request);
}

function latestByIndex(entries) {
  return entries
    .filter((entry) => Number.isInteger(entry.index))
    .sort((a, b) => b.index - a.index)
    .at(0);
}

async function latestArtifact(dirPath, slug, extensions) {
  const files = await directoryFiles(dirPath);
  const artifacts = files
    .map((filePath) => {
      const parsed = parseIndexedName(filePath);
      return parsed && !parsed.hidden && parsed.slug === slug && extensions.has(parsed.extension.toLowerCase())
        ? { ...parsed, path: filePath }
        : undefined;
    })
    .filter(Boolean);
  return latestByIndex(artifacts);
}

async function requestMetadataFiles(dirPath, slug, scope) {
  const files = await directoryFiles(dirPath);
  const requests = [];

  for (const filePath of files) {
    const parsed = parseIndexedName(filePath);
    if (!parsed?.hidden || parsed.slug !== slug || parsed.scope !== scope) continue;
    const data = await readJsonIfExists(filePath);
    if (!data) continue;
    requests.push({
      ...parsed,
      path: filePath,
      data
    });
  }

  return requests;
}

async function resolveObject(options) {
  const { world, objectId, directImage, objectName, description } = options;
  const directObject = directImage
    ? buildDirectObject({ objectId, objectName, description, image: directImage, world })
    : undefined;
  const resolvedId = objectId || directObject?.id;

  if (!resolvedId) {
    throw new Error("objectId or directImage is required.");
  }

  const objectDir = `worlds/${world}/output/${resolvedId}`;
  const objectJsonPath = path.join(objectDir, "object.json");
  const existing = await readJsonIfExists(objectJsonPath);

  if (existing?.object) {
    return {
      object: {
        ...cleanObject(existing.object, objectDir),
        ...(directImage
          ? {
              source_images: [...new Set([...(existing.object.source_images || []), directImage])],
              evidence: [
                ...(existing.object.evidence || []),
                { image: directImage, notes: "Direct single-image object input" }
              ]
            }
          : {})
      },
      objectDir,
      objectJsonPath
    };
  }

  if (directObject) {
    return {
      object: cleanObject(directObject, objectDir),
      objectDir,
      objectJsonPath
    };
  }

  throw new Error(`Object file not found: ${objectJsonPath}`);
}

async function writeObjectIntent(objectJsonPath, world, object) {
  const state = {
    schema_version: 1,
    world,
    object,
    updated_at: nowIso()
  };
  await writeJson(objectJsonPath, state);
  return state;
}

async function normalizeReferenceImage(downloadedImage, objectDir, objectId, requestIndex) {
  const extension = path.extname(downloadedImage.path) || ".png";
  const numberedPath = artifactPath(objectDir, requestIndex, objectId, extension);
  if (downloadedImage.path !== numberedPath) {
    await rename(downloadedImage.path, numberedPath);
  }
  return {
    ...downloadedImage,
    path: numberedPath
  };
}

async function normalizeModelFiles(downloadedFiles, objectDir, objectId, requestIndex) {
  const safeSlug = safeFileName(objectId);
  const seen = new Set();
  let primaryModelUsed = false;

  const normalized = [];
  for (let index = 0; index < downloadedFiles.length; index += 1) {
    const downloaded = downloadedFiles[index];
    const extension = path.extname(downloaded.path) || ".bin";
    const label = safeFileName(downloaded.label || `file-${index + 1}`);
    const usePrimaryName = MODEL_EXTENSIONS.has(extension.toLowerCase()) && !primaryModelUsed;
    if (usePrimaryName) primaryModelUsed = true;
    const baseName =
      usePrimaryName
        ? `${requestIndex}-${safeSlug}${extension}`
        : `${requestIndex}-${safeSlug}-${label}${extension}`;
    const dedupedName = seen.has(baseName)
      ? `${requestIndex}-${safeSlug}-${label}-${index + 1}${extension}`
      : baseName;
    seen.add(dedupedName);

    const outputPath = path.join(objectDir, dedupedName);
    if (downloaded.path !== outputPath) {
      await rename(downloaded.path, outputPath);
    }
    normalized.push({
      ...downloaded,
      path: outputPath
    });
  }

  return normalized;
}

async function resumeFalRequest(request, prefix, outputDir, pollIntervalMs = 5000) {
  const status = await pollFalQueue(request.data.endpoint, request.data.request_id, {
    statusUrl: request.data.status_url,
    metadataPath: request.path,
    pollIntervalMs
  });
  const result = await getFalQueueResult(request.data.endpoint, request.data.request_id, {
    responseUrl: request.data.response_url,
    metadataPath: request.path
  });
  const downloaded = await downloadRemoteFiles(result.data, outputDir, prefix);
  const completedAt = nowIso();
  const summary = buildRequestSummary({
    kind: request.data.kind,
    provider: request.data.provider || request.data.endpoint,
    endpoint: request.data.endpoint,
    metadata: {
      index: request.data.index ?? request.index,
      role: request.data.role,
      sfx_kind: request.data.sfx_kind,
      ...(request.data.kind === "3d"
        ? { provider_slug: request.data.provider_slug || prefix }
        : {})
    },
    requestId: request.data.request_id,
    submittedAt: request.data.submitted_at,
    completedAt,
    prompt: request.data.prompt,
    inputFiles: request.data.input_files || [],
    outputFiles: downloaded.map((file) => file.path),
    downloadedFiles: downloaded,
    result: result.data,
    extra: { queue_status: status.status }
  });

  await writeJson(request.path, summary);
  return summary;
}

export async function generateSingleObject(options) {
  const {
    world,
    objectId,
    directImage,
    objectName,
    description,
    imageEditPrompt,
    regenerate = false,
    imageEditProvider,
    modelProvider,
    hunyuanFaceCount = DEFAULT_HUNYUAN_FACE_COUNT,
    hunyuanEnablePbr = DEFAULT_HUNYUAN_ENABLE_PBR,
    hunyuanGenerateType = DEFAULT_HUNYUAN_GENERATE_TYPE,
    hunyuanPolygonType = DEFAULT_HUNYUAN_POLYGON_TYPE,
    meshyTopology = DEFAULT_MESHY_TOPOLOGY,
    meshyTargetPolycount = DEFAULT_MESHY_TARGET_POLYCOUNT,
    meshySymmetryMode = DEFAULT_MESHY_SYMMETRY_MODE,
    meshyShouldRemesh = DEFAULT_MESHY_SHOULD_REMESH,
    meshyShouldTexture = DEFAULT_MESHY_SHOULD_TEXTURE,
    meshyRiggingHeightMeters = DEFAULT_MESHY_RIGGING_HEIGHT_METERS,
    meshyAnimationActionId = DEFAULT_MESHY_ANIMATION_ACTION_ID,
    meshyEnableSafetyChecker = DEFAULT_MESHY_ENABLE_SAFETY_CHECKER,
    meshyEnableAnimation = DEFAULT_MESHY_ENABLE_ANIMATION,
    meshyEnableRigging = DEFAULT_MESHY_ENABLE_RIGGING,
    meshyEnablePbr = DEFAULT_MESHY_ENABLE_PBR,
    referenceOnly = false,
    regenerateReference = false
  } = options;

  if (!world) throw new Error("world is required.");
  if (!objectId && !directImage) throw new Error("objectId or directImage is required.");

  const resolved = await resolveObject({
    world,
    objectId,
    directImage,
    objectName,
    description
  });

  const object = cleanObject(resolved.object, resolved.objectDir);
  const provider = resolve3DProvider(modelProvider || object.model_provider || DEFAULT_3D_PROVIDER);
  const regenerateModel = regenerate || regenerateReference;
  await ensureDir(resolved.objectDir);
  await writeObjectIntent(resolved.objectJsonPath, world, object);

  const sourceImages = collectSourceImages(object, directImage);
  if (sourceImages.length === 0) {
    throw new Error(`Object ${object.id} does not have source images for image editing.`);
  }

  const imageRequests = regenerateReference ? [] : await requestMetadataFiles(resolved.objectDir, object.id, "image");
  const modelRequests = regenerateModel ? [] : await requestMetadataFiles(resolved.objectDir, object.id, "model");
  const activeImageRequest = latestByIndex(imageRequests.filter(isActiveRequest));
  const usableImageRequest = latestByIndex(imageRequests.filter(isUsableRequest));
  const activeModelRequest = latestByIndex(modelRequests.filter(isActiveRequest));
  const usableModelRequest = latestByIndex(modelRequests.filter(isUsableRequest));
  const existingImage = regenerateReference ? undefined : await latestArtifact(resolved.objectDir, object.id, IMAGE_EXTENSIONS);
  const existingModel = regenerateModel ? undefined : await latestArtifact(resolved.objectDir, object.id, MODEL_EXTENSIONS);

  if (existingModel && !activeModelRequest && !regenerateModel) {
    return {
      schema_version: 1,
      world,
      object,
      object_json: resolved.objectJsonPath,
      output_dir: resolved.objectDir,
      skipped: true,
      skip_reason: "Model artifact already exists. Pass --regenerate to create a new generation.",
      model: existingModel.path
    };
  }

  const requestIndex =
    activeModelRequest?.index ??
    (existingImage ? undefined : activeImageRequest?.index) ??
    (regenerateModel ? undefined : existingImage?.index) ??
    usableModelRequest?.index ??
    (existingImage ? undefined : usableImageRequest?.index) ??
    await nextIndex(resolved.objectDir, object.id);

  let generatedImagePath = existingImage?.path;
  let imageMetadataPath;
  let modelMetadataPath;
  let modelFiles = existingModel ? [existingModel.path] : [];

  try {
    if (!generatedImagePath) {
      const imageRequest =
        activeImageRequest && activeImageRequest.index === requestIndex
          ? activeImageRequest
          : usableImageRequest && usableImageRequest.index === requestIndex
            ? usableImageRequest
            : undefined;
      imageMetadataPath = imageRequest?.path || requestPath(resolved.objectDir, requestIndex, object.id, "image");
      if (!imageRequest && !imageEditPrompt) {
        throw new Error(
          `Image edit prompt is required to create a reference image for ${object.id}. Pass --image-edit-prompt "<prompt>".`
        );
      }
      const imageEdit = imageRequest
        ? await resumeFalRequest(imageRequest, "image-edit", resolved.objectDir)
        : await runImageEdit({
            provider: imageEditProvider || object.image_edit_provider,
            prompt: imageEditPrompt,
            images: sourceImages,
            outputDir: resolved.objectDir,
            metadataPath: imageMetadataPath,
            metadata: { index: requestIndex },
            numImages: 1,
            resolution: "1K",
            aspectRatio: "1:1",
            outputFormat: "png",
            limitGenerations: true
          });

      const rawGeneratedImage = firstGeneratedImage(imageEdit);
      if (!rawGeneratedImage) {
        throw new Error(`Image edit did not return a downloadable image for ${object.id}.`);
      }

      const generatedImage = await normalizeReferenceImage(
        rawGeneratedImage,
        resolved.objectDir,
        object.id,
        requestIndex
      );
      generatedImagePath = generatedImage.path;
      const imageEditMetadata = (await readJsonIfExists(imageMetadataPath)) || imageEdit;
      await writeJson(imageMetadataPath, {
        ...imageEditMetadata,
        kind: "2d",
        index: requestIndex,
        output_files: [generatedImage.path],
        downloaded_files: (imageEdit.downloaded_files || []).map((file) =>
          file.path === rawGeneratedImage.path ? { ...file, path: generatedImage.path } : file
        ),
        updated_at: nowIso()
      });
    }

    if (referenceOnly) {
      return {
        schema_version: 1,
        world,
        object,
        object_json: resolved.objectJsonPath,
        output_dir: resolved.objectDir,
        reference_only: true,
        reference_image: generatedImagePath,
        request_metadata: [imageMetadataPath].filter(Boolean)
      };
    }

    const currentModel = regenerateModel ? undefined : await latestArtifact(resolved.objectDir, object.id, MODEL_EXTENSIONS);
    if (!currentModel || activeModelRequest) {
      const modelRequest =
        activeModelRequest && activeModelRequest.index === requestIndex
          ? activeModelRequest
          : usableModelRequest && usableModelRequest.index === requestIndex
            ? usableModelRequest
            : undefined;
      modelMetadataPath = modelRequest?.path || requestPath(resolved.objectDir, requestIndex, object.id, "model");
      const modelGeneration = modelRequest
        ? await resumeFalRequest(
            modelRequest,
            modelRequestPrefix(modelRequest, provider),
            resolved.objectDir,
            10000
          )
        : await run3DProvider({
            provider,
            image: generatedImagePath,
            outputDir: resolved.objectDir,
            metadataPath: modelMetadataPath,
            metadata: { index: requestIndex, provider_slug: provider },
            assetName: object.name,
            faceCount: hunyuanFaceCount,
            enablePbr: provider === MESHY_3D_PROVIDER ? meshyEnablePbr : hunyuanEnablePbr,
            generateType: hunyuanGenerateType,
            polygonType: hunyuanPolygonType,
            topology: meshyTopology,
            targetPolycount: meshyTargetPolycount,
            symmetryMode: meshySymmetryMode,
            shouldRemesh: meshyShouldRemesh,
            shouldTexture: meshyShouldTexture,
            riggingHeightMeters: meshyRiggingHeightMeters,
            animationActionId: meshyAnimationActionId,
            enableSafetyChecker: meshyEnableSafetyChecker,
            enableAnimation: meshyEnableAnimation,
            enableRigging: meshyEnableRigging
          });

      const normalizedModelFiles = await normalizeModelFiles(
        modelGeneration.downloaded_files || [],
        resolved.objectDir,
        object.id,
        requestIndex
      );
      modelFiles = normalizedModelFiles.map((file) => file.path);
      const modelMetadata = (await readJsonIfExists(modelMetadataPath)) || modelGeneration;
      await writeJson(modelMetadataPath, {
        ...modelMetadata,
        kind: "3d",
        index: requestIndex,
        provider_slug: modelMetadata.provider_slug || modelRequestPrefix(modelRequest, provider),
        output_files: modelFiles,
        downloaded_files: sanitizeForMetadata(normalizedModelFiles),
        updated_at: nowIso()
      });
    } else {
      modelFiles = [currentModel.path];
    }

    return {
      schema_version: 1,
      world,
      object,
      object_json: resolved.objectJsonPath,
      output_dir: resolved.objectDir,
      model_provider: provider,
      reference_image: generatedImagePath,
      model_files: modelFiles,
      request_metadata: [imageMetadataPath, modelMetadataPath].filter(Boolean)
    };
  } catch (error) {
    throw Object.assign(error, {
      object,
      object_json: resolved.objectJsonPath,
      output_dir: resolved.objectDir
    });
  }
}

export const generateSingleAsset = generateSingleObject;

async function main() {
  const { flags } = parseArgs();
  const world = one(flags, "world");
  const objectId = one(flags, "object-id") || one(flags, "asset-id");
  const directImage = one(flags, "image");

  if (!world || (!objectId && !directImage)) {
    throw new Error(
      "Usage: node generate-single-asset.mjs --world <world-name> (--object-id <object-id> | --image <path>) --image-edit-prompt <prompt> [--object-name <name>] [--description <text>] [--provider hunyuan|meshy] [--regenerate] [--regenerate-reference] [--reference-only] [--face-count <40000-1500000>] [--generate-type Normal|LowPoly|Geometry] [--polygon-type triangle|quadrilateral] [--target-polycount 30000] [--enable-pbr true|false]"
    );
  }

  const result = await generateSingleObject({
    world,
    objectId,
    directImage,
    objectName: one(flags, "object-name") || one(flags, "asset-name"),
    description: one(flags, "description"),
    imageEditPrompt: one(flags, "image-edit-prompt") || one(flags, "prompt"),
    regenerate: Boolean(flags.regenerate),
    regenerateReference: Boolean(flags["regenerate-reference"]),
    referenceOnly: Boolean(flags["reference-only"]),
    imageEditProvider: one(flags, "image-edit-provider"),
    modelProvider: one(flags, "provider") || one(flags, "3d-provider") || one(flags, "model-provider"),
    hunyuanFaceCount: one(flags, "face-count", DEFAULT_HUNYUAN_FACE_COUNT),
    hunyuanEnablePbr: one(flags, "enable-pbr", DEFAULT_HUNYUAN_ENABLE_PBR),
    hunyuanGenerateType: one(flags, "generate-type", DEFAULT_HUNYUAN_GENERATE_TYPE),
    hunyuanPolygonType: one(flags, "polygon-type", DEFAULT_HUNYUAN_POLYGON_TYPE),
    meshyTopology: one(flags, "topology", DEFAULT_MESHY_TOPOLOGY),
    meshyTargetPolycount: one(flags, "target-polycount", DEFAULT_MESHY_TARGET_POLYCOUNT),
    meshySymmetryMode: one(flags, "symmetry-mode", DEFAULT_MESHY_SYMMETRY_MODE),
    meshyShouldRemesh: one(flags, "should-remesh", DEFAULT_MESHY_SHOULD_REMESH),
    meshyShouldTexture: one(flags, "should-texture", DEFAULT_MESHY_SHOULD_TEXTURE),
    meshyRiggingHeightMeters: one(flags, "rigging-height-meters", DEFAULT_MESHY_RIGGING_HEIGHT_METERS),
    meshyAnimationActionId: one(flags, "animation-action-id", DEFAULT_MESHY_ANIMATION_ACTION_ID),
    meshyEnableSafetyChecker: one(flags, "enable-safety-checker", DEFAULT_MESHY_ENABLE_SAFETY_CHECKER),
    meshyEnableAnimation: one(flags, "enable-animation", DEFAULT_MESHY_ENABLE_ANIMATION),
    meshyEnableRigging: one(flags, "enable-rigging", DEFAULT_MESHY_ENABLE_RIGGING),
    meshyEnablePbr: one(flags, "enable-pbr", DEFAULT_MESHY_ENABLE_PBR)
  });

  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
