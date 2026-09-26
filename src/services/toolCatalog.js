/*
 * The assistant's entire capability surface.
 *
 * Every tool is a thin call onto an existing service endpoint, made with the
 * signed-in user's own bearer token. Nothing here talks to the database, and
 * nothing re-implements a permission check: the owning service runs its usual
 * authenticate + requirePermission, so the assistant can never reach past what
 * the person could do in the UI.
 *
 * `permission` is used a second time, before the model ever runs: tools the
 * caller lacks are withheld from the tool list entirely, so the assistant has
 * no vocabulary for features that are not theirs. That is what stops it
 * offering — or talking about — a screen the person cannot open.
 *
 * `write: true` means the tool is not executed on the model's say-so. It is
 * returned to the UI as a pending action for the person to confirm.
 */

const { searchHelp } = require("./knowledgeService");

const LEAD = process.env.LEAD_SERVICE_URL || "http://lead-service:4001";
const CUSTOMER = process.env.CUSTOMER_SERVICE_URL || "http://customer-service:4002";
const SERVICE = process.env.SERVICE_SERVICE_URL || "http://service-service:4003";
const DASHBOARD = process.env.DASHBOARD_SERVICE_URL || "http://dashboard-service:4005";
const EMAIL = process.env.EMAIL_SERVICE_URL || "http://email-service:4006";
const IDENTITY = process.env.IDENTITY_SERVICE_URL || "http://identity-service:4004";

async function callService(token, method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // A hung service must not hold the conversation's turn lease open.
    signal: AbortSignal.timeout(20 * 1000),
  });

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    /*
     * Surfaced to the model as a result, not thrown: it should be able to say
     * "that lead does not exist" rather than the turn collapsing. The message
     * comes from the owning service, so a 403 reads as a permission problem.
     */
    return {
      ok: false,
      status: response.status,
      error: payload?.error || payload?.message || `Request failed (${response.status})`,
    };
  }

  return { ok: true, data: payload };
}

/*
 * Keeps only the named fields of a successful result.
 *
 * Every tool result is sent to the model provider, so settings tools pass on
 * what answers a question and nothing more — an email account's name and
 * address, not its SMTP host and username. `from` picks a nested list out of
 * an envelope such as { templates: [...], count }.
 */
function pick(result, fields, from) {
  if (!result.ok) {
    return result;
  }

  const source = from ? result.data?.[from] : result.data;

  const trim = (item) =>
    Object.fromEntries(fields.filter((field) => field in item).map((field) => [field, item[field]]));

  return {
    ok: true,
    data: Array.isArray(source) ? source.map(trim) : source ? trim(source) : source,
  };
}

const query = (params) => {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }

  const string = search.toString();

  return string ? `?${string}` : "";
};

const TOOLS = [
  /* ---------------------------------------------------------- leads */
  {
    name: "list_leads",
    permission: "leads.read",
    description:
      "List leads in the organization. Supports a free-text search across name, company, email and phone, and filtering by status.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "Free-text search term" },
        status: {
          type: "string",
          description: "Filter by status, e.g. New, Contacted, Qualified, Converted",
        },
      },
    },
    run: (ctx, args) =>
      callService(ctx.token, "GET", `${LEAD}/leads${query({ q: args.q, status: args.status })}`),
  },
  {
    name: "get_lead",
    permission: "leads.read",
    description: "Get one lead by id, including the services attached to it.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer", description: "Lead id" } },
      required: ["id"],
    },
    run: (ctx, args) => callService(ctx.token, "GET", `${LEAD}/leads/${args.id}`),
  },
  {
    name: "create_lead",
    permission: "leads.create",
    write: true,
    summarize: (args) => `Create lead "${args.name}"${args.company ? ` at ${args.company}` : ""}.`,
    description:
      "Create a new lead. Ask the user for a name first if they have not given one.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        company: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        channel: {
          type: "string",
          description: "Where the lead came from, e.g. Website, Referral, Campaign",
        },
        status: { type: "string", description: "New, Contacted, Qualified or Converted" },
        score: { type: "integer", description: "Lead score, 0-100" },
        serviceIds: {
          type: "array",
          items: { type: "integer" },
          description: "Ids of services the lead is interested in",
        },
      },
      required: ["name"],
    },
    run: (ctx, args) => callService(ctx.token, "POST", `${LEAD}/leads`, args),
  },
  {
    name: "update_lead",
    permission: "leads.update",
    write: true,
    summarize: (args) =>
      `Update lead ${args.id}: ${Object.keys(args)
        .filter((key) => key !== "id")
        .join(", ")}.`,
    description: "Update fields on an existing lead. Only the fields supplied are changed.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        company: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        channel: { type: "string" },
        status: { type: "string" },
        score: { type: "integer" },
      },
      required: ["id"],
    },
    run: (ctx, args) => {
      const { id, ...body } = args;
      return callService(ctx.token, "PATCH", `${LEAD}/leads/${id}`, body);
    },
  },
  {
    name: "convert_lead",
    permission: "leads.update",
    write: true,
    summarize: (args) =>
      `Convert lead ${args.id} into a customer, copying its services and marking the lead Converted.`,
    description:
      "Convert a lead into a customer. This creates the customer, copies the lead's services and marks the lead Converted, in one transaction.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    run: (ctx, args) => callService(ctx.token, "POST", `${LEAD}/leads/${args.id}/convert`, {}),
  },
  {
    name: "delete_lead",
    permission: "leads.delete",
    write: true,
    destructive: true,
    summarize: (args) => `Permanently delete lead ${args.id}.`,
    description: "Delete a lead permanently. Prefer updating its status unless deletion is asked for.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    run: (ctx, args) => callService(ctx.token, "DELETE", `${LEAD}/leads/${args.id}`),
  },

  /* ------------------------------------------------------ customers */
  {
    name: "list_customers",
    permission: "customers.read",
    description: "List customers in the organization, with optional free-text search.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "Free-text search term" },
        segment: { type: "string", description: "Filter by segment" },
      },
    },
    run: (ctx, args) =>
      callService(
        ctx.token,
        "GET",
        `${CUSTOMER}/customers${query({ q: args.q, segment: args.segment })}`,
      ),
  },
  {
    name: "get_customer",
    permission: "customers.read",
    description: "Get one customer by id, including the services attached to it.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    run: (ctx, args) => callService(ctx.token, "GET", `${CUSTOMER}/customers/${args.id}`),
  },
  {
    name: "create_customer",
    permission: "customers.create",
    write: true,
    summarize: (args) => `Create customer "${args.name}"${args.company ? ` at ${args.company}` : ""}.`,
    description: "Create a new customer directly, without going through a lead.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        company: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        segment: { type: "string", description: "e.g. Standard, Premium, Enterprise" },
        serviceIds: { type: "array", items: { type: "integer" } },
      },
      required: ["name"],
    },
    run: (ctx, args) => callService(ctx.token, "POST", `${CUSTOMER}/customers`, args),
  },
  {
    name: "update_customer",
    permission: "customers.update",
    write: true,
    summarize: (args) =>
      `Update customer ${args.id}: ${Object.keys(args)
        .filter((key) => key !== "id")
        .join(", ")}.`,
    description: "Update fields on an existing customer. Only the fields supplied are changed.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        company: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        segment: { type: "string" },
      },
      required: ["id"],
    },
    run: (ctx, args) => {
      const { id, ...body } = args;
      return callService(ctx.token, "PUT", `${CUSTOMER}/customers/${id}`, body);
    },
  },
  {
    name: "delete_customer",
    permission: "customers.delete",
    write: true,
    destructive: true,
    summarize: (args) => `Permanently delete customer ${args.id}.`,
    description: "Delete a customer permanently.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    run: (ctx, args) => callService(ctx.token, "DELETE", `${CUSTOMER}/customers/${args.id}`),
  },

  /* ------------------------------------------------------- services */
  {
    name: "list_services",
    permission: "services.read",
    description: "List the organization's service catalog.",
    parameters: {
      type: "object",
      properties: { q: { type: "string", description: "Free-text search term" } },
    },
    run: (ctx, args) => callService(ctx.token, "GET", `${SERVICE}/services${query({ q: args.q })}`),
  },

  /* ------------------------------------------------------ dashboard */
  {
    name: "get_dashboard",
    permission: "reports.read",
    description:
      "Get the dashboard metrics: pipeline counts, conversion figures and recent activity. Use this for any question about totals or trends rather than counting records yourself.",
    parameters: { type: "object", properties: {} },
    run: (ctx) => callService(ctx.token, "GET", `${DASHBOARD}/dashboard`),
  },

  /* --------------------------------------------------- communication */
  {
    name: "list_communications",
    permission: "communications.read",
    description:
      "List email conversations attached to a lead or a customer. Supply exactly one of leadId or customerId.",
    parameters: {
      type: "object",
      properties: {
        leadId: { type: "integer" },
        customerId: { type: "integer" },
      },
    },
    run: (ctx, args) =>
      callService(
        ctx.token,
        "GET",
        `${EMAIL}/emails/communications${query({
          leadId: args.leadId,
          customerId: args.customerId,
        })}`,
      ),
  },
  {
    name: "send_email",
    permission: "email.send",
    write: true,
    destructive: true,
    summarize: (args) => `Send an email to ${args.to} with subject "${args.subject}".`,
    description:
      "Send an email to a lead or customer from the organization's mailbox. Always pass leadId or customerId so the message is filed against that record.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string" },
        text: { type: "string", description: "Plain text body" },
        leadId: { type: "integer", description: "Lead this email belongs to" },
        customerId: { type: "integer", description: "Customer this email belongs to" },
      },
      required: ["to", "subject", "text"],
    },
    run: (ctx, args) => callService(ctx.token, "POST", `${EMAIL}/emails/send`, args),
  },


  /* ------------------------------------------------ settings (read) */
  /*
   * Read-only on purpose. They let the assistant explain how the platform is
   * set up — who has which role, what a role grants, what is automated — to
   * the people allowed to see those screens. Each is gated on the same
   * permission as the endpoint it calls, and changes to settings stay in the
   * Settings screens.
   */
  {
    name: "list_users",
    permission: "users.read",
    description: "List the people in the organization with their role and status.",
    parameters: { type: "object", properties: {} },
    run: async (ctx) =>
      pick(
        await callService(
          ctx.token,
          "GET",
          `${IDENTITY}/organizations/${ctx.auth.organizationId}/users`,
        ),
        ["id", "name", "email", "status", "role_name", "role_code"],
      ),
  },
  {
    name: "list_roles",
    permission: "users.read",
    description:
      "List the roles in the organization: built-in and custom, with how many permissions and people each has.",
    parameters: { type: "object", properties: {} },
    run: async (ctx) =>
      pick(await callService(ctx.token, "GET", `${IDENTITY}/roles`), [
        "id",
        "code",
        "name",
        "description",
        "is_system_role",
        "permission_count",
        "user_count",
      ]),
  },
  {
    name: "get_role",
    permission: "users.read",
    description: "Get one role by id, including every permission it grants.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    run: (ctx, args) => callService(ctx.token, "GET", `${IDENTITY}/roles/${args.id}`),
  },
  {
    name: "list_permissions",
    permission: "users.read",
    description:
      "List every permission that exists in the platform, with what each one allows. Use it to explain what a permission means.",
    parameters: { type: "object", properties: {} },
    run: async (ctx) =>
      pick(await callService(ctx.token, "GET", `${IDENTITY}/permissions`), [
        "code",
        "name",
        "description",
      ]),
  },
  {
    name: "list_access_grants",
    permission: "users.read",
    description:
      "List just-in-time access grants — temporary permissions given to members or external guests — with who has them, until when, and whether they are still active.",
    parameters: { type: "object", properties: {} },
    run: async (ctx) =>
      pick(
        await callService(ctx.token, "GET", `${IDENTITY}/access-grants`),
        [
          "user_name",
          "subject_email",
          "permission_code",
          "permission_name",
          "reason",
          "granted_by_name",
          "expires_at",
          "revoked_at",
          "redeemed_at",
          "is_invite",
          "is_active",
        ],
        "grants",
      ),
  },
  {
    name: "get_organization",
    permission: "organization.read",
    description: "Get the organization's details: name, slug, status and number of users.",
    parameters: { type: "object", properties: {} },
    run: async (ctx) =>
      pick(
        await callService(
          ctx.token,
          "GET",
          `${IDENTITY}/organizations/${ctx.auth.organizationId}`,
        ),
        ["name", "slug", "status", "user_count", "created_at"],
      ),
  },
  {
    name: "list_email_templates",
    permission: "email.templates.read",
    description: "List the organization's email templates with their subject and whether they are active.",
    parameters: { type: "object", properties: {} },
    run: async (ctx) =>
      pick(
        await callService(ctx.token, "GET", `${EMAIL}/emails/templates`),
        ["id", "name", "subject", "description", "is_active", "updated_at"],
        "templates",
      ),
  },
  {
    name: "list_email_automations",
    permission: "email.automations.read",
    description:
      "List email automations: which event triggers each, which template it sends, and whether it is switched on.",
    parameters: { type: "object", properties: {} },
    run: async (ctx) => {
      const result = await callService(ctx.token, "GET", `${EMAIL}/emails/automations`);

      if (!result.ok) {
        return result;
      }

      return {
        ok: true,
        data: {
          automations: pick(
            result,
            ["id", "name", "description", "trigger_event", "template_name", "is_active"],
            "automations",
          ).data,
          availableEvents: result.data?.events || [],
        },
      };
    },
  },
  {
    name: "list_email_accounts",
    permission: "system.integrations",
    description: "List the connected email accounts: name, address, provider and whether each is active.",
    parameters: { type: "object", properties: {} },
    run: async (ctx) =>
      pick(
        await callService(ctx.token, "GET", `${EMAIL}/emails/accounts`),
        ["id", "name", "email_address", "provider", "is_active"],
        "accounts",
      ),
  },

  /* ----------------------------------------------------------- help */
  {
    name: "search_help",
    // No permission of its own: the search inside is filtered to the
    // caller's permissions, so it only ever explains features they have.
    permission: null,
    description:
      "Look up how to do something in OmniCore — which screen, which button, what a status means. Use it for any how-to question before answering.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The how-to question, in plain words" },
      },
      required: ["question"],
    },
    run: async (ctx, args) => {
      const sections = await searchHelp(String(args.question || ""), ctx.auth.permissions);

      return {
        ok: true,
        data: sections.length
          ? { help: sections }
          : { help: [], note: "No help found for this. Do not guess how the product works." },
      };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/*
 * A tool with no permission of its own is available to everyone — used only
 * where the tool filters by permission internally (search_help). Every tool
 * that reaches another service keeps a permission here.
 */
function allowed(tool, held) {
  return !tool.permission || held.has(tool.permission);
}

/*
 * The tools this caller may use. Everything downstream — the model's tool list,
 * the MCP server's catalog, and execution — goes through this, so there is one
 * place where permission decides visibility.
 */
function toolsFor(permissions) {
  const held = new Set(Array.isArray(permissions) ? permissions : []);

  return TOOLS.filter((tool) => allowed(tool, held));
}

function getTool(name, permissions) {
  const tool = BY_NAME.get(name);

  if (!tool) {
    return null;
  }

  const held = new Set(Array.isArray(permissions) ? permissions : []);

  return allowed(tool, held) ? tool : null;
}

module.exports = { TOOLS, toolsFor, getTool, callService };
