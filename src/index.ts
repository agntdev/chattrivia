import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";
import { startOrphanSweep, stopOrphanSweep } from "./handlers/game.js";
import { getActiveGameChatIds } from "./storage.js";

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is required");
    process.exit(1);
  }
  const bot = await buildBot(token);
  // Publish the "/" command list to Telegram (discoverability). A button-first
  // bot exposes only /start + /help; everything else is reached via menu buttons.
  await setDefaultCommands(bot);

  // Periodically sweep abandoned games (no activity for 5 min) so stale state
  // doesn't block new games. The sweep reads the global game-index from persistent
  // storage — no keyspace scan. Pass the bot's API handle so the sweep can send
  // timeout-alert messages to affected chats.
  startOrphanSweep(getActiveGameChatIds, bot.api);

  // Clean up the sweep interval on shutdown so the process can exit cleanly.
  process.once("SIGTERM", stopOrphanSweep);
  process.once("SIGINT", stopOrphanSweep);

  bot.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
