const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/*
 * What the model is shown of a stored conversation. Tool calls and results
 * are replayed only if the caller may still use that tool now, and calls
 * without a result are dropped (the provider rejects them).
 */

const database = require("../src/config/database");

let rows;

// loadContext reads newest-first with a LIMIT (its third parameter); the fake
// honours both.
database.pool.query = async (text, params) => ({ rows: [...rows].reverse().slice(0, params[2]) });

const { loadContext } = require("../src/services/conversationService");

const auth = { userId: 1, organizationId: 1 };

function call(id, name) {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

beforeEach(() => {
  rows = [
    { seq: 1, role: "user", content: "list my leads", tool_calls: null, tool_call_id: null },
    { seq: 2, role: "assistant", content: "", tool_calls: [call("a", "list_leads")], tool_call_id: null },
    { seq: 3, role: "tool", content: "[{\"id\":1}]", tool_calls: null, tool_call_id: "a" },
    { seq: 4, role: "assistant", content: "You have one lead.", tool_calls: null, tool_call_id: null },
  ];
});

test("replays calls and results the caller may still use", async () => {
  const { messages } = await loadContext("c", auth, new Set(["list_leads"]));

  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "tool", "assistant"],
  );
});

test("withdraws results of a tool the caller has since lost", async () => {
  const { messages } = await loadContext("c", auth, new Set());

  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(messages[1].content, "You have one lead.");
  assert.ok(!messages.some((message) => message.tool_calls));
});

test("drops a call that has no result yet, such as an undecided write", async () => {
  rows.push({ seq: 5, role: "user", content: "add one", tool_calls: null, tool_call_id: null });
  rows.push({ seq: 6, role: "assistant", content: "", tool_calls: [call("b", "create_lead")], tool_call_id: null });

  const { messages } = await loadContext("c", auth, new Set(["list_leads", "create_lead"]));

  assert.ok(!messages.some((message) => message.tool_calls?.some((item) => item.id === "b")));
});

test("a thread that fits the window has nothing to recall", async () => {
  const { windowStart } = await loadContext("c", auth, new Set());

  assert.equal(windowStart, null);
});

test("a long thread reports where its window starts, on a user message", async () => {
  rows = [];

  for (let seq = 1; seq <= 60; seq += 1) {
    rows.push({
      seq,
      role: seq % 2 ? "user" : "assistant",
      content: `message ${seq}`,
      tool_calls: null,
      tool_call_id: null,
    });
  }

  const { messages, windowStart } = await loadContext("c", auth, new Set());

  assert.equal(messages[0].role, "user");
  assert.equal(windowStart, 21);
});
