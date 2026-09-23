const express = require("express");

const authenticate = require("../middleware/authenticate");
const { handleMcpRequest } = require("../mcp/server");

const router = express.Router();

/*
 * MCP over HTTP. Authenticated with the same JWT the rest of the product uses,
 * so an external client authenticates by logging in and passing its token.
 */
router.post("/mcp", authenticate, async (req, res) => {
  try {
    await handleMcpRequest(req, res);
  } catch (error) {
    console.error("[MCP] Request failed:", error);

    if (!res.headersSent) {
      res.status(500).json({ error: "MCP request failed" });
    }
  }
});

module.exports = router;
