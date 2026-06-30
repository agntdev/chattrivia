import { Composer } from "grammy";
import { readdirSync } from "node:fs";
import { createBot, type BotContext } from "./toolkit/index.js";
import { __resetStore } from "./storage.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  // Ephemeral game setup state (category flows between callbacks without
  // needing to parse it from message text).
  setupCategory?: string;
  // Question import state: when the user tapped "Add one manually" or "Import CSV",
  // we gate text interception to avoid false positives from normal chat messages.
  questionImportMode?: "pipe" | "csv";
  // Index of the question being edited (set during edit flow)
  questionEditIndex?: number;
}

export type Ctx = BotContext<Session>;

/**
 * buildBot — assembles the bot, AUTO-LOADS every feature handler from
 * src/handlers/, then registers the global fallback. Does NOT start the bot.
 * Add a feature by creating src/handlers/<name>.ts that default-exports a grammY
 * Composer — NEVER edit this file (concurrent feature PRs would conflict).
 */
export async function buildBot(token: string) {
  // Reset the persistent store singleton so each spec run gets a clean slate.
  __resetStore();

  const bot = createBot<Session>(token, {
    initial: () => ({}),
  });

  const dir = new URL("./handlers/", import.meta.url);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(
      (f) =>
        (f.endsWith(".js") || f.endsWith(".ts")) &&
        !f.endsWith(".d.ts") &&
        !f.includes(".test.") &&
        !f.includes(".spec."),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    files = []; // no handlers/ dir yet → nothing to load
  }
  for (const file of files.sort()) {
    const mod = (await import(new URL(file, dir).href)) as { default?: Composer<Ctx> };
    if (!mod.default) {
      throw new Error(`handler ${file} must default-export a grammY Composer`);
    }
    bot.use(mod.default);
  }

  bot.on("message", (ctx) => ctx.reply("Sorry, I didn't understand that. Try /help."));

  return bot;
}
