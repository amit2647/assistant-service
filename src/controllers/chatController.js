const { runTurn, MODEL } = require("../services/chatService");
const { toolsFor } = require("../services/toolCatalog");

const MAX_HISTORY = 40;

/*
 * Only the roles the model produced are accepted back. A client could otherwise
 * post a "system" message and rewrite the guard rails for its own turn.
 */
const ALLOWED_ROLES = new Set(["user", "assistant"]);

function sanitizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter(
      (message) =>
        message &&
        ALLOWED_ROLES.has(message.role) &&
        typeof message.content === "string" &&
        message.content.trim(),
    )
    .slice(-MAX_HISTORY)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 8000),
    }));
}

async function chat(req, res) {
  try {
    const history = sanitizeHistory(req.body?.messages);
    const confirm = req.body?.confirm || null;

    if (history.length === 0 && !confirm) {
      return res.status(400).json({ error: "A message is required" });
    }

    const token = (req.headers.authorization || "").split(" ")[1];

    const result = await runTurn({
      auth: req.auth,
      token,
      history,
      confirm,
    });

    return res.json(result);
  } catch (error) {
    console.error("[Assistant] Turn failed:", error.message);

    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "The assistant could not answer.",
    });
  }
}

/*
 * What this user can do, for the panel's empty state. Deliberately the same
 * filtered list the model gets, so the suggestions never advertise something
 * the assistant would then refuse.
 */
function capabilities(req, res) {
  const tools = toolsFor(req.auth?.permissions);

  return res.json({
    model: MODEL,
    configured: Boolean(process.env.OPENROUTER_API_KEY),
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      write: Boolean(tool.write),
    })),
  });
}

module.exports = { chat, capabilities };
