const { pool } = require("../config/database");
const { embedOne } = require("./embedder");
const vectorStore = require("./vectorStore");

/*
 * Searching a person's past conversations.
 *
 * Two searches, merged:
 *  - by meaning, in Qdrant — finds "the chat about Acme's renewal" from
 *    "pricing discussion";
 *  - by words, in Postgres full-text — finds exact names and ids, which
 *    embeddings are weak at.
 *
 * Qdrant is only ever asked for ids. Every hit is re-read from Postgres with
 * the owner and deleted_at checked again, so a stale or mis-filtered point can
 * never surface another person's message or a deleted conversation.
 */

const CANDIDATES = 40;
const RESULTS = 20;

/*
 * Below this cosine similarity MiniLM matches are mostly noise — short
 * unrelated sentences land around 0.1–0.2.
 */
const MIN_SIMILARITY = 0.3;

// Reciprocal rank fusion constant: dampens how much the very top rank dominates.
const RRF_K = 60;

const SNIPPET_CHARS = 160;

function snippet(content, query) {
  const text = content.replace(/\s+/g, " ").trim();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  const at = words
    .map((word) => text.toLowerCase().indexOf(word))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  // Centre the excerpt on the first matching word, when there is one.
  const start = at === undefined ? 0 : Math.max(0, at - 40);
  const excerpt = text.slice(start, start + SNIPPET_CHARS);

  return `${start > 0 ? "…" : ""}${excerpt}${start + SNIPPET_CHARS < text.length ? "…" : ""}`;
}

async function byMeaning(auth, query) {
  const vector = await embedOne(query);

  const points = await vectorStore.search(vectorStore.COLLECTIONS.messages, {
    vector,
    filter: vectorStore.matchAll({
      organization_id: auth.organizationId,
      user_id: auth.userId,
    }),
    limit: CANDIDATES,
    scoreThreshold: MIN_SIMILARITY,
  });

  if (points.length === 0) {
    return [];
  }

  // The authoritative read. Order follows Qdrant's ranking.
  const { rows } = await pool.query(
    `SELECT m.id, m.conversation_id, m.seq, m.content
       FROM assistant_messages m
       JOIN assistant_conversations c ON c.id = m.conversation_id
      WHERE m.id = ANY($1::bigint[])
        AND c.organization_id = $2
        AND c.user_id = $3
        AND c.deleted_at IS NULL`,
    [points.map((point) => point.id), auth.organizationId, auth.userId],
  );

  const byId = new Map(rows.map((row) => [String(row.id), row]));

  return points.map((point) => byId.get(String(point.id))).filter(Boolean);
}

async function byWords(auth, query) {
  const { rows } = await pool.query(
    `SELECT m.id, m.conversation_id, m.seq, m.content
       FROM assistant_messages m
       JOIN assistant_conversations c ON c.id = m.conversation_id
      WHERE c.organization_id = $1
        AND c.user_id = $2
        AND c.deleted_at IS NULL
        AND m.role IN ('user', 'assistant')
        AND to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $3)
      ORDER BY ts_rank(to_tsvector('simple', m.content), plainto_tsquery('simple', $3)) DESC,
               m.id DESC
      LIMIT $4`,
    [auth.organizationId, auth.userId, query, CANDIDATES],
  );

  return rows;
}

async function searchConversations(auth, query) {
  /*
   * The keyword half never depends on Qdrant or the model, so if either is
   * down search degrades to exact matching instead of failing.
   */
  const [meaning, words] = await Promise.all([
    byMeaning(auth, query).catch((error) => {
      console.error("[Search] Semantic search unavailable:", error.message);
      return [];
    }),
    byWords(auth, query),
  ]);

  // Fuse per conversation: each list contributes its best-ranked message.
  const fused = new Map();

  const add = (list, how) => {
    const seen = new Set();

    list.forEach((row, rank) => {
      if (seen.has(row.conversation_id)) {
        return;
      }

      seen.add(row.conversation_id);

      const entry = fused.get(row.conversation_id) || {
        score: 0,
        best: row,
        matchedBy: [],
      };

      entry.score += 1 / (RRF_K + rank + 1);
      entry.matchedBy.push(how);

      // Prefer a message that contains the words for the snippet: it shows
      // the person why it matched.
      if (how === "words") {
        entry.best = row;
      }

      fused.set(row.conversation_id, entry);
    });
  };

  add(meaning, "meaning");
  add(words, "words");

  const ranked = [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, RESULTS);

  if (ranked.length === 0) {
    return [];
  }

  const { rows: conversations } = await pool.query(
    `SELECT id, title, last_message_at
       FROM assistant_conversations
      WHERE id = ANY($1::uuid[])
        AND organization_id = $2
        AND user_id = $3
        AND deleted_at IS NULL`,
    [ranked.map(([id]) => id), auth.organizationId, auth.userId],
  );

  const byId = new Map(conversations.map((row) => [row.id, row]));

  return ranked
    .filter(([id]) => byId.has(id))
    .map(([id, entry]) => ({
      id,
      title: byId.get(id).title,
      lastMessageAt: byId.get(id).last_message_at,
      snippet: snippet(entry.best.content, query),
      seq: entry.best.seq,
      matchedBy: entry.matchedBy,
    }));
}

/*
 * Recall: the older parts of *this* conversation that bear on the question.
 *
 * Only looks before `beforeSeq` — the start of the window the model already
 * sees — so it never repeats what is in context. Same rule as search: Qdrant
 * picks the ids, Postgres supplies the text after checking the owner.
 */
const RECALL_LIMIT = 4;

// Stricter than search: these go into the prompt, so a weak match costs tokens
// and can mislead the model.
const RECALL_MIN_SIMILARITY = 0.4;

async function recall(conversationId, auth, question, beforeSeq) {
  const vector = await embedOne(question);

  const points = await vectorStore.search(vectorStore.COLLECTIONS.messages, {
    vector,
    filter: {
      must: [
        { key: "organization_id", match: { value: auth.organizationId } },
        { key: "user_id", match: { value: auth.userId } },
        { key: "conversation_id", match: { value: conversationId } },
        { key: "seq", range: { lt: beforeSeq } },
      ],
    },
    limit: RECALL_LIMIT,
    scoreThreshold: RECALL_MIN_SIMILARITY,
  });

  if (points.length === 0) {
    return [];
  }

  const { rows } = await pool.query(
    `SELECT m.seq, m.role, m.content
       FROM assistant_messages m
       JOIN assistant_conversations c ON c.id = m.conversation_id
      WHERE m.id = ANY($1::bigint[])
        AND c.id = $2
        AND c.organization_id = $3
        AND c.user_id = $4
        AND c.deleted_at IS NULL
      ORDER BY m.seq`,
    [points.map((point) => point.id), conversationId, auth.organizationId, auth.userId],
  );

  return rows;
}

module.exports = { searchConversations, recall };
