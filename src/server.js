require("dotenv").config();

const app = require("./app");
const { testDatabaseConnection } = require("./config/database");
const { MODEL } = require("./services/chatService");

const PORT = Number(process.env.PORT || 4007);

async function startServer() {
  try {
    // Only used to read active just-in-time grants when authenticating.
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
  } catch (error) {
    console.error("[Assistant Service] Startup failed:", error);
    process.exit(1);
  }
}

startServer();
