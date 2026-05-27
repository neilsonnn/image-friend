#!/usr/bin/env node
import path from "node:path";
import {
  callFalQueue,
  downloadRemoteFiles,
  ensureDir,
  many,
  one,
  parseArgs,
  toModelInputUrl,
  writeJson
} from "./fal-queue.mjs";
import { buildRequestSummary, requestPath } from "./request-metadata.mjs";
import { pathToFileURL } from "node:url";

const ENDPOINT = "openai/gpt-image-2/edit";

export async function runGptImage2Edit(options) {
  const {
    prompt,
    images,
    outputDir,
    numImages = 1,
    imageSize = "auto",
    quality = "medium",
    outputFormat = "png",
    maskImage,
    metadataPath,
    metadata = {},
    onSubmit,
    onStatus
  } = options;

  if (!prompt) throw new Error("GPT Image 2 prompt is required.");
  if (!images?.length) throw new Error("At least one input image is required.");
  if (!outputDir) throw new Error("outputDir is required.");

  await ensureDir(outputDir);

  const imageUrls = [];
  for (const image of images) {
    imageUrls.push(await toModelInputUrl(image));
  }

  const input = {
    prompt,
    image_urls: imageUrls,
    image_size: imageSize,
    quality,
    num_images: Number(numImages),
    output_format: outputFormat
  };

  if (maskImage) {
    input.mask_image_url = await toModelInputUrl(maskImage);
  }

  const result = await callFalQueue(ENDPOINT, input, {
    metadataPath: metadataPath || requestPath(outputDir, 0, "gpt-image-2"),
    metadata: { kind: "2d", provider: ENDPOINT, ...metadata },
    onSubmit,
    onStatus
  });

  const downloaded = await downloadRemoteFiles(result.data, outputDir, "gpt-image-2");
  const summary = buildRequestSummary({
    kind: "2d",
    provider: ENDPOINT,
    metadata,
    requestId: result.requestId,
    submittedAt: result.submittedAt,
    prompt,
    inputFiles: images,
    outputFiles: downloaded.map((file) => file.path),
    downloadedFiles: downloaded,
    result: result.data
  });

  await writeJson(metadataPath || requestPath(outputDir, 0, "gpt-image-2"), summary);
  return summary;
}

async function main() {
  const { flags } = parseArgs();
  const images = [...many(flags, "image"), ...many(flags, "input-image")];
  const prompt = one(flags, "prompt");
  const outputDir = one(flags, "output-dir");

  if (!prompt || !outputDir || images.length === 0) {
    throw new Error(
      "Usage: node gpt-image-2-edit.mjs --image <path-or-url> --prompt <prompt> --output-dir <dir>"
    );
  }

  const summary = await runGptImage2Edit({
    prompt,
    images,
    outputDir,
    numImages: one(flags, "num-images", 1),
    imageSize: one(flags, "image-size", "auto"),
    quality: one(flags, "quality", "medium"),
    outputFormat: one(flags, "format", "png"),
    maskImage: one(flags, "mask-image")
  });

  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
