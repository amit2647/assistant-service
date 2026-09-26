require("dotenv").config();

const app = require("./app");
const { testDatabaseConnection } = require("./config/database");
const { MODEL } = require("./services/chatService");
const embeddingWorker = require("./services/embeddingWorker");

const PORT = Number(process.env.PORT || 4007);

async function startServer() {
  try {
    // Holds conversations, and is read for just-in-time grants on every request.
    await testDatabaseConnection();

    if (!process.env.OPENROUTER_API_KEY) {
      console.warn(
        "[Assistant Service] OPENROUTER_API_KEY is not set — the assistant will answer 503 " +
          "until it is. Set it in the parent repo's .env; it is read from there only, not " +
          "from the shell environment.",
      );
    }

    app.listen(PORT, () => {
      console.log(`Assistant Service running on port ${PORT} (model: ${MODEL})`);
    });

    // Not awaited: Qdrant being down must not stop the assistant answering. The
    // worker retries, and new messages wait in the outbox until it is back.
    embeddingWorker.start();
  } catch (error) {
    console.error("[Assistant Service] Startup failed:", error);
    process.exit(1);
  }
}

startServer();
