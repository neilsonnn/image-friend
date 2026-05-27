#!/usr/bin/env node
import {
  callFalQueue,
  collectRemoteFiles,
  downloadFile,
  ensureDir,
  extensionForFile,
  many,
  one,
  parseArgs,
  pathExists,
  readJson,
  requireEnv,
  sanitizeForMetadata,
  slugify,
  toModelInputUrl,
  writeJson
} from "../asset-pipeline/fal-queue.mjs";
import {
  artifactPath,
  buildRequestSummary,
  nextIndex,
  requestPath
} from "../asset-pipeline/request-metadata.mjs";
import { pathToFileURL } from "node:url";

function parseJsonValue(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function pathParts(keyPath) {
  return String(keyPath)
    .split(".")
    .map((part) => {
      if (/^\d+$/.test(part)) return Number(part);
      return part;
    });
}

function setNestedValue(target, keyPath, value) {
  const parts = pathParts(keyPath);
  if (parts.length === 0) throw new Error("Input key path cannot be empty.");

  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const nextPart = parts[index + 1];
    if (cursor[part] === undefined) {
      cursor[part] = typeof nextPart === "number" ? [] : {};
    }
    cursor = cursor[part];
  }

  cursor[parts.at(-1)] = value;
}

function splitAssignment(value, flagName) {
  const equalsIndex = String(value).indexOf("=");
  if (equalsIndex === -1) {
    throw new Error(`${flagName} expects key=value, received "${value}".`);
  }

  return {
    key: String(value).slice(0, equalsIndex),
    value: String(value).slice(equalsIndex + 1)
  };
}

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === false) return value;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

async function readInput(flags) {
  const inputJson = one(flags, "input-json");
  const inputFile = one(flags, "input-file");
  let input = {};

  if (inputJson && inputFile) {
    throw new Error("Use only one of --input-json or --input-file.");
  }

  if (inputFile) {
    input = await readJson(inputFile);
  } else if (inputJson) {
    input = JSON.parse(inputJson);
  }

  for (const assignment of many(flags, "input")) {
    const { key, value } = splitAssignment(assignment, "--input");
    setNestedValue(input, key, parseJsonValue(value));
  }

  for (const assignment of many(flags, "file")) {
    const { key, value } = splitAssignment(assignment, "--file");
    setNestedValue(input, key, await toModelInputUrl(value));
  }

  return input;
}

async function writeDirectMetadata(metadataPath, patch) {
  const previous = (await pathExists(metadataPath)) ? await readJson(metadataPath) : {};
  await writeJson(metadataPath, {
    schema_version: 1,
    ...previous,
    ...patch,
    updated_at: new Date().toISOString()
  });
}

async function callFalRun(endpoint, input, options) {
  const falKey = await requireEnv("FAL_KEY");
  const submittedAt = new Date().toISOString();

  await writeDirectMetadata(options.metadataPath, {
    ...options.metadata,
    endpoint,
    status: "submitted",
    submitted_at: submittedAt
  });

  const response = await fetch(`https://fal.run/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${falKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    await writeDirectMetadata(options.metadataPath, {
      ...options.metadata,
      endpoint,
      status: "failed",
      completed_at: new Date().toISOString(),
      error: sanitizeForMetadata(body)
    });
    throw new Error(`FAL run failed (${response.status}).`);
  }

  return {
    requestId: undefined,
    submittedAt,
    data: body
  };
}

async function downloadResultFiles(result, outputDir, index, slug) {
  const remoteFiles = collectRemoteFiles(result);
  const downloaded = [];

  for (const [fileIndex, { label, file }] of remoteFiles.entries()) {
    const labelSlug = slugify(label) || `file-${fileIndex + 1}`;
    const outputSlug = remoteFiles.length === 1 ? slug : `${slug}-${fileIndex + 1}-${labelSlug}`;
    const outputPath = artifactPath(outputDir, index, outputSlug, extensionForFile(file));
    await downloadFile(file.url, outputPath);
    downloaded.push({
      label,
      path: outputPath,
      source: file
    });
  }

  return downloaded;
}

export async function runFalWildcard(options) {
  const {
    endpoint,
    input,
    outputDir,
    outputSlug,
    kind = "fal-wildcard",
    mode = "queue",
    pollIntervalMs = 5000,
    downloadOutputs = true,
    userPrompt
  } = options;

  if (!endpoint) throw new Error("--endpoint is required.");
  if (!outputDir) throw new Error("--output-dir is required.");
  if (!["queue", "run"].includes(mode)) throw new Error("--mode must be queue or run.");

  await ensureDir(outputDir);

  const slug = slugify(outputSlug || endpoint.split("/").at(-1) || "fal-output");
  if (!slug) throw new Error("--output-slug or endpoint must produce a usable slug.");

  const index = await nextIndex(outputDir);
  const metadataPath = requestPath(outputDir, index, slug);
  const metadata = {
    kind,
    provider: endpoint,
    endpoint,
    mode,
    index,
    output_slug: slug,
    input: sanitizeForMetadata(input),
    ...(userPrompt ? { user_prompt: userPrompt } : {})
  };

  const result =
    mode === "queue"
      ? await callFalQueue(endpoint, input, {
          metadataPath,
          metadata,
          pollIntervalMs: Number(pollIntervalMs)
        })
      : await callFalRun(endpoint, input, { metadataPath, metadata });

  const downloaded = downloadOutputs
    ? await downloadResultFiles(result.data, outputDir, index, slug)
    : [];

  const previousMetadata = (await pathExists(metadataPath)) ? await readJson(metadataPath) : {};
  const summary = buildRequestSummary({
    kind,
    provider: endpoint,
    endpoint,
    metadata: {
      mode,
      index,
      output_slug: slug,
      input: sanitizeForMetadata(input),
      ...(userPrompt ? { user_prompt: userPrompt } : {})
    },
    requestId: result.requestId,
    submittedAt: result.submittedAt,
    outputFiles: downloaded.map((file) => file.path),
    downloadedFiles: downloaded,
    result: result.data
  });

  await writeJson(metadataPath, {
    ...previousMetadata,
    ...summary
  });

  return {
    schema_version: 1,
    kind,
    provider: endpoint,
    endpoint,
    mode,
    input: sanitizeForMetadata(input),
    output_dir: outputDir,
    request_metadata: metadataPath,
    output_files: downloaded.map((file) => file.path),
    result: sanitizeForMetadata(result.data)
  };
}

async function main() {
  const { flags } = parseArgs();
  const endpoint = one(flags, "endpoint") || one(flags, "model");
  const outputDir = one(flags, "output-dir");
  const input = await readInput(flags);

  if (!endpoint || !outputDir) {
    throw new Error(
      "Usage: node .claude/scripts/fal/run-fal.mjs --endpoint <fal/model> --input-json '<json>' --output-dir <dir> [--output-slug <slug>]"
    );
  }

  const result = await runFalWildcard({
    endpoint,
    input,
    outputDir,
    outputSlug: one(flags, "output-slug") || one(flags, "slug"),
    kind: one(flags, "kind", "fal-wildcard"),
    mode: one(flags, "mode", "queue"),
    pollIntervalMs: one(flags, "poll-interval-ms", 5000),
    downloadOutputs: parseBool(one(flags, "download-outputs"), true),
    userPrompt: one(flags, "user-prompt")
  });

  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
