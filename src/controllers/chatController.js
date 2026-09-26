const { MODEL } = require("../services/chatService");
const { toolsFor } = require("../services/toolCatalog");

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

module.exports = { capabilities };
