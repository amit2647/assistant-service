const express = require("express");

const authenticate = require("../middleware/authenticate");
const controller = require("../controllers/conversationController");

const router = express.Router();

/*
 * No requirePermission, as with the rest of the assistant: anyone signed in
 * has their own conversations. Every query underneath is scoped to the
 * caller's organization and user, and what a turn may do is decided per tool.
 */
router.get("/assistant/conversations", authenticate, controller.list);

router.get("/assistant/conversations/search", authenticate, controller.search);

router.get("/assistant/conversations/:id/messages", authenticate, controller.messages);

router.post("/assistant/conversations/:id/messages", authenticate, controller.sendMessage);

router.post(
  "/assistant/conversations/:id/actions/:actionId/confirm",
  authenticate,
  controller.confirmAction,
);

router.post(
  "/assistant/conversations/:id/actions/:actionId/cancel",
  authenticate,
  controller.cancelAction,
);

router.patch("/assistant/conversations/:id", authenticate, controller.rename);

router.delete("/assistant/conversations/:id", authenticate, controller.remove);

module.exports = router;
