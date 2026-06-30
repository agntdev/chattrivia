import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  paginate,
  registerMainMenuItem,
} from "../toolkit/index.js";
import {
  type Player,
  getPlayer,
  getPlayerIds,
} from "../storage.js";

// ── Register main menu item ─────────────────────────────────────────────────
registerMainMenuItem({
  label: "🏆 Leaderboard",
  data: "leaderboard",
  order: 20,
});

// ── Composer ────────────────────────────────────────────────────────────────
const composer = new Composer<Ctx>();

// ── /leaderboard command ────────────────────────────────────────────────────
composer.command("leaderboard", async (ctx) => {
  await showLeaderboard(ctx, 0);
});

// ── Button from main menu ───────────────────────────────────────────────────
composer.callbackQuery("leaderboard", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showLeaderboard(ctx, 0);
});

// ── /mystats command ────────────────────────────────────────────────────────
composer.command("mystats", async (ctx) => {
  await showMyStats(ctx);
});

// ── Pagination ──────────────────────────────────────────────────────────────
composer.callbackQuery(/^lb:next:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showLeaderboard(ctx, Number(ctx.match[1]));
});

composer.callbackQuery(/^lb:prev:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showLeaderboard(ctx, Number(ctx.match[1]));
});

// ── Implementation ──────────────────────────────────────────────────────────
const PER_PAGE = 10;

async function loadRankings(chatId: number): Promise<Player[]> {
  const ids = await getPlayerIds(chatId);
  const players: Player[] = [];
  for (const uid of ids) {
    const p = await getPlayer(chatId, uid);
    if (p) players.push(p);
  }
  players.sort((a, b) => b.cumulativeScore - a.cumulativeScore);
  return players;
}

async function showLeaderboard(ctx: Ctx, page: number) {
  const chatId = ctx.chat!.id;
  const players = await loadRankings(chatId);

  if (players.length === 0) {
    const msg = "No scores yet — start a game and climb the board!";
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(msg);
    } else {
      await ctx.reply(msg);
    }
    return;
  }

  const { pageItems, page: actualPage, totalPages, controls } = paginate(
    players.map((p, i) => ({ ...p, rank: i + 1 })),
    { page, perPage: PER_PAGE, callbackPrefix: "lb", prevLabel: "« Prev", nextLabel: "Next »" },
  );

  const lines: string[] = [];
  lines.push("🏆 <b>Leaderboard — All Time</b>\n");
  for (let i = 0; i < pageItems.length; i++) {
    const p = pageItems[i] as Player & { rank: number };
    const star = p.rank === 1 ? " ⭐" : "";
    lines.push(
      `${p.rank}. ${p.firstName}: ${p.cumulativeScore} pts • ${p.wins} wins${star}`,
    );
  }
  lines.push(`\nPage ${actualPage + 1}/${totalPages}`);
  lines.push("Tap /mystats to see your own stats.");

  const kb = inlineKeyboard([
    ...controls.inline_keyboard,
  ]);

  const text = lines.join("\n");
  if (ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, { reply_markup: kb, parse_mode: "HTML" });
  } else {
    await ctx.reply(text, { reply_markup: kb, parse_mode: "HTML" });
  }
}

async function showMyStats(ctx: Ctx) {
  const chatId = ctx.chat!.id;
  const userId = ctx.from!.id;
  const p = await getPlayer(chatId, userId);

  if (!p) {
    await ctx.reply("You haven't played in this chat yet. Start a game to get on the board!");
    return;
  }

  const players = await loadRankings(chatId);
  const rank = players.findIndex((r) => r.userId === userId) + 1;
  const rankStr = rank > 0 ? `#${rank}` : "unranked";

  await ctx.reply(
    `📊 <b>Your Stats</b>\n\n` +
      `Rank: ${rankStr}\n` +
      `Score: ${p.cumulativeScore} pts\n` +
      `Wins: ${p.wins}\n` +
      `Games: ${p.gamesPlayed}`,
    { parse_mode: "HTML" },
  );
}

export default composer;
