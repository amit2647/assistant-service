const { describe, test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

/*
 * One assistant turn, with the model and the other services replaced at
 * fetch. Checks the rules that make the assistant safe to act for someone:
 * writes stop for confirmation, unavailable tools are refused, and everything
 * the turn produced is returned for the caller to persist.
 */

process.env.OPENROUTER_API_KEY = "test-key";

const { runTurn } = require("../src/services/chatService");

const auth = { userId: 1, organizationId: 1, role: "SALES_REP", permissions: ["leads.read", "leads.create"] };

let modelReplies;
let serviceCalls;
let modelRequests;

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

beforeEach(() => {
  modelReplies = [];
  serviceCalls = [];
  modelRequests = [];

  mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("openrouter")) {
      modelRequests.push(JSON.parse(options.body));

      const message = modelReplies.shift();

      return { ok: true, json: async () => ({ choices: [{ message }] }) };
    }

    serviceCalls.push({ url, method: options.method });

    return { ok: true, json: async () => [{ id: 5, name: "Priya Nair" }] };
  });
});

afterEach(() => mock.restoreAll());

describe("runTurn", () => {
  test("a plain answer is one assistant message", async () => {
    modelReplies.push({ role: "assistant", content: "Hello!" });

    const { produced, pendingAction } = await runTurn({
      auth,
      token: "t",
      history: [{ role: "user", content: "hi" }],
    });

    assert.deepEqual(produced, [{ role: "assistant", content: "Hello!" }]);
    assert.equal(pendingAction, null);
  });

  test("a read tool runs, and its result is fed back to the model", async () => {
    modelReplies.push({ role: "assistant", content: "", tool_calls: [toolCall("c1", "list_leads", {})] });
    modelReplies.push({ role: "assistant", content: "You have one lead." });

    const { produced } = await runTurn({ auth, token: "t", history: [{ role: "user", content: "leads?" }] });

    assert.deepEqual(
      produced.map((message) => message.role),
      ["assistant", "tool", "assistant"],
    );
    assert.equal(produced[1].tool_call_id, "c1");
    assert.equal(serviceCalls.length, 1);
    // The second model call saw the tool result.
    assert.ok(modelRequests[1].messages.some((message) => message.role === "tool"));
  });

  test("a write tool is not executed; it comes back as a pending action", async () => {
    modelReplies.push({
      role: "assistant",
      content: "",
      tool_calls: [toolCall("c2", "create_lead", { name: "Priya Nair", company: "Kestrel" })],
    });

    const { pendingAction } = await runTurn({ auth, token: "t", history: [{ role: "user", content: "add" }] });

    assert.equal(serviceCalls.length, 0, "the write must not reach lead-service");
    assert.equal(pendingAction.name, "create_lead");
    assert.equal(pendingAction.toolCallId, "c2");
    assert.deepEqual(pendingAction.arguments, { name: "Priya Nair", company: "Kestrel" });
  });

  test("a tool outside the caller's permissions is refused, not run", async () => {
    modelReplies.push({ role: "assistant", content: "", tool_calls: [toolCall("c3", "delete_lead", { id: 1 })] });
    modelReplies.push({ role: "assistant", content: "I can't do that." });

    const { produced, pendingAction } = await runTurn({
      auth,
      token: "t",
      history: [{ role: "user", content: "delete" }],
    });

    assert.equal(pendingAction, null);
    assert.equal(serviceCalls.length, 0);
    assert.match(produced[1].content, /not available/);
  });

  test("the model is only offered the caller's tools", async () => {
    modelReplies.push({ role: "assistant", content: "ok" });

    await runTurn({ auth, token: "t", history: [{ role: "user", content: "hi" }] });

    const offered = modelRequests[0].tools.map((tool) => tool.function.name);

    assert.ok(offered.includes("list_leads"));
    assert.ok(!offered.includes("delete_lead"));
    assert.ok(!offered.includes("list_users"));
  });

  test("an empty reply falls back to emptyReply", async () => {
    modelReplies.push({ role: "assistant", content: "   " });

    const { produced } = await runTurn({
      auth,
      token: "t",
      history: [{ role: "user", content: "hi" }],
      emptyReply: "Done — Create lead.",
    });

    assert.equal(produced[0].content, "Done — Create lead.");
  });

  test("recalled messages go into the system prompt, not the thread", async () => {
    modelReplies.push({ role: "assistant", content: "14 November." });

    await runTurn({
      auth,
      token: "t",
      history: [{ role: "user", content: "when?" }],
      recalled: [{ seq: 1, role: "user", content: "Renewal is on 14 November." }],
    });

    const [system] = modelRequests[0].messages;

    assert.equal(system.role, "system");
    assert.match(system.content, /Renewal is on 14 November/);
    assert.equal(modelRequests[0].messages.filter((message) => message.role === "system").length, 1);
  });
});
