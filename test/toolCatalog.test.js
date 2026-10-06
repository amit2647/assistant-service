const { describe, test, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const { TOOLS, toolsFor, getTool } = require("../src/services/toolCatalog");
const { systemPrompt } = require("../src/services/chatService");

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

describe("profession bundle tools (M7)", () => {
  const PARTNER = ["customers.read", "obligations.read", "obligations.update", "engagements.read", "fees.update", "documents.generate"];
  const CA = { key: "ca-practice", capabilities: ["engagements", "obligations", "documents", "vault"], vocabulary: { client: { one: "Client", many: "Clients" }, obligation: { one: "Deadline", many: "Deadlines" } } };
  const BUNDLE_TOOLS = ["list_obligations", "get_client_profile", "get_engagement", "update_obligation_status", "record_payment", "generate_document"];
  const names = (permissions, bundle) => toolsFor(permissions, bundle).map((tool) => tool.name);

  test("an organization without a bundle is offered none of them, whatever its permissions", () => {
    // SUPER_ADMIN holds the capability permissions even without a bundle.
    const offered = names(PARTNER, null);
    for (const name of BUNDLE_TOOLS) assert.ok(!offered.includes(name), name);
    assert.equal(getTool("list_obligations", PARTNER, null), null);
  });

  test("with the bundle, each needs its capability and its permission", () => {
    const offered = names(PARTNER, CA);
    for (const name of BUNDLE_TOOLS) assert.ok(offered.includes(name), name);

    assert.ok(!names(PARTNER, { ...CA, capabilities: ["engagements"] }).includes("list_obligations"));
    assert.ok(!names(["obligations.read"], CA).includes("update_obligation_status"));
  });

  test("the writes are confirmed, never run on the model's say-so", () => {
    for (const name of ["update_obligation_status", "record_payment", "generate_document"]) {
      assert.equal(getTool(name, PARTNER, CA).write, true, name);
    }
  });

  test("no tool reaches the vault", () => {
    for (const tool of TOOLS) {
      assert.equal(/vault|credential|password|portal/i.test(tool.name), false, tool.name);
      assert.equal(String(tool.run).includes("/vault"), false, tool.name);
    }
  });

  test("the bundle's words reach the system prompt; nothing is added without one", () => {
    const withBundle = systemPrompt({ role: "CA_PARTNER", bundle: CA }, []);
    const without = systemPrompt({ role: "SUPER_ADMIN", bundle: null }, []);

    assert.match(withBundle, /client: say "Client" \(plural "Clients"\)/);
    assert.match(withBundle, /obligation: say "Deadline"/);
    assert.equal(without.includes("its own words"), false);
  });
});
