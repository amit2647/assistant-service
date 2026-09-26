/*
 * Sentence embeddings, computed locally.
 *
 * all-MiniLM-L6-v2 (384 dimensions, 8-bit quantised) runs in-process through
 * transformers.js, so no conversation text leaves the stack and there is no
 * per-call cost. In the Docker image the model is fetched at build time and
 * remote downloads are then switched off; run outside Docker, it downloads on
 * first use.
 */

const MODEL = "Xenova/all-MiniLM-L6-v2";

const DIMENSIONS = 384;

/*
 * The model reads at most 256 tokens; anything longer is cut by the tokenizer
 * anyway. Trimming first keeps a very long reply from costing tokenizer time
 * it will not use.
 */
const MAX_CHARS = 2000;

let extractor = null;

function load() {
  if (!extractor) {
    extractor = (async () => {
      // transformers.js is ESM-only in spirit; a dynamic import works from
      // this CommonJS service.
      const { pipeline, env } = await import("@huggingface/transformers");

      if (process.env.EMBEDDING_CACHE_DIR) {
        env.cacheDir = process.env.EMBEDDING_CACHE_DIR;
        env.allowRemoteModels = false;
      }

      return pipeline("feature-extraction", MODEL, { dtype: "q8" });
    })().catch((error) => {
      // Let the next call try again rather than caching the failure.
      extractor = null;
      throw error;
    });
  }

  return extractor;
}

/* Normalised vectors, so cosine similarity is a plain dot product. */
async function embed(texts) {
  if (texts.length === 0) {
    return [];
  }

  const run = await load();

  const output = await run(
    texts.map((text) => String(text).slice(0, MAX_CHARS)),
    { pooling: "mean", normalize: true },
  );

  return output.tolist();
}

async function embedOne(text) {
  const [vector] = await embed([text]);

  return vector;
}

module.exports = { embed, embedOne, MODEL, DIMENSIONS };
