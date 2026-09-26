const { pool } = require("../config/database");
const { embed, MODEL } = require("./embedder");
const vectorStore = require("./vectorStore");
const { syncKnowledge } = require("./knowledgeService");

/*
 * Drains the outbox (migration 012) into Qdrant.
 *
 * Postgres and Qdrant share no transaction, so a message is never written to
 * both at once. It is committed to Postgres with embed_status = 'pending', and
 * this loop moves it across afterwards:
 *
 *   claim (FOR UPDATE SKIP LOCKED) → embed → upsert with wait=true → mark done
 *
 * all inside one Postgres transaction. If Qdrant or the model fails, the
 * transaction rolls back and the rows are simply still pending next time. Any
 * number of replicas can run this: SKIP LOCKED hands each a different batch,
 * and the point id is the message id, so a repeat is an overwrite rather than
 * a duplicate.
 */

const BATCH = 32;
const IDLE_MS = 2000;
const MAX_BACKOFF_MS = 30000;

// Only prose is indexed. Tool results are raw CRM data under permissions that
// can be revoked; a vector copy of them would outlive the revocation.
const EMBEDDABLE = new Set(["user", "assistant"]);

async function inTransaction(work) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await work(client);

    await client.query("COMMIT");

    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function drainMessages() {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT m.id, m.conversation_id, m.organization_id, m.seq, m.role,
              m.content, c.user_id, c.deleted_at
         FROM assistant_messages m
         JOIN assistant_conversations c ON c.id = m.conversation_id
        WHERE m.embed_status = 'pending'
        ORDER BY m.id
        LIMIT $1
        FOR UPDATE OF m SKIP LOCKED`,
      [BATCH],
    );

    if (rows.length === 0) {
      return 0;
    }

    const wanted = rows.filter(
      (row) => EMBEDDABLE.has(row.role) && row.content.trim() && !row.deleted_at,
    );
    const skipped = rows.filter((row) => !wanted.includes(row));

    if (wanted.length > 0) {
      const vectors = await embed(wanted.map((row) => row.content));

      await vectorStore.upsert(
        vectorStore.COLLECTIONS.messages,
        wanted.map((row, index) => ({
          id: Number(row.id),
          vector: vectors[index],
          payload: {
            organization_id: row.organization_id,
            user_id: row.user_id,
            conversation_id: row.conversation_id,
            seq: row.seq,
            role: row.role,
            embedding_model: MODEL,
          },
        })),
      );

      await client.query(
        `UPDATE assistant_messages SET embed_status = 'done' WHERE id = ANY($1::bigint[])`,
        [wanted.map((row) => row.id)],
      );
    }

    if (skipped.length > 0) {
      await client.query(
        `UPDATE assistant_messages SET embed_status = 'skipped' WHERE id = ANY($1::bigint[])`,
        [skipped.map((row) => row.id)],
      );
    }

    return rows.length;
  });
}

/*
 * Deleted conversations: remove their points. Search already hides them — each
 * hit is re-checked against deleted_at in Postgres — so this is about not
 * keeping data that was asked to be removed, not about correctness.
 */
async function purgeDeleted() {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id
         FROM assistant_conversations
        WHERE deleted_at IS NOT NULL
          AND vectors_purged_at IS NULL
        LIMIT 20
        FOR UPDATE SKIP LOCKED`,
    );

    for (const row of rows) {
      await vectorStore.deleteWhere(
        vectorStore.COLLECTIONS.messages,
        vectorStore.matchAll({ conversation_id: row.id }),
      );
    }

    if (rows.length > 0) {
      await client.query(
        `UPDATE assistant_conversations
            SET vectors_purged_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [rows.map((row) => row.id)],
      );
    }

    return rows.length;
  });
}

function start() {
  let backoff = IDLE_MS;
  let failing = false;

  // Product help is indexed once per process start, on the first tick that
  // reaches Qdrant; unchanged sections are skipped, so this is cheap.
  let knowledgeSynced = false;

  async function tick() {
    let delay = IDLE_MS;

    try {
      await vectorStore.ensureCollections();

      if (!knowledgeSynced) {
        const { chunks, embedded } = await syncKnowledge();

        console.log(`[Embeddings] Product help ready: ${chunks} sections, ${embedded} re-embedded.`);
        knowledgeSynced = true;
      }

      const drained = await drainMessages();
      await purgeDeleted();

      if (failing) {
        console.log("[Embeddings] Recovered; indexing resumed.");
        failing = false;
      }

      backoff = IDLE_MS;

      // A full batch means more is waiting: go again straight away.
      delay = drained === BATCH ? 0 : IDLE_MS;
    } catch (error) {
      // Logged once per outage rather than every tick.
      if (!failing) {
        console.error("[Embeddings] Indexing paused:", error.message);
        failing = true;
      }

      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      delay = backoff;
    }

    setTimeout(tick, delay).unref();
  }

  setTimeout(tick, IDLE_MS).unref();
}

module.exports = { start };
