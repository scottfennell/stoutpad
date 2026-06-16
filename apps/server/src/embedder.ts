/**
 * The local embedding model loader.
 *
 * Production semantic search embeds text with a **locally-run** sentence-
 * transformer (`Xenova/all-MiniLM-L6-v2`, 384-dim) via `@xenova/transformers`,
 * which runs ONNX inference in-process — no network calls once the model is
 * cached, no third-party API. The dependency is heavy and optional, so it is
 * imported lazily through a computed specifier and guarded: when the model (or
 * its native runtime) is unavailable, we fall back to the pure, dependency-free
 * {@link createHashingEmbedder} from `@stout/core`. Everything downstream depends
 * only on the {@link Embedder} seam, so the fallback is transparent and the
 * offline tests use a stub/hashing embedder instead of loading the model.
 */

import { createHashingEmbedder, type Embedder } from "@stout/core";

/**
 * Output dimensionality of the production model (`Xenova/all-MiniLM-L6-v2`) and
 * therefore the fixed width of the `note_chunks.embedding` pgvector column. The
 * hashing fallback is built at the same width so every stored vector — model or
 * fallback — is column-compatible and comparable.
 */
export const EMBEDDING_DIMENSIONS = 384;

/** The Hugging Face model id of the local sentence-transformer. */
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/** Minimal shape of the `@xenova/transformers` feature-extraction pipeline. */
interface FeatureExtractor {
  (
    text: string,
    options: { pooling: "mean"; normalize: boolean },
  ): Promise<{ data: ArrayLike<number> }>;
}

/** The slice of the `@xenova/transformers` module surface we use. */
interface TransformersModule {
  pipeline(task: "feature-extraction", model: string): Promise<FeatureExtractor>;
}

/**
 * Load the embedding {@link Embedder}: the local model when it can be loaded,
 * otherwise the hashing fallback. Always resolves (never throws) so a missing or
 * broken model degrades search to the keyword/hashing path rather than crashing
 * the server.
 */
export async function loadEmbedder(): Promise<Embedder> {
  try {
    // A `string`-typed (not literal) specifier keeps the heavy, optional model
    // dependency out of type-checking and bundling; it is resolved at runtime
    // only, and only when the package is actually installed.
    const specifier: string = "@xenova/transformers";
    const transformers = (await import(specifier)) as TransformersModule;
    const extract = await transformers.pipeline("feature-extraction", MODEL_ID);
    console.log(`[stout] semantic search model loaded: ${MODEL_ID}`);
    return {
      id: `xenova/${MODEL_ID}`,
      dimensions: EMBEDDING_DIMENSIONS,
      async embed(text: string): Promise<number[]> {
        // The model rejects empty input; a single space embeds harmlessly.
        const output = await extract(text.trim() || " ", {
          pooling: "mean",
          normalize: true,
        });
        return Array.from(output.data);
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[stout] embedding model unavailable (${reason}); ` +
        "falling back to the hashing embedder",
    );
    return createHashingEmbedder(EMBEDDING_DIMENSIONS);
  }
}
