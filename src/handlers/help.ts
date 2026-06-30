import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";

// /help — plain-language explanation for ChatTrivia players.
const composer = new Composer<Ctx>();

const HELP =
  "🧠 <b>ChatTrivia</b> — fast-paced multiple-choice trivia for your group!\n\n" +
  "Tap a button on the menu to start a game, view the leaderboard, or manage questions.\n\n" +
  "<b>How it works:</b>\n" +
  "• Each round has up to 20 questions across 5 categories\n" +
  "• You have 12 seconds per question — answer faster for more points\n" +
  "• Correct answer: 20–100 pts depending on speed\n" +
  "• Wrong or no answer: 0 pts\n\n" +
  "<b>Commands you can type:</b>\n" +
  "/start — Open the main menu\n" +
  "/help — This help text\n" +
  "/leaderboard — See all-time rankings\n" +
  "/mystats — Your personal stats\n\n" +
  "Everything else is reachable by tapping!";

const backToMenu = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);

composer.command("help", async (ctx) => {
  await ctx.reply(HELP, { parse_mode: "HTML" });
});

composer.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(HELP, { reply_markup: backToMenu, parse_mode: "HTML" });
});

export default composer;
