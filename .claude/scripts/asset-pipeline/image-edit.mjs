#!/usr/bin/env node
import { runGptImage2Edit } from "./gpt-image-2-edit.mjs";
import { runNanoBananaEdit } from "./nano-banana-edit.mjs";
import { loadDotEnv, many, one, parseArgs } from "./fal-queue.mjs";
import { requestPath } from "./request-metadata.mjs";
import { pathToFileURL } from "node:url";

const PROVIDERS = new Set(["nano-banana", "gpt-image-2"]);

export function resolveImageEditProvider(provider) {
  const resolved = provider || process.env.ASSET_IMAGE_EDIT_PROVIDER || "nano-banana";
  if (!PROVIDERS.has(resolved)) {
    throw new Error(
      `Unsupported image edit provider "${resolved}". Use one of: ${[...PROVIDERS].join(", ")}.`
    );
  }
  return resolved;
}

export async function runImageEdit(options) {
  await loadDotEnv();
  const provider = resolveImageEditProvider(options.provider);
  let summary;

  if (provider === "gpt-image-2") {
    summary = await runGptImage2Edit({
      ...options,
      metadataPath: options.metadataPath || requestPath(options.outputDir, 0, "image-edit"),
      quality: options.quality || "medium",
      imageSize: options.imageSize || "auto"
    });
  } else {
    summary = await runNanoBananaEdit({
      ...options,
      metadataPath: options.metadataPath || requestPath(options.outputDir, 0, "image-edit"),
      resolution: options.resolution || "1K",
      aspectRatio: options.aspectRatio || "auto"
    });
  }

  const normalizedSummary = {
    ...summary,
    provider_alias: provider
  };

  return normalizedSummary;
}

async function main() {
  const { flags } = parseArgs();
  const images = [...many(flags, "image"), ...many(flags, "input-image")];
  const prompt = one(flags, "prompt");
  const outputDir = one(flags, "output-dir");

  if (!prompt || !outputDir || images.length === 0) {
    throw new Error(
      "Usage: node image-edit.mjs --image <path-or-url> --prompt <prompt> --output-dir <dir> [--provider nano-banana|gpt-image-2]"
    );
  }

  const summary = await runImageEdit({
    provider: one(flags, "provider"),
    prompt,
    images,
    outputDir,
    numImages: one(flags, "num-images", 1),
    outputFormat: one(flags, "format", "png"),
    resolution: one(flags, "resolution", "1K"),
    aspectRatio: one(flags, "aspect-ratio", "auto"),
    quality: one(flags, "quality", "medium"),
    imageSize: one(flags, "image-size", "auto"),
    maskImage: one(flags, "mask-image"),
    seed: one(flags, "seed")
  });

  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
