const { describe, test, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const { TOOLS, toolsFor, getTool } = require("../src/services/toolCatalog");

/*
 * The catalog is the assistant's whole capability surface, filtered by the
 * caller's permissions before the model ever sees it.
 */

describe("catalog rules", () => {
  test("every tool that calls another service declares a permission", () => {
    for (const tool of TOOLS.filter((item) => item.name !== "search_help")) {
      assert.ok(tool.permission, `${tool.name} has no permission`);
    }
  });

  test("every write tool can describe itself for the confirm card", () => {
    for (const tool of TOOLS.filter((item) => item.write)) {
      assert.equal(typeof tool.summarize, "function", `${tool.name} has no summarize`);
    }
  });

  test("tool names are unique", () => {
    const names = TOOLS.map((tool) => tool.name);

    assert.equal(new Set(names).size, names.length);
  });
});

describe("toolsFor / getTool", () => {
  test("someone with no permissions only gets the help tool", () => {
    assert.deepEqual(toolsFor([]).map((tool) => tool.name), ["search_help"]);
  });

  test("a permission unlocks exactly its tools", () => {
    const names = toolsFor(["leads.read"]).map((tool) => tool.name);

    assert.ok(names.includes("list_leads"));
    assert.ok(!names.includes("create_lead"));
    assert.ok(!names.includes("list_customers"));
  });

  test("getTool refuses a tool the caller lacks, even by exact name", () => {
    assert.equal(getTool("delete_lead", ["leads.read"]), null);
    assert.ok(getTool("delete_lead", ["leads.delete"]));
  });

  test("getTool refuses names that do not exist", () => {
    assert.equal(getTool("drop_database", ["system.settings"]), null);
  });

  test("settings tools are read-only", () => {
    const settings = [
      "list_users",
      "list_roles",
      "get_role",
      "list_permissions",
      "list_access_grants",
      "get_organization",
      "list_email_templates",
      "list_email_automations",
      "list_email_accounts",
    ];

    for (const name of settings) {
      const tool = TOOLS.find((item) => item.name === name);

      assert.ok(tool, `${name} missing`);
      assert.ok(!tool.write, `${name} must not write`);
    }
  });
});

describe("what reaches the model provider", () => {
  afterEach(() => mock.restoreAll());

  test("email accounts are trimmed to name, address, provider and status", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({
        accounts: [
          {
            id: 1,
            name: "Sales",
            email_address: "sales@acme.example",
            provider: "gmail",
            is_active: true,
            smtp_host: "smtp.gmail.com",
            smtp_username: "sales@acme.example",
            imap_host: "imap.gmail.com",
          },
        ],
      }),
    }));

    const result = await getTool("list_email_accounts", ["system.integrations"]).run(
      { token: "t", auth: { organizationId: 1 } },
      {},
    );

    assert.deepEqual(Object.keys(result.data[0]).sort(), [
      "email_address",
      "id",
      "is_active",
      "name",
      "provider",
    ]);
  });

  test("calls go to the owning service with the user's own token", async () => {
    const calls = [];

    mock.method(globalThis, "fetch", async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => [] };
    });

    await getTool("list_leads", ["leads.read"]).run({ token: "user-token", auth: {} }, {});

    assert.match(calls[0].url, /lead-service.*\/leads/);
    assert.equal(calls[0].options.headers.Authorization, "Bearer user-token");
  });

  test("a service error comes back as a result, not a crash", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "Forbidden" }),
    }));

    const result = await getTool("list_leads", ["leads.read"]).run({ token: "t", auth: {} }, {});

    assert.deepEqual(result, { ok: false, status: 403, error: "Forbidden" });
  });
});
