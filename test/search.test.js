const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/*
 * Qdrant is a derived index and only ever supplies ids. These check that what
 * is shown comes from Postgres, re-checked there — so a stale point, or one
 * the index returned wrongly, can never surface.
 */

// Stubbed before the services load: both destructure these at require time.
const embedder = require("../src/services/embedder");

embedder.embedOne = async () => [0.1, 0.2];
embedder.embed = async (texts) => texts.map(() => [0.1, 0.2]);

const vectorStore = require("../src/services/vectorStore");
const database = require("../src/config/database");

let points;
let pgRows;

vectorStore.search = async () => points;

const { searchConversations } = require("../src/services/searchService");
const { searchHelp } = require("../src/services/knowledgeService");

const auth = { userId: 1, organizationId: 1 };

beforeEach(() => {
  points = [];
  pgRows = { meaning: [], words: [], conversations: [] };

  database.pool.query = async (text) => {
    if (/ts_rank/.test(text)) return { rows: pgRows.words };
    if (/m\.id = ANY/.test(text)) return { rows: pgRows.meaning };
    if (/FROM assistant_conversations/.test(text)) return { rows: pgRows.conversations };
    return { rows: [] };
  };
});

describe("history search", () => {
  test("a point Postgres does not confirm is dropped", async () => {
    // Qdrant returns two ids; Postgres (which checks owner and deleted_at)
    // only confirms one of them.
    points = [{ id: 10 }, { id: 11 }];
    pgRows.meaning = [{ id: 10, conversation_id: "conv-a", seq: 1, content: "renewal pricing" }];
    pgRows.conversations = [{ id: "conv-a", title: "Pricing", last_message_at: new Date() }];

    const results = await searchConversations(auth, "pricing");

    assert.deepEqual(results.map((result) => result.id), ["conv-a"]);
  });

  test("a conversation Postgres no longer returns is dropped", async () => {
    points = [{ id: 10 }];
    pgRows.meaning = [{ id: 10, conversation_id: "conv-deleted", seq: 1, content: "x" }];
    pgRows.conversations = [];

    assert.deepEqual(await searchConversations(auth, "x"), []);
  });

  test("keyword matches still work when Qdrant is down", async () => {
    vectorStore.search = async () => {
      throw new Error("Qdrant unavailable");
    };
    pgRows.words = [{ id: 3, conversation_id: "conv-b", seq: 2, content: "Thiago Silva lead" }];
    pgRows.conversations = [{ id: "conv-b", title: "Leads", last_message_at: new Date() }];

    const original = console.error;
    console.error = () => {};

    try {
      const results = await searchConversations(auth, "Thiago");

      assert.equal(results[0].id, "conv-b");
      assert.deepEqual(results[0].matchedBy, ["words"]);
    } finally {
      console.error = original;
      vectorStore.search = async () => points;
    }
  });
});

describe("product help", () => {
  test("help about a permission the caller lacks is never returned", async () => {
    // Even if the index returned it, the service re-checks.
    points = [
      { payload: { content: "How to create a role", permission: "system.settings" } },
      { payload: { content: "How to find leads", permission: "leads.read" } },
      { payload: { content: "Using the assistant" } },
    ];

    const help = await searchHelp("how?", ["leads.read"]);

    assert.deepEqual(help, ["How to find leads", "Using the assistant"]);
  });
});
