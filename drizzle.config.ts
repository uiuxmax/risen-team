import type { Config } from "drizzle-kit";

/**
 * Drizzle configuration for the local SQLite database.
 * The application also creates the file and schema automatically at runtime,
 * so this config is only needed for optional drizzle-kit workflows.
 */
export default {
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.RISEN_DB_PATH ?? "./data/risen-team.db" },
} satisfies Config;
