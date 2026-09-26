const { DIMENSIONS } = require("./embedder");

/*
 * Qdrant, over its REST API.
 *
 * A derived index only: every point can be rebuilt from Postgres, and every
 * hit is re-read from Postgres before it is shown (see searchService), so
 * nothing here is trusted on its own.
 */

const QDRANT_URL = process.env.QDRANT_URL || "http://qdrant:6333";

const COLLECTIONS = {
  messages: "assistant_messages",
  knowledge: "assistant_knowledge",
};

/*
 * Payload fields that queries filter on. Indexing them lets Qdrant apply the
 * filter during the vector search instead of after it — which is what keeps a
 * per-user search accurate however many users share the collection.
 */
const INDEXES = {
  [COLLECTIONS.messages]: [
    { field: "organization_id", schema: "integer" },
    { field: "user_id", schema: "integer" },
    { field: "conversation_id", schema: "keyword" },
    { field: "seq", schema: "integer" },
  ],
  [COLLECTIONS.knowledge]: [
    { field: "source", schema: "keyword" },
    { field: "chunk_index", schema: "integer" },
    { field: "permission", schema: "keyword" },
  ],
};

async function call(method, path, body) {
  const headers = { "Content-Type": "application/json" };

  if (process.env.QDRANT_API_KEY) {
    headers["api-key"] = process.env.QDRANT_API_KEY;
  }

  const response = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 1000),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = payload?.status?.error || response.statusText;
    throw new Error(`Qdrant ${method} ${path} failed (${response.status}): ${detail}`);
  }

  return payload?.result;
}

let ensured = null;

/*
 * Creates both collections and their payload indexes if missing. Safe to call
 * repeatedly and from several replicas; memoised once it has succeeded.
 */
function ensureCollections() {
  if (!ensured) {
    ensured = (async () => {
      for (const name of Object.values(COLLECTIONS)) {
        const { exists } = await call("GET", `/collections/${name}/exists`);

        if (!exists) {
          try {
            await call("PUT", `/collections/${name}`, {
              vectors: { size: DIMENSIONS, distance: "Cosine" },
            });
          } catch (error) {
            // Another replica created it in between; anything else is real.
            const { exists: nowExists } = await call("GET", `/collections/${name}/exists`);

            if (!nowExists) {
              throw error;
            }
          }
        }

        for (const index of INDEXES[name]) {
          await call("PUT", `/collections/${name}/index?wait=true`, {
            field_name: index.field,
            field_schema: index.schema,
          });
        }
      }
    })().catch((error) => {
      ensured = null;
      throw error;
    });
  }

  return ensured;
}

// wait=true: the call returns once the points are searchable, so a row is only
// marked done in Postgres after it really is in the index.
function upsert(collection, points) {
  return call("PUT", `/collections/${collection}/points?wait=true`, { points });
}

function deleteWhere(collection, filter) {
  return call("POST", `/collections/${collection}/points/delete?wait=true`, { filter });
}

function retrieve(collection, ids) {
  return call("POST", `/collections/${collection}/points`, {
    ids,
    with_payload: true,
    with_vector: false,
  });
}

async function search(collection, { vector, filter, limit, scoreThreshold }) {
  const result = await call("POST", `/collections/${collection}/points/query`, {
    query: vector,
    filter,
    limit,
    score_threshold: scoreThreshold,
    with_payload: true,
  });

  return result?.points || [];
}

// Qdrant's filter syntax, for the common case of exact matches.
function matchAll(conditions) {
  return {
    must: Object.entries(conditions).map(([key, value]) => ({
      key,
      match: { value },
    })),
  };
}

module.exports = {
  COLLECTIONS,
  ensureCollections,
  upsert,
  deleteWhere,
  retrieve,
  search,
  matchAll,
};
