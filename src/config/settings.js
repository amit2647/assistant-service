/*
 * Tunable settings, read once from the environment. Each default is the value
 * the assistant shipped with; docker-compose.yml passes every one from .env and
 * .env.example documents them. A value that is set but invalid stops the
 * service at start-up, rather than quietly behaving differently.
 */

function number(name, fallback, { min = 0, max = Infinity, whole = true } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || (whole && !Number.isInteger(value)) || value < min || value > max) {
    throw new Error(`${name} must be ${whole ? "a whole number" : "a number"} from ${min}${max === Infinity ? "" : ` to ${max}`} (got "${raw}")`);
  }
  return value;
}

const settings = {
  // The product's name, as OpenRouter's dashboard shows the calls.
  appName: process.env.APP_NAME || "OmniCore",

  // A turn: model round trips, total time, one model call's time.
  maxSteps: number("ASSISTANT_MAX_STEPS", 6, { min: 1 }),
  turnBudgetMs: number("ASSISTANT_TURN_BUDGET_MS", 4 * 60 * 1000, { min: 1000 }),
  modelTimeoutMs: number("ASSISTANT_MODEL_TIMEOUT_MS", 60 * 1000, { min: 1000 }),
  // A tool's call onto a service, and a call onto Qdrant.
  toolTimeoutMs: number("ASSISTANT_TOOL_TIMEOUT_MS", 20 * 1000, { min: 1000 }),
  vectorTimeoutMs: number("QDRANT_TIMEOUT_MS", 10 * 1000, { min: 1000 }),

  // How long a turn may hold its conversation: longer than the turn budget.
  leaseSeconds: number("ASSISTANT_LEASE_SECONDS", 300, { min: 1 }),

  // How much of the thread is replayed to the model, and a message's length.
  contextMessages: number("ASSISTANT_CONTEXT_MESSAGES", 40, { min: 1 }),
  contextChars: number("ASSISTANT_CONTEXT_CHARS", 8000, { min: 100 }),
  maxMessageChars: number("ASSISTANT_MAX_MESSAGE_CHARS", 8000, { min: 100 }),

  // Conversation search, recall into the prompt, and help articles.
  searchResults: number("SEARCH_RESULTS", 20, { min: 1 }),
  searchCandidates: number("SEARCH_CANDIDATES", 40, { min: 1 }),
  searchMinSimilarity: number("SEARCH_MIN_SIMILARITY", 0.3, { max: 1, whole: false }),
  recallLimit: number("RECALL_LIMIT", 4, { min: 0 }),
  recallMinSimilarity: number("RECALL_MIN_SIMILARITY", 0.4, { max: 1, whole: false }),
  helpResults: number("HELP_RESULTS", 3, { min: 1 }),
  helpMinSimilarity: number("HELP_MIN_SIMILARITY", 0.3, { max: 1, whole: false }),

  // The background embedder.
  embeddingBatch: number("EMBEDDING_BATCH", 32, { min: 1 }),
  embeddingIdleMs: number("EMBEDDING_IDLE_MS", 2000, { min: 100 }),
  embeddingMaxBackoffMs: number("EMBEDDING_MAX_BACKOFF_MS", 30 * 1000, { min: 1000 }),
};

// A live turn must never look crashed and be taken over.
if (settings.leaseSeconds * 1000 <= settings.turnBudgetMs) {
  throw new Error("ASSISTANT_LEASE_SECONDS must be longer than ASSISTANT_TURN_BUDGET_MS");
}

module.exports = settings;
