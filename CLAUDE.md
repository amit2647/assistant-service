# assistant-service — notes for Claude Code

Parent-repo context (gateway, auth, bundles, the `env_file` rule for `OPENROUTER_*`) is in `../CLAUDE.md`.

## AI assistant and MCP

`assistant-service` hosts both the in-product assistant (`POST /assistant/chat`) and an MCP server
(`POST /mcp`, Streamable HTTP) over a **single tool catalog** in
`src/services/toolCatalog.js`. It holds no business logic and touches no business tables — it reads
the database only to resolve access grants when authenticating.

- Every tool is an HTTP call onto the owning service carrying the caller's own bearer token, so
  adding a tool never means duplicating a permission check.
- Each tool declares a `permission`. `toolsFor(permissions)` filters the catalog **before the model
  is invoked**, so the assistant has no vocabulary for features the user lacks — that, not the
  prompt, is what keeps it from offering or discussing them.
- Settings tools (users, roles, permissions, access grants, organization, email templates,
  automations, accounts) are **read-only**, each gated on the same permission as the endpoint it
  calls. They pass results through `pick()` so only the fields that answer a question reach the
  model provider — e.g. an email account's address, never its SMTP host or username. Do the same
  for any new tool that reads configuration.
- Tools marked `write: true` are never executed on the model's say-so. They come back as a
  `pendingAction` for the user to confirm, and the confirming call re-checks the permission rather
  than trusting the returned payload.
- The model is reached through OpenRouter. `OPENROUTER_MAX_TOKENS` is capped (default 1024) because
  the provider default is far larger and is billed against the account's headroom. With no
  `OPENROUTER_API_KEY` the assistant returns 503 and nothing else is affected.
- Conversations are stored server-side (`assistant_conversations`, `assistant_messages`,
  `assistant_pending_actions`, migration 011) and `conversationService.js` owns all of that SQL.
  The client sends only `{ clientMessageId, content }`. Tool calls and results are stored and
  replayed to the model, **filtered to the caller's current tools**, so a revoked permission also
  withdraws the data it produced.
- A turn is three steps: a short transaction that takes the conversation's **turn lease** and
  records the question, the model call with **no transaction open**, then one transaction that
  commits everything the model produced. Never hold a transaction across the model call.
- Duplicates are prevented by the schema, not by care: client-generated conversation and message
  ids (a retry replays the stored answer), `UNIQUE (conversation_id, seq)`, and a confirm that
  claims its action with `pending → executing`, so a double click runs the write once. A confirm
  carries no body: the **stored** arguments run, never anything the client sends back.

## Vector search (Qdrant)

Qdrant is a **derived index; Postgres is the source of truth**. Two collections:
`assistant_messages` (conversation prose, for history search and recall) and
`assistant_knowledge` (the Markdown in `assistant-service/knowledge/`, for the `search_help` tool).

- Nothing writes to Qdrant in a request. A message is committed with `embed_status = 'pending'`
  (migration 012) and `embeddingWorker.js` drains it: claim with `FOR UPDATE SKIP LOCKED`, embed,
  upsert with `wait=true`, mark done, one Postgres transaction. Point id = message id, so reruns
  overwrite. Qdrant down → rows stay pending. Resetting `embed_status` to `pending` rebuilds it.
- **Qdrant only ever supplies ids.** Every hit is re-read from Postgres with organization, user and
  `deleted_at` checked again (`searchService.js`). Keep it that way — never render payload text
  from a message point.
- Only user and assistant prose is embedded, never tool results: those are CRM data under
  permissions that can be revoked, and a vector copy would outlive the revocation.
- Embeddings are local (`all-MiniLM-L6-v2` via `@huggingface/transformers`, 384-d). Its ONNX
  runtime needs glibc, which is why assistant-service is `node:22-slim` rather than Alpine and why
  its healthcheck uses `node`, not `wget`. The model is fetched at image build; runtime is offline.
- Help docs carry a `permission:` front-matter; `search_help` filters to the caller's permissions
  inside the vector search. A tool with `permission: null` is open to everyone, so use that only
  for a tool that filters by permission itself.
- `QDRANT_API_KEY` is passed to assistant-service under `environment:` on purpose, so it resolves
  the same way as in the `qdrant` container. Do not leave it to `env_file`.

