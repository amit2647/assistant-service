const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const { embed, embedOne, MODEL } = require("./embedder");
const vectorStore = require("./vectorStore");

/*
 * Product help: the Markdown in /knowledge, searchable by meaning.
 *
 * Each file names the permission it is about. Search is filtered to the
 * permissions the caller holds right now, so the assistant cannot explain a
 * screen the person does not have — the same rule the tool catalog follows.
 */

const KNOWLEDGE_DIR = path.join(__dirname, "..", "..", "knowledge");

const COLLECTION = vectorStore.COLLECTIONS.knowledge;

const RESULTS = 3;
const MIN_SIMILARITY = 0.3;

function parseFrontMatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);

  if (!match) {
    return { meta: {}, body: text };
  }

  const meta = {};

  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");

    if (key && rest.length > 0) {
      meta[key.trim()] = rest.join(":").trim();
    }
  }

  return { meta, body: text.slice(match[0].length) };
}

/*
 * One chunk per "## " section, prefixed with the page title so a section read
 * on its own still says what it is about.
 */
function chunk(title, body) {
  return body
    .split(/^(?=## )/m)
    .map((section) => section.trim())
    .filter((section) => section.startsWith("## "))
    .map((section) => `${title}\n\n${section}`);
}

// Qdrant ids are integers or UUIDs; this derives a stable UUID per chunk slot.
function pointId(source, index) {
  const hex = crypto.createHash("sha256").update(`${source}#${index}`).digest("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function hash(text) {
  return crypto.createHash("sha256").update(`${MODEL}\n${text}`).digest("hex");
}

async function readDocs() {
  const files = (await fs.readdir(KNOWLEDGE_DIR))
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort();

  const docs = [];

  for (const file of files) {
    const { meta, body } = parseFrontMatter(await fs.readFile(path.join(KNOWLEDGE_DIR, file), "utf8"));
    const source = file.replace(/\.md$/, "");

    docs.push({
      source,
      permission: meta.permission || null,
      chunks: chunk(meta.title || source, body),
    });
  }

  return docs;
}

/*
 * Brings Qdrant in line with the files. Idempotent: a chunk whose text (and
 * embedding model) is unchanged keeps its vector, so a restart costs a lookup,
 * not a re-embed. Chunks and pages that no longer exist are removed.
 */
async function syncKnowledge() {
  const docs = await readDocs();

  const wanted = docs.flatMap((doc) =>
    doc.chunks.map((content, index) => ({
      id: pointId(doc.source, index),
      content,
      payload: {
        source: doc.source,
        chunk_index: index,
        content,
        content_hash: hash(content),
        ...(doc.permission ? { permission: doc.permission } : {}),
      },
    })),
  );

  const existing = wanted.length
    ? await vectorStore.retrieve(COLLECTION, wanted.map((item) => item.id))
    : [];

  const current = new Map(
    existing.map((point) => [
      String(point.id),
      `${point.payload?.content_hash}|${point.payload?.permission || ""}`,
    ]),
  );

  const changed = wanted.filter(
    (item) =>
      current.get(item.id) !== `${item.payload.content_hash}|${item.payload.permission || ""}`,
  );

  if (changed.length > 0) {
    const vectors = await embed(changed.map((item) => item.content));

    await vectorStore.upsert(
      COLLECTION,
      changed.map((item, index) => ({ id: item.id, vector: vectors[index], payload: item.payload })),
    );
  }

  // Sections removed from a page that is still there.
  for (const doc of docs) {
    await vectorStore.deleteWhere(COLLECTION, {
      must: [
        { key: "source", match: { value: doc.source } },
        { key: "chunk_index", range: { gte: doc.chunks.length } },
      ],
    });
  }

  // Pages removed altogether.
  await vectorStore.deleteWhere(COLLECTION, {
    must_not: [{ key: "source", match: { any: docs.map((doc) => doc.source) } }],
  });

  return { chunks: wanted.length, embedded: changed.length };
}

/*
 * Help for this caller. A chunk qualifies if it has no permission (general
 * help) or one the caller holds — checked inside the vector search, so help
 * about other features is never even a candidate.
 */
async function searchHelp(question, permissions) {
  const held = Array.isArray(permissions) ? permissions : [];

  const vector = await embedOne(question);

  const points = await vectorStore.search(COLLECTION, {
    vector,
    filter: {
      should: [
        { is_empty: { key: "permission" } },
        ...(held.length ? [{ key: "permission", match: { any: held } }] : []),
      ],
    },
    limit: RESULTS,
    scoreThreshold: MIN_SIMILARITY,
  });

  // Checked again here, so a stale point from a page whose permission changed
  // can never slip through.
  return points
    .filter((point) => !point.payload?.permission || held.includes(point.payload.permission))
    .map((point) => point.payload.content);
}

module.exports = { syncKnowledge, searchHelp };
