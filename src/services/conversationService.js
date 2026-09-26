const crypto = require("crypto");

const { pool } = require("../config/database");

/*
 * Durable conversations.
 *
 * Every write here is a short transaction — milliseconds — and none of them
 * spans a model call, which takes seconds and would pin a pooled connection
 * for the whole time. A turn is therefore three steps: begin (lease + user
 * message), the model with no transaction open, and complete (everything the
 * model produced, in one commit).
 *
 * Every query is scoped by organization and user. A conversation that belongs
 * to someone else is indistinguishable from one that does not exist.
 */

/*
 * How long a turn may hold its conversation. Longer than any turn the chat
 * service allows itself (see TURN_BUDGET_MS there), so a live turn is never
 * taken over; short enough that a crashed one frees the thread quickly.
 */
const LEASE_SECONDS = 300;

// How much of the thread is replayed to the model each turn.
const CONTEXT_MESSAGES = 40;
const CONTEXT_CHARS = 8000;

const TITLE_LENGTH = 80;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function withTransaction(work) {
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

function titleFrom(content) {
  const line = content.replace(/\s+/g, " ").trim();

  return line.length > TITLE_LENGTH
    ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…`
    : line;
}

/*
 * Locks the caller's conversation row for the rest of the transaction. This is
 * what serialises everything that assigns a sequence number or touches the
 * lease.
 */
async function lockConversation(client, conversationId, auth) {
  const result = await client.query(
    `SELECT *
       FROM assistant_conversations
      WHERE id = $1
        AND organization_id = $2
        AND user_id = $3
        AND deleted_at IS NULL
      FOR UPDATE`,
    [conversationId, auth.organizationId, auth.userId],
  );

  if (!result.rows[0]) {
    throw httpError(404, "Conversation not found");
  }

  return result.rows[0];
}

function leaseHeld(conversation) {
  if (!conversation.active_turn_id || !conversation.turn_started_at) {
    return false;
  }

  const age = Date.now() - new Date(conversation.turn_started_at).getTime();

  return age < LEASE_SECONDS * 1000;
}

/*
 * Appends messages at the next sequence numbers. The caller must hold the row
 * lock; UNIQUE (conversation_id, seq) is the backstop if that is ever wrong.
 */
async function appendMessages(client, conversation, messages) {
  let seq = conversation.message_count;

  const inserted = [];

  for (const message of messages) {
    seq += 1;

    const result = await client.query(
      `INSERT INTO assistant_messages
         (conversation_id, organization_id, seq, role, content, tool_calls,
          tool_call_id, client_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        conversation.id,
        conversation.organization_id,
        seq,
        message.role,
        message.content || "",
        message.tool_calls ? JSON.stringify(message.tool_calls) : null,
        message.tool_call_id || null,
        message.client_message_id || null,
      ],
    );

    inserted.push(result.rows[0]);
  }

  if (inserted.length > 0) {
    await client.query(
      `UPDATE assistant_conversations
          SET message_count = $2,
              last_message_at = NOW()
        WHERE id = $1`,
      [conversation.id, seq],
    );
  }

  conversation.message_count = seq;

  return inserted;
}

/*
 * Settles pending actions nobody will decide any more, writing a tool result
 * for each so the model's call is never left unanswered in the thread.
 *
 * - `pending` past its expiry: nothing ran, say so.
 * - `executing` past the lease: the process died mid-write. Whether the write
 *   landed is unknown, and it is not retried — at most once beats at least
 *   once when the action is "send an email".
 */
async function settleStaleActions(client, conversation) {
  const expired = await client.query(
    `UPDATE assistant_pending_actions
        SET status = 'expired', decided_at = NOW()
      WHERE conversation_id = $1
        AND status = 'pending'
        AND expires_at <= NOW()
      RETURNING tool_call_id`,
    [conversation.id],
  );

  const unknown = await client.query(
    `UPDATE assistant_pending_actions
        SET status = 'unknown', decided_at = NOW()
      WHERE conversation_id = $1
        AND status = 'executing'
        AND decided_at <= NOW() - make_interval(secs => $2)
      RETURNING tool_call_id`,
    [conversation.id, LEASE_SECONDS],
  );

  const results = [
    ...expired.rows.map((row) => ({
      role: "tool",
      tool_call_id: row.tool_call_id,
      content: JSON.stringify({
        error: "The user did not confirm this in time. Nothing was done.",
      }),
    })),
    ...unknown.rows.map((row) => ({
      role: "tool",
      tool_call_id: row.tool_call_id,
      content: JSON.stringify({
        error:
          "This action was interrupted. It may or may not have happened — check before trying again.",
      }),
    })),
  ];

  await appendMessages(client, conversation, results);
}

async function openAction(client, conversationId) {
  const result = await client.query(
    `SELECT *
       FROM assistant_pending_actions
      WHERE conversation_id = $1
        AND status IN ('pending', 'executing')`,
    [conversationId],
  );

  return result.rows[0] || null;
}

async function takeLease(client, conversation) {
  if (leaseHeld(conversation)) {
    throw httpError(409, "The assistant is still answering in this conversation.");
  }

  const turnId = crypto.randomUUID();

  await client.query(
    `UPDATE assistant_conversations
        SET active_turn_id = $2, turn_started_at = NOW()
      WHERE id = $1`,
    [conversation.id, turnId],
  );

  return turnId;
}

/*
 * Step one of a turn.
 *
 * Creates the conversation if this is its first message (the id is the
 * client's, so a retried first send finds the row instead of making another),
 * then either records the user message or recognises a retry of one.
 *
 * Returns { turnId } when the caller should run the model, or { replay } when
 * this exact message was already answered and the stored answer should be
 * returned instead — never a second model call for the same message.
 */
async function beginTurn({ conversationId, auth, clientMessageId, content }) {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO assistant_conversations (id, organization_id, user_id, title)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [conversationId, auth.organizationId, auth.userId, titleFrom(content)],
    );

    const conversation = await lockConversation(client, conversationId, auth);

    const existing = await client.query(
      `SELECT *
         FROM assistant_messages
        WHERE conversation_id = $1
          AND client_message_id = $2`,
      [conversationId, clientMessageId],
    );

    const previous = existing.rows[0];

    if (previous && previous.status === "ok") {
      if (leaseHeld(conversation)) {
        throw httpError(409, "The assistant is still answering this message.");
      }

      return { replay: previous.seq };
    }

    await settleStaleActions(client, conversation);

    if (await openAction(client, conversationId)) {
      throw httpError(409, "Confirm or cancel the pending change first.");
    }

    const turnId = await takeLease(client, conversation);

    if (previous) {
      // A retry of a message whose turn failed: answer it this time, without
      // recording the question twice.
      await client.query(
        `UPDATE assistant_messages SET status = 'ok' WHERE id = $1`,
        [previous.id],
      );

      return { turnId, userSeq: previous.seq };
    }

    const [message] = await appendMessages(client, conversation, [
      { role: "user", content, client_message_id: clientMessageId },
    ]);

    return { turnId, userSeq: message.seq };
  });
}

/*
 * Step three: everything the model produced, committed together, and the
 * lease released. Refuses if the lease was lost — a turn that ran past it and
 * was superseded must not write a stale answer into the thread.
 */
async function completeTurn({ conversationId, auth, turnId, produced, pendingAction }) {
  return withTransaction(async (client) => {
    const conversation = await lockConversation(client, conversationId, auth);

    if (conversation.active_turn_id !== turnId) {
      throw httpError(409, "This reply was superseded.");
    }

    await appendMessages(client, conversation, produced);

    if (pendingAction) {
      await client.query(
        `INSERT INTO assistant_pending_actions
           (conversation_id, organization_id, user_id, tool_call_id, tool_name,
            arguments, summary, destructive)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          conversationId,
          auth.organizationId,
          auth.userId,
          pendingAction.toolCallId,
          pendingAction.name,
          JSON.stringify(pendingAction.arguments || {}),
          pendingAction.summary,
          Boolean(pendingAction.destructive),
        ],
      );
    }

    await client.query(
      `UPDATE assistant_conversations
          SET active_turn_id = NULL, turn_started_at = NULL
        WHERE id = $1`,
      [conversationId],
    );
  });
}

/*
 * The model call failed. The question stays in the thread, marked failed so
 * the UI offers a retry, and the lease is released — only if it is still ours.
 */
async function failTurn({ conversationId, auth, turnId, userSeq }) {
  return withTransaction(async (client) => {
    const conversation = await lockConversation(client, conversationId, auth);

    if (conversation.active_turn_id !== turnId) {
      return;
    }

    if (userSeq) {
      await client.query(
        `UPDATE assistant_messages
            SET status = 'failed'
          WHERE conversation_id = $1 AND seq = $2 AND role = 'user'`,
        [conversationId, userSeq],
      );
    }

    await client.query(
      `UPDATE assistant_conversations
          SET active_turn_id = NULL, turn_started_at = NULL
        WHERE id = $1`,
      [conversationId],
    );
  });
}

/*
 * Claims a pending write for execution, and the conversation's lease with it.
 *
 * The status transition pending → executing is the whole defence against a
 * double-clicked Confirm: the second request finds no row in 'pending' and
 * gets a 409, so the write runs at most once.
 */
async function claimAction({ conversationId, actionId, auth }) {
  return withTransaction(async (client) => {
    const conversation = await lockConversation(client, conversationId, auth);

    await settleStaleActions(client, conversation);

    const claimed = await client.query(
      `UPDATE assistant_pending_actions
          SET status = 'executing', decided_at = NOW()
        WHERE id = $1
          AND conversation_id = $2
          AND user_id = $3
          AND status = 'pending'
          AND expires_at > NOW()
        RETURNING *`,
      [actionId, conversationId, auth.userId],
    );

    const action = claimed.rows[0];

    if (!action) {
      throw httpError(409, "That change has already been decided, or has expired.");
    }

    const turnId = await takeLease(client, conversation);

    return { action, turnId };
  });
}

/*
 * Records the outcome of an executed write straight away, in its own
 * transaction, so it is durable even if the follow-up model call then fails.
 */
async function recordActionResult({ conversationId, auth, turnId, action, content, ok }) {
  return withTransaction(async (client) => {
    const conversation = await lockConversation(client, conversationId, auth);

    if (conversation.active_turn_id !== turnId) {
      throw httpError(409, "This reply was superseded.");
    }

    await client.query(
      `UPDATE assistant_pending_actions
          SET status = 'done', result = $2
        WHERE id = $1`,
      [action.id, JSON.stringify({ ok, content })],
    );

    await appendMessages(client, conversation, [
      { role: "tool", tool_call_id: action.tool_call_id, content },
    ]);

    // Where the model's follow-up will start.
    return conversation.message_count + 1;
  });
}

/*
 * Cancelling is a decision too: the model's call gets an answer, so the next
 * turn knows the change did not happen.
 */
async function cancelAction({ conversationId, actionId, auth }) {
  return withTransaction(async (client) => {
    const conversation = await lockConversation(client, conversationId, auth);

    const cancelled = await client.query(
      `UPDATE assistant_pending_actions
          SET status = 'cancelled', decided_at = NOW()
        WHERE id = $1
          AND conversation_id = $2
          AND user_id = $3
          AND status = 'pending'
        RETURNING *`,
      [actionId, conversationId, auth.userId],
    );

    const action = cancelled.rows[0];

    if (!action) {
      throw httpError(409, "That change has already been decided, or has expired.");
    }

    // The note is stored rather than added by the client, so it is still in
    // the thread after a reload.
    const inserted = await appendMessages(client, conversation, [
      {
        role: "tool",
        tool_call_id: action.tool_call_id,
        content: JSON.stringify({
          error: "The user cancelled this. Nothing was done.",
        }),
      },
      { role: "assistant", content: "Cancelled — nothing was changed." },
    ]);

    return inserted.filter((row) => row.role === "assistant").map(toDisplay);
  });
}

/*
 * The model's view of the thread: the most recent messages within a budget,
 * with every tool call and result checked against what the caller may do
 * *now*. A revoked permission withdraws the data it produced, not just future
 * calls. Calls with no result in the window — cut off by the window, or a
 * write still awaiting a decision — are dropped, since the provider rejects a
 * call with no answer.
 */
async function loadContext(conversationId, auth, allowedTools) {
  const result = await pool.query(
    `SELECT seq, role, content, tool_calls, tool_call_id
       FROM assistant_messages
      WHERE conversation_id = $1
        AND organization_id = $2
      ORDER BY seq DESC
      LIMIT $3`,
    [conversationId, auth.organizationId, CONTEXT_MESSAGES],
  );

  const rows = result.rows.reverse();

  const answered = new Set(
    rows.filter((row) => row.role === "tool").map((row) => row.tool_call_id),
  );

  const kept = new Set();
  const messages = [];

  for (const row of rows) {
    if (row.role === "user") {
      messages.push({ role: "user", content: row.content.slice(0, CONTEXT_CHARS) });
      continue;
    }

    if (row.role === "assistant") {
      const calls = (row.tool_calls || []).filter(
        (call) => answered.has(call.id) && allowedTools.has(call.function?.name),
      );

      calls.forEach((call) => kept.add(call.id));

      if (calls.length > 0) {
        messages.push({ role: "assistant", content: row.content || "", tool_calls: calls });
      } else if (row.content) {
        messages.push({ role: "assistant", content: row.content.slice(0, CONTEXT_CHARS) });
      }

      continue;
    }

    if (kept.has(row.tool_call_id)) {
      messages.push({
        role: "tool",
        tool_call_id: row.tool_call_id,
        content: row.content.slice(0, CONTEXT_CHARS),
      });
    }
  }

  // A window that starts mid-exchange would open on an orphaned result.
  while (messages.length > 0 && messages[0].role !== "user") {
    messages.shift();
  }

  /*
   * windowStart is the first seq the model will see. Anything before it is
   * reachable only through recall; when the whole thread fits, there is
   * nothing to recall and it is null.
   */
  // User messages are always kept, so the window opens on the first of them;
  // anything trimmed before it counts as older and stays reachable by recall.
  const whole = rows.length < CONTEXT_MESSAGES;
  const firstUser = rows.find((row) => row.role === "user");

  return { messages, windowStart: whole ? null : firstUser?.seq ?? null };
}

function toDisplay(row) {
  return {
    id: String(row.id),
    seq: row.seq,
    role: row.role,
    content: row.content,
    status: row.status,
    clientMessageId: row.client_message_id,
    createdAt: row.created_at,
  };
}

function toAction(row) {
  return row
    ? {
        id: row.id,
        name: row.tool_name,
        summary: row.summary,
        destructive: row.destructive,
        status: row.status,
      }
    : null;
}

function toConversation(row) {
  return {
    id: row.id,
    title: row.title,
    messageCount: row.message_count,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
  };
}

// Only what a person reads: questions and prose answers, never tool traffic.
const DISPLAY_FILTER = `role IN ('user', 'assistant') AND content <> ''`;

/*
 * Visible messages from `fromSeq` on — what a turn (or a replay of one)
 * returns to the client.
 */
async function messagesSince(conversationId, auth, fromSeq) {
  const result = await pool.query(
    `SELECT *
       FROM assistant_messages
      WHERE conversation_id = $1
        AND organization_id = $2
        AND seq >= $3
        AND ${DISPLAY_FILTER}
      ORDER BY seq`,
    [conversationId, auth.organizationId, fromSeq],
  );

  return result.rows.map(toDisplay);
}

async function pendingActionFor(conversationId, auth) {
  const result = await pool.query(
    `SELECT *
       FROM assistant_pending_actions
      WHERE conversation_id = $1
        AND user_id = $2
        AND status = 'pending'
        AND expires_at > NOW()`,
    [conversationId, auth.userId],
  );

  return toAction(result.rows[0]);
}

async function getConversation(conversationId, auth) {
  const result = await pool.query(
    `SELECT *
       FROM assistant_conversations
      WHERE id = $1
        AND organization_id = $2
        AND user_id = $3
        AND deleted_at IS NULL`,
    [conversationId, auth.organizationId, auth.userId],
  );

  if (!result.rows[0]) {
    throw httpError(404, "Conversation not found");
  }

  return result.rows[0];
}

/*
 * One page of a thread, newest page first, paged by keyset on seq so a long
 * thread costs the same to open as a short one.
 */
async function listMessages(conversationId, auth, { before, limit }) {
  const conversation = await getConversation(conversationId, auth);

  const result = await pool.query(
    `SELECT *
       FROM assistant_messages
      WHERE conversation_id = $1
        AND organization_id = $2
        AND ($3::int IS NULL OR seq < $3)
        AND ${DISPLAY_FILTER}
      ORDER BY seq DESC
      LIMIT $4`,
    [conversationId, auth.organizationId, before ?? null, limit + 1],
  );

  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit).reverse();

  return {
    conversation: toConversation(conversation),
    messages: rows.map(toDisplay),
    hasMore,
    pendingAction: await pendingActionFor(conversationId, auth),
  };
}

/*
 * The caller's conversations, most recent first, paged by keyset on
 * (last_message_at, id) — stable while new messages arrive, unlike OFFSET.
 */
async function listConversations(auth, { cursor, limit }) {
  let after = null;

  if (cursor) {
    const [at, id] = String(cursor).split("|");

    if (at && isUuid(id) && !Number.isNaN(Date.parse(at))) {
      after = { at, id };
    }
  }

  const result = await pool.query(
    `SELECT *
       FROM assistant_conversations
      WHERE organization_id = $1
        AND user_id = $2
        AND deleted_at IS NULL
        AND ($3::timestamptz IS NULL OR (last_message_at, id) < ($3::timestamptz, $4::uuid))
      ORDER BY last_message_at DESC, id DESC
      LIMIT $5`,
    [auth.organizationId, auth.userId, after?.at ?? null, after?.id ?? null, limit + 1],
  );

  const rows = result.rows.slice(0, limit);
  const last = rows[rows.length - 1];

  return {
    conversations: rows.map(toConversation),
    nextCursor:
      result.rows.length > limit && last
        ? `${last.last_message_at.toISOString()}|${last.id}`
        : null,
  };
}

async function renameConversation(conversationId, auth, title) {
  const result = await pool.query(
    `UPDATE assistant_conversations
        SET title = $4
      WHERE id = $1
        AND organization_id = $2
        AND user_id = $3
        AND deleted_at IS NULL
      RETURNING *`,
    [conversationId, auth.organizationId, auth.userId, titleFrom(title)],
  );

  if (!result.rows[0]) {
    throw httpError(404, "Conversation not found");
  }

  return toConversation(result.rows[0]);
}

/*
 * Soft delete: gone from the list and from every read at once. Rows are
 * removed later by a retention job rather than inline.
 */
async function deleteConversation(conversationId, auth) {
  const result = await pool.query(
    `UPDATE assistant_conversations
        SET deleted_at = NOW()
      WHERE id = $1
        AND organization_id = $2
        AND user_id = $3
        AND deleted_at IS NULL`,
    [conversationId, auth.organizationId, auth.userId],
  );

  if (result.rowCount === 0) {
    throw httpError(404, "Conversation not found");
  }
}

module.exports = {
  isUuid,
  httpError,
  beginTurn,
  completeTurn,
  failTurn,
  claimAction,
  recordActionResult,
  cancelAction,
  loadContext,
  messagesSince,
  pendingActionFor,
  listMessages,
  listConversations,
  renameConversation,
  deleteConversation,
};
