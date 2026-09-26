const express = require("express");

const authenticate = require("../middleware/authenticate");
const controller = require("../controllers/chatController");

const router = express.Router();

/*
 * No requirePermission: the assistant itself is open to anyone signed in. What
 * it can actually do is decided per-tool from req.auth.permissions, so someone
 * with nothing granted gets an assistant that can only talk.
 *
 * Conversations themselves live in conversationRoutes.
 */
router.get("/assistant/capabilities", authenticate, controller.capabilities);

module.exports = router;
