const express = require("express");
const cors = require("cors");

const chatRoutes = require("./routes/chatRoutes");
const mcpRoutes = require("./routes/mcpRoutes");
const requestLogger = require("./middleware/requestLogger");

const app = express();

app.use(cors());

app.use(express.json({ limit: "1mb" }));

app.use(requestLogger);

app.get("/health", (req, res) => {
  res.json({
    service: "assistant-service",
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

app.use("/", chatRoutes);
app.use("/", mcpRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
  });
});

app.use((error, req, res, next) => {
  console.error("[Application Error]", error);

  res.status(500).json({
    error: "Internal server error",
  });
});

module.exports = app;
