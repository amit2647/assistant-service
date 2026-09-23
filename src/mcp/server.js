const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const { toolsFor, getTool } = require("../services/toolCatalog");

/*
 * The product's operations, exposed over MCP.
 *
 * This is the same catalog the in-product assistant uses, so an external MCP
 * client — Claude Desktop, Claude Code — gets exactly the capabilities the
 * bearer token's owner has, and no more. Both paths run every call through the
 * owning service with that user's token, so there is one authority for access.
 *
 * Stateless by design: a server and transport are built per request and bound
 * to that request's identity. Nothing is cached between callers, so a token can
 * never inherit a previous one's tool list.
 */
function buildServer(auth, token) {
  const server = new Server(
    { name: "omnicore", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsFor(auth.permissions).map((tool) => ({
      name: tool.name,
      description: tool.write
        ? `${tool.description} (This changes data.)`
        : tool.description,
      inputSchema: tool.parameters,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = getTool(request.params.name, auth.permissions);

    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "That tool is not available to this user.",
          },
        ],
      };
    }

    const result = await tool.run({ token, auth }, request.params.arguments || {});

    return {
      isError: result.ok === false,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            result.ok === false ? { error: result.error, status: result.status } : result.data,
          ),
        },
      ],
    };
  });

  return server;
}

async function handleMcpRequest(req, res) {
  const server = buildServer(req.auth, (req.headers.authorization || "").split(" ")[1]);

  const transport = new StreamableHTTPServerTransport({
    // No session: every request carries its own bearer token, which is the
    // only identity this server has.
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

module.exports = { handleMcpRequest, buildServer };
