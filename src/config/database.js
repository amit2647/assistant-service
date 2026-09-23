const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "customer_management",
  user: process.env.DB_USER || "app_user",
  password: process.env.DB_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (error) => {
  console.error("[Database] Unexpected PostgreSQL error:", error);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function testDatabaseConnection() {
  const result = await pool.query("SELECT NOW() AS now");

  console.log(`[Database] PostgreSQL connected at ${result.rows[0].now}`);
}

module.exports = {
  pool,
  query,
  testDatabaseConnection,
};
