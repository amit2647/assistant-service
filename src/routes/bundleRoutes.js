const express = require("express");

const authenticate = require("../middleware/authenticate");
const requirePermission = require("../middleware/requirePermission");
const { installBundleHelp } = require("../services/knowledgeService");

const router = express.Router();

/*
 * The help step of a bundle install: the bundle's help docs, indexed for
 * search_help and offered only to organizations that installed the bundle.
 */
const KEY = /^[a-z][a-z0-9-]{1,59}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

router.put("/assistant/bundles/:key/:version", authenticate, requirePermission("bundles.manage"), async (req, res) => {
  const help = req.body?.help;

  if (!KEY.test(req.params.key) || !VERSION.test(req.params.version)) {
    return res.status(400).json({ error: "Invalid bundle key or version" });
  }

  if (!Array.isArray(help) || help.some((doc) => !doc || typeof doc.path !== "string" || typeof doc.body !== "string")) {
    return res.status(400).json({ error: "help must be a list of { path, title, permission, body }" });
  }

  try {
    return res.json(await installBundleHelp(req.params.key, help));
  } catch (error) {
    console.error("[Assistant] bundle help install failed:", error);
    return res.status(502).json({ error: "The help index could not be updated" });
  }
});

module.exports = router;
