const conversations = require("../services/conversationService");
const { runTurn, executeAction } = require("../services/chatService");
const { toolsFor } = require("../services/toolCatalog");
const { searchConversations, recall } = require("../services/searchService");

const MAX_MESSAGE_CHARS = 8000;

function bearer(req) {
  return (req.headers.authorization || "").split(" ")[1];
}

function allowedTools(auth) {
  return new Set(toolsFor(auth.permissions).map((tool) => tool.name));
}

function clampLimit(value, fallback, max) {
  const number = Number(value);

  return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}

function fail(res, error, fallbackMessage) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ error: error.message });
  }

  console.error(`[Assistant] ${fallbackMessage}:`, error.message);

  return res.status(500).json({ error: fallbackMessage });
}

// Rejects a malformed id up front; Postgres would otherwise throw on the cast.
function requireConversationId(req, res) {
  if (!conversations.isUuid(req.params.id)) {
    res.status(404).json({ error: "Conversation not found" });
    return null;
  }

  return req.params.id;
}

/*
 * Best effort: recall improves long threads but is never worth failing a turn
 * over, so Qdrant or the model being unavailable just means no recall.
 */
async function recallOlder(conversationId, auth, history, windowStart) {
  if (!windowStart) {
    return [];
  }

  const question = [...history].reverse().find((message) => message.role === "user");

  if (!question) {
    return [];
  }

  try {
    return await recall(conversationId, auth, question.content, windowStart);
  } catch (error) {
    console.error("[Assistant] Recall skipped:", error.message);
    return [];
  }
}

/*
 * Runs the model over the stored thread and commits what it produced, or marks
 * the turn failed. Shared by a new message and by a confirmed action, which
 * both end the same way: the model gets to say something about what happened.
 */
async function answer({ req, conversationId, turnId, userSeq, fromSeq, emptyReply }) {
  const auth = req.auth;

  try {
    const { messages: history, windowStart } = await conversations.loadContext(
      conversationId,
      auth,
      allowedTools(auth),
    );

    const recalled = await recallOlder(conversationId, auth, history, windowStart);

    const { produced, pendingAction } = await runTurn({
      auth,
      token: bearer(req),
      history,
      emptyReply,
      recalled,
    });

    await conversations.completeTurn({
      conversationId,
      auth,
      turnId,
      produced,
      pendingAction,
    });
  } catch (error) {
    await conversations
      .failTurn({ conversationId, auth, turnId, userSeq })
      .catch((releaseError) =>
        console.error("[Assistant] Could not release a failed turn:", releaseError.message),
      );

    throw error;
  }

  return {
    messages: await conversations.messagesSince(conversationId, auth, fromSeq),
    pendingAction: await conversations.pendingActionFor(conversationId, auth),
  };
}

/*
 * POST /assistant/conversations/:id/messages  { clientMessageId, content }
 *
 * The conversation id and the message id are both the client's, so a retried
 * request — double submit, network blip, a second tab — lands on the same rows
 * and gets the stored answer back instead of a second model call.
 */
async function sendMessage(req, res) {
  const conversationId = requireConversationId(req, res);

  if (!conversationId) {
    return undefined;
  }

  const clientMessageId = req.body?.clientMessageId;
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";

  if (!conversations.isUuid(clientMessageId)) {
    return res.status(400).json({ error: "clientMessageId must be a UUID" });
  }

  if (!content) {
    return res.status(400).json({ error: "A message is required" });
  }

  if (content.length > MAX_MESSAGE_CHARS) {
    return res.status(400).json({ error: "That message is too long" });
  }

  try {
    const begun = await conversations.beginTurn({
      conversationId,
      auth: req.auth,
      clientMessageId,
      content,
    });

    if (begun.replay) {
      return res.json({
        replayed: true,
        messages: await conversations.messagesSince(conversationId, req.auth, begun.replay),
        pendingAction: await conversations.pendingActionFor(conversationId, req.auth),
      });
    }

    const result = await answer({
      req,
      conversationId,
      turnId: begun.turnId,
      userSeq: begun.userSeq,
      fromSeq: begun.userSeq,
    });

    return res.json(result);
  } catch (error) {
    return fail(res, error, "The assistant could not answer");
  }
}

/*
 * POST /assistant/conversations/:id/actions/:actionId/confirm
 *
 * Takes no body: what runs is the stored proposal, never arguments sent back
 * by the client.
 */
async function confirmAction(req, res) {
  const conversationId = requireConversationId(req, res);

  if (!conversationId) {
    return undefined;
  }

  if (!conversations.isUuid(req.params.actionId)) {
    return res.status(404).json({ error: "Action not found" });
  }

  try {
    const { action, turnId } = await conversations.claimAction({
      conversationId,
      actionId: req.params.actionId,
      auth: req.auth,
    });

    let outcome;

    try {
      outcome = await executeAction({ auth: req.auth, token: bearer(req), action });
    } catch (error) {
      // The request to the owning service failed outright. Whether the write
      // landed is not known, so it is recorded as such rather than retried.
      outcome = {
        ok: false,
        content: JSON.stringify({
          error: "The change could not be confirmed as done. Check before trying again.",
        }),
      };
      console.error("[Assistant] Confirmed action failed:", error.message);
    }

    const fromSeq = await conversations.recordActionResult({
      conversationId,
      auth: req.auth,
      turnId,
      action,
      content: outcome.content,
      ok: outcome.ok,
    });

    const result = await answer({
      req,
      conversationId,
      turnId,
      userSeq: null,
      fromSeq,
      emptyReply: outcome.ok
        ? `Done — ${action.summary.replace(/\.$/, "")}.`
        : "That change did not go through.",
    });

    return res.json(result);
  } catch (error) {
    return fail(res, error, "The assistant could not complete that");
  }
}

async function cancelAction(req, res) {
  const conversationId = requireConversationId(req, res);

  if (!conversationId) {
    return undefined;
  }

  if (!conversations.isUuid(req.params.actionId)) {
    return res.status(404).json({ error: "Action not found" });
  }

  try {
    const messages = await conversations.cancelAction({
      conversationId,
      actionId: req.params.actionId,
      auth: req.auth,
    });

    return res.json({ messages, pendingAction: null });
  } catch (error) {
    return fail(res, error, "Could not cancel that change");
  }
}

async function list(req, res) {
  try {
    const result = await conversations.listConversations(req.auth, {
      cursor: req.query.cursor,
      limit: clampLimit(req.query.limit, 20, 50),
    });

    return res.json(result);
  } catch (error) {
    return fail(res, error, "Could not load conversations");
  }
}

async function messages(req, res) {
  const conversationId = requireConversationId(req, res);

  if (!conversationId) {
    return undefined;
  }

  const before = req.query.before === undefined ? null : Number(req.query.before);

  try {
    const result = await conversations.listMessages(conversationId, req.auth, {
      before: Number.isInteger(before) ? before : null,
      limit: clampLimit(req.query.limit, 50, 100),
    });

    return res.json(result);
  } catch (error) {
    return fail(res, error, "Could not load the conversation");
  }
}

async function rename(req, res) {
  const conversationId = requireConversationId(req, res);

  if (!conversationId) {
    return undefined;
  }

  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";

  if (!title) {
    return res.status(400).json({ error: "A title is required" });
  }

  try {
    return res.json(await conversations.renameConversation(conversationId, req.auth, title));
  } catch (error) {
    return fail(res, error, "Could not rename the conversation");
  }
}

async function remove(req, res) {
  const conversationId = requireConversationId(req, res);

  if (!conversationId) {
    return undefined;
  }

  try {
    await conversations.deleteConversation(conversationId, req.auth);

    return res.status(204).end();
  } catch (error) {
    return fail(res, error, "Could not delete the conversation");
  }
}

/*
 * GET /assistant/conversations/search?q=
 *
 * Only the caller's own conversations, by meaning and by words.
 */
async function search(req, res) {
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";

  if (!query) {
    return res.json({ results: [] });
  }

  try {
    return res.json({ results: await searchConversations(req.auth, query) });
  } catch (error) {
    return fail(res, error, "Search is unavailable");
  }
}

module.exports = {
  search,
  sendMessage,
  confirmAction,
  cancelAction,
  list,
  messages,
  rename,
  remove,
};
