#!/usr/bin/env node
import {
  one,
  parseArgs,
} from "./fal-queue.mjs";
import { runFalImageTo3DProvider } from "./fal-3d-provider.mjs";

export const HUNYUAN_3D_ENDPOINT = "fal-ai/hunyuan3d-v3/image-to-3d";
export const HUNYUAN_3D_PROVIDER = "hunyuan";
export const DEFAULT_HUNYUAN_FACE_COUNT = 50000;
export const DEFAULT_HUNYUAN_ENABLE_PBR = true;
export const DEFAULT_HUNYUAN_GENERATE_TYPE = "Normal";
export const DEFAULT_HUNYUAN_POLYGON_TYPE = "triangle";

const MIN_FACE_COUNT = 40000;
const MAX_FACE_COUNT = 1500000;
const GENERATE_TYPES = new Map([
  ["normal", "Normal"],
  ["lowpoly", "LowPoly"],
  ["geometry", "Geometry"]
]);
const POLYGON_TYPES = new Map([
  ["triangle", "triangle"],
  ["quadrilateral", "quadrilateral"]
]);

function normalizeFaceCount(value) {
  const faceCount = Number(value);
  if (!Number.isInteger(faceCount) || faceCount < MIN_FACE_COUNT || faceCount > MAX_FACE_COUNT) {
    throw new Error(
      `face-count must be an integer between ${MIN_FACE_COUNT} and ${MAX_FACE_COUNT}.`
    );
  }
  return faceCount;
}

function normalizeGenerateType(value) {
  const normalized = GENERATE_TYPES.get(String(value).trim().toLowerCase());
  if (!normalized) {
    throw new Error("generate-type must be one of: Normal, LowPoly, Geometry.");
  }
  return normalized;
}

function normalizePolygonType(value) {
  const normalized = POLYGON_TYPES.get(String(value).trim().toLowerCase());
  if (!normalized) {
    throw new Error("polygon-type must be one of: triangle, quadrilateral.");
  }
  return normalized;
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error("enable-pbr must be true or false.");
}

export async function runHunyuan3D(options) {
  const {
    image,
    outputDir,
    assetName,
    faceCount = DEFAULT_HUNYUAN_FACE_COUNT,
    enablePbr = DEFAULT_HUNYUAN_ENABLE_PBR,
    generateType = DEFAULT_HUNYUAN_GENERATE_TYPE,
    polygonType = DEFAULT_HUNYUAN_POLYGON_TYPE,
    metadataPath,
    metadata = {},
    onSubmit,
    onStatus
  } = options;

  if (!image) throw new Error("Input image is required.");
  if (!outputDir) throw new Error("outputDir is required.");

  const normalizedFaceCount = normalizeFaceCount(faceCount);
  const normalizedGenerateType = normalizeGenerateType(generateType);
  const normalizedEnablePbr = normalizeBoolean(enablePbr);
  const normalizedPolygonType = normalizePolygonType(polygonType);

  const input = {
    generate_type: normalizedGenerateType,
    enable_pbr: normalizedEnablePbr,
    face_count: normalizedFaceCount
  };
  if (normalizedGenerateType === "LowPoly") {
    input.polygon_type = normalizedPolygonType;
  }

  return runFalImageTo3DProvider({
    endpoint: HUNYUAN_3D_ENDPOINT,
    providerSlug: HUNYUAN_3D_PROVIDER,
    imageInputKey: "input_image_url",
    image,
    outputDir,
    assetName,
    input,
    metadataPath,
    metadata,
    pollIntervalMs: 10000,
    onSubmit,
    onStatus
  });
}

async function main() {
  const { flags } = parseArgs();
  const image = one(flags, "image") || one(flags, "input-image");
  const outputDir = one(flags, "output-dir");

  if (!image || !outputDir) {
    throw new Error(
      "Usage: node hunyuan-3d.mjs --image <path-or-url> --output-dir <dir> [--asset-name <name>] [--face-count <40000-1500000>] [--generate-type Normal|LowPoly|Geometry] [--polygon-type triangle|quadrilateral] [--enable-pbr true|false]"
    );
  }

  const summary = await runHunyuan3D({
    image,
    outputDir,
    assetName: one(flags, "asset-name"),
    faceCount: one(flags, "face-count", DEFAULT_HUNYUAN_FACE_COUNT),
    enablePbr: one(flags, "enable-pbr", DEFAULT_HUNYUAN_ENABLE_PBR),
    generateType: one(flags, "generate-type", DEFAULT_HUNYUAN_GENERATE_TYPE),
    polygonType: one(flags, "polygon-type", DEFAULT_HUNYUAN_POLYGON_TYPE)
  });

  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
