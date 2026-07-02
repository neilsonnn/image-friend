#!/usr/bin/env node
import { one, parseArgs } from "./fal-queue.mjs";
import { runFalImageTo3DProvider } from "./fal-3d-provider.mjs";

export const MESHY_3D_ENDPOINT = "fal-ai/meshy/v6/image-to-3d";
export const MESHY_3D_PROVIDER = "meshy";
export const DEFAULT_MESHY_TOPOLOGY = "triangle";
export const DEFAULT_MESHY_TARGET_POLYCOUNT = 30000;
export const DEFAULT_MESHY_SYMMETRY_MODE = "auto";
export const DEFAULT_MESHY_SHOULD_REMESH = true;
export const DEFAULT_MESHY_SHOULD_TEXTURE = true;
export const DEFAULT_MESHY_RIGGING_HEIGHT_METERS = 1.7;
export const DEFAULT_MESHY_ANIMATION_ACTION_ID = 12;
export const DEFAULT_MESHY_ENABLE_SAFETY_CHECKER = true;
export const DEFAULT_MESHY_ENABLE_ANIMATION = false;
export const DEFAULT_MESHY_ENABLE_RIGGING = false;
export const DEFAULT_MESHY_ENABLE_PBR = true;

function normalizeBoolean(value, fieldName) {
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${fieldName} must be true or false.`);
}

function normalizeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${fieldName} must be an integer.`);
  return number;
}

function normalizePositiveInteger(value, fieldName) {
  const number = normalizeInteger(value, fieldName);
  if (number <= 0) throw new Error(`${fieldName} must be greater than 0.`);
  return number;
}

function normalizeNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${fieldName} must be a number.`);
  return number;
}

export function buildMeshy3DInput(options = {}) {
  return {
    topology: options.topology || DEFAULT_MESHY_TOPOLOGY,
    target_polycount: normalizePositiveInteger(
      options.targetPolycount ?? DEFAULT_MESHY_TARGET_POLYCOUNT,
      "target-polycount"
    ),
    symmetry_mode: options.symmetryMode || DEFAULT_MESHY_SYMMETRY_MODE,
    should_remesh: normalizeBoolean(
      options.shouldRemesh ?? DEFAULT_MESHY_SHOULD_REMESH,
      "should-remesh"
    ),
    should_texture: normalizeBoolean(
      options.shouldTexture ?? DEFAULT_MESHY_SHOULD_TEXTURE,
      "should-texture"
    ),
    rigging_height_meters: normalizeNumber(
      options.riggingHeightMeters ?? DEFAULT_MESHY_RIGGING_HEIGHT_METERS,
      "rigging-height-meters"
    ),
    animation_action_id: normalizeInteger(
      options.animationActionId ?? DEFAULT_MESHY_ANIMATION_ACTION_ID,
      "animation-action-id"
    ),
    enable_safety_checker: normalizeBoolean(
      options.enableSafetyChecker ?? DEFAULT_MESHY_ENABLE_SAFETY_CHECKER,
      "enable-safety-checker"
    ),
    enable_animation: normalizeBoolean(
      options.enableAnimation ?? DEFAULT_MESHY_ENABLE_ANIMATION,
      "enable-animation"
    ),
    enable_rigging: normalizeBoolean(
      options.enableRigging ?? DEFAULT_MESHY_ENABLE_RIGGING,
      "enable-rigging"
    ),
    enable_pbr: normalizeBoolean(options.enablePbr ?? DEFAULT_MESHY_ENABLE_PBR, "enable-pbr")
  };
}

export async function runMeshy3D(options) {
  const {
    image,
    outputDir,
    assetName,
    metadataPath,
    metadata = {},
    onSubmit,
    onStatus
  } = options;

  if (!image) throw new Error("Input image is required.");
  if (!outputDir) throw new Error("outputDir is required.");

  return runFalImageTo3DProvider({
    endpoint: MESHY_3D_ENDPOINT,
    providerSlug: MESHY_3D_PROVIDER,
    imageInputKey: "image_url",
    image,
    outputDir,
    assetName,
    input: buildMeshy3DInput(options),
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
      "Usage: node meshy-3d.mjs --image <path-or-url> --output-dir <dir> [--asset-name <name>] [--target-polycount 30000] [--enable-pbr true|false]"
    );
  }

  const summary = await runMeshy3D({
    image,
    outputDir,
    assetName: one(flags, "asset-name"),
    topology: one(flags, "topology", DEFAULT_MESHY_TOPOLOGY),
    targetPolycount: one(flags, "target-polycount", DEFAULT_MESHY_TARGET_POLYCOUNT),
    symmetryMode: one(flags, "symmetry-mode", DEFAULT_MESHY_SYMMETRY_MODE),
    shouldRemesh: one(flags, "should-remesh", DEFAULT_MESHY_SHOULD_REMESH),
    shouldTexture: one(flags, "should-texture", DEFAULT_MESHY_SHOULD_TEXTURE),
    riggingHeightMeters: one(flags, "rigging-height-meters", DEFAULT_MESHY_RIGGING_HEIGHT_METERS),
    animationActionId: one(flags, "animation-action-id", DEFAULT_MESHY_ANIMATION_ACTION_ID),
    enableSafetyChecker: one(flags, "enable-safety-checker", DEFAULT_MESHY_ENABLE_SAFETY_CHECKER),
    enableAnimation: one(flags, "enable-animation", DEFAULT_MESHY_ENABLE_ANIMATION),
    enableRigging: one(flags, "enable-rigging", DEFAULT_MESHY_ENABLE_RIGGING),
    enablePbr: one(flags, "enable-pbr", DEFAULT_MESHY_ENABLE_PBR)
  });

  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
