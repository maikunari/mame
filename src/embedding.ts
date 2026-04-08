// src/embedding.ts — Local embedding generation via transformers.js.
//
// Evening 5 of the pi-ai migration. Used by src/memory.ts to compute
// 384-dimensional embeddings for semantic memory search alongside the
// existing FTS5 keyword search.
//
// Why local embeddings instead of an API:
// - Zero API cost for memory operations (remember + recall run constantly)
// - Works offline — no dependency on OpenRouter / OpenAI being up
// - Stays inside Mame's "personal agent on your own hardware" ethos
// - all-MiniLM-L6-v2 is tiny (~23MB model file), fast (~200ms per
//   embedding on a modest CPU), and well-known as the default semantic
//   search baseline
//
// The model is downloaded on first use and cached in transformers.js's
// default cache directory (~/.cache/huggingface by default). Subsequent
// starts reuse the cached model and load in ~2s.
//
// Lazy loading: the model is only initialized when something actually
// calls embed(). mame chat and mame init don't trigger the download;
// only tools that touch memory do.

import { childLogger } from "./logger.js";

const log = childLogger("embedding");

/**
 * The embedding model. Kept as `unknown` so we can skip importing
 * transformers.js types at the top level — they're expensive and we
 * don't need the type surface outside this file.
 */
let pipeline: unknown | null = null;
let loading: Promise<unknown> | null = null;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;

/**
 * Get (or lazy-initialize) the embedding pipeline. Returns the same
 * instance on subsequent calls, so the first embed() pays the load cost
 * and everything after is hot-path.
 */
async function getPipeline(): Promise<any> {
  if (pipeline) return pipeline;
  if (loading) return loading;

  loading = (async () => {
    log.info({ model: MODEL_ID }, "Loading local embedding model (first use)");
    const start = Date.now();
    // Dynamic import so transformers.js doesn't load unless we actually
    // need it. Its top-level import is ~150ms on its own.
    const tf = await import("@xenova/transformers");
    // Disable progress bars / console output from transformers.js.
    // Pino takes over logging so we don't want interleaved stdout junk.
    // @ts-ignore
    tf.env.allowRemoteModels = true;
    // @ts-ignore
    tf.env.allowLocalModels = true;
    const p = await tf.pipeline("feature-extraction", MODEL_ID, {
      // @ts-ignore
      quantized: true,
    });
    pipeline = p;
    log.info(
      { model: MODEL_ID, elapsed_ms: Date.now() - start },
      "Embedding model ready"
    );
    return p;
  })();

  return loading;
}

/**
 * Compute a 384-dim embedding for a single text string.
 *
 * Returns a Float32Array so it can be passed directly to sqlite-vec's
 * MATCH operator, which expects vectors as raw bytes in Float32
 * little-endian order — better-sqlite3 handles the Buffer conversion.
 *
 * The text is normalized (mean-pooled over tokens) and L2-normalized so
 * dot product = cosine similarity, which is what sqlite-vec uses
 * internally.
 *
 * Errors become null returns rather than throws — the caller can fall
 * back to FTS5-only recall. The memory pipeline should never hard-fail
 * on an embedding hiccup.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  if (!text || text.trim().length === 0) return null;

  try {
    const pipe = await getPipeline();
    const output = await pipe(text, { pooling: "mean", normalize: true });
    // transformers.js returns a Tensor-like object with a .data property
    // that's a Float32Array of the mean-pooled, normalized embedding.
    return new Float32Array(output.data);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to compute embedding; falling back to FTS5-only recall"
    );
    return null;
  }
}

/**
 * Convenience: pre-warm the embedding model so the first real call
 * doesn't pay the ~2-3s load cost. Called from the daemon startup path
 * after the tools register, so the model is ready by the time a user
 * message comes in.
 *
 * Safe to call multiple times — getPipeline() is idempotent.
 */
export async function warmUpEmbedding(): Promise<void> {
  await getPipeline();
}
