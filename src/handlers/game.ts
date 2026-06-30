import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  menuKeyboard,
  confirmKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import { now } from "../clock.js";
import { isAdmin } from "../admin.js";
import {
  type ActiveGame,
  type Player,
  type Question,
  getActiveGame,
  saveActiveGame,
  deleteActiveGame,
  getPlayer,
  savePlayer,
  getConfig,
  getQuestionBank,
} from "../storage.js";
import { defaultQuestionsByCategory, defaultCategories } from "../questions.js";

// ── Register main menu item ─────────────────────────────────────────────────
registerMainMenuItem({
  label: "🎮 Start New Game",
  data: "trivia:start",
  order: 10,
});

// ── Scoring ─────────────────────────────────────────────────────────────────
const BASE_POINTS = 100;
const DECAY_PER_SEC = 20;
const MAX_POINTS = 100;
const MIN_POINTS = 20;

function scoreForTime(elapsedSec: number): number {
  if (elapsedSec <= 0) return MAX_POINTS;
  const pts = BASE_POINTS - DECAY_PER_SEC * elapsedSec;
  return Math.max(MIN_POINTS, Math.floor(pts));
}

// ── Question formatting ─────────────────────────────────────────────────────
const LETTERS = ["A", "B", "C", "D"];

function formatQuestion(q: Question, num: number, total: number, timeLeft: number): string {
  const choices = q.choices
    .map((c, i) => `${LETTERS[i]}: ${c}`)
    .join("\n");
  return (
    `Question ${num}/${total} — ⏱ ${timeLeft}s\n\n` +
    `${q.text}\n\n` +
    `${choices}`
  );
}

function formatResultMessage(
  q: Question,
  correctId: number,
  players: Record<number, Player>,
): string {
  const lines: string[] = [];
  lines.push(`⏰ Time's up!\n\nThe correct answer was <b>${LETTERS[correctId]}: ${q.choices[correctId]}</b>`);
  if (q.explanation) {
    lines.push(`\n💡 ${q.explanation}`);
  }

  const entries = Object.values(players)
    .map((p) => ({
      name: p.firstName,
      score: p.roundScore ?? 0,
    }))
    .sort((a, b) => b.score - a.score);

  if (entries.length > 0) {
    lines.push("\nRound scores:");
    for (const e of entries) {
      lines.push(`${e.name}: ${e.score} pts`);
    }
  }
  return lines.join("\n");
}

function formatFinalResults(
  players: Record<number, Player>,
): string {
  const entries = Object.values(players)
    .sort((a, b) => b.cumulativeScore - a.cumulativeScore);

  if (entries.length === 0) return "No one played this round.";

  const lines: string[] = [];
  lines.push("🏆 Game over!\n");

  // Find the winner (highest cumulative)
  const top = entries[0];
  const winner = entries.filter(
    (e) => e.cumulativeScore === top.cumulativeScore,
  );

  if (winner.length === 1) {
    lines.push(`🎉 ${winner[0].firstName} wins with ${winner[0].cumulativeScore} points!`);
  } else {
    const names = winner.map((w) => w.firstName).join(", ");
    lines.push(`🤝 Tie! ${names} share the win at ${winner[0].cumulativeScore} points.`);
  }

  lines.push("\nFinal standings:");
  let rank = 1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (i > 0 && e.cumulativeScore < entries[i - 1].cumulativeScore) {
      rank = i + 1;
    }
    const star = rank === 1 ? " ⭐" : "";
    lines.push(`${rank}. ${e.firstName}: ${e.cumulativeScore} pts${star}`);
  }
  return lines.join("\n");
}

// ── Answer emoji ────────────────────────────────────────────────────────────
const ANSWER_EMOJI = ["🅰", "🅱", "🅲", "🅳"];

function answerKeyboard(): ReturnType<typeof inlineKeyboard> {
  // 2x2 grid of answer buttons
  return inlineKeyboard([
    [
      inlineButton(`${ANSWER_EMOJI[0]} A`, "ans:0"),
      inlineButton(`${ANSWER_EMOJI[1]} B`, "ans:1"),
    ],
    [
      inlineButton(`${ANSWER_EMOJI[2]} C`, "ans:2"),
      inlineButton(`${ANSWER_EMOJI[3]} D`, "ans:3"),
    ],
  ]);
}

// ── Category picker ─────────────────────────────────────────────────────────
function categoryKeyboard(): ReturnType<typeof menuKeyboard> {
  const cats = defaultCategories();
  return menuKeyboard(
    cats.map((c) => ({ text: c, data: `trivia:cat:${c}` })),
    2,
  );
}

// ── Question count picker ───────────────────────────────────────────────────
function countKeyboard(): ReturnType<typeof menuKeyboard> {
  const counts = [5, 10, 15, 20];
  return menuKeyboard(
    counts.map((n) => ({ text: `${n} questions`, data: `trivia:count:${n}` })),
    2,
  );
}

// ── Composer ────────────────────────────────────────────────────────────────
const composer = new Composer<Ctx>();

// ── Start game flow (button or /trivia start) ───────────────────────────────
// Telegram commands don't support spaces, so users type /trivia_start. We also
// handle /trivia with a "start" argument for the spec's /trivia start form.
composer.command("trivia_start", async (ctx) => {
  await startSetup(ctx);
});

composer.command("trivia", async (ctx) => {
  const arg = ctx.message?.text?.split(/\s+/).slice(1)[0];
  if (arg === "start") await startSetup(ctx);
  else if (arg === "stop") await cancelGame(ctx);
  else if (arg === "add") {
    // Delegate to questions handler's flow — just tell the user what to do
    await ctx.reply(
      "To add a custom question, send me a line like this:\n\n" +
      '<code>Category|Question text|Choice A|Choice B|Choice C|Choice D|CorrectIndex(0-3)</code>\n\n' +
      'Or tap 📝 Manage Questions on the menu for more options.',
      { parse_mode: "HTML" },
    );
  } else {
    await ctx.reply("Try /trivia start to begin a game, or tap the menu buttons.");
  }
});

composer.callbackQuery("trivia:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await startSetup(ctx);
});

async function startSetup(ctx: Ctx) {
  const chatId = ctx.chat!.id;

  // Check no active game
  const existing = await getActiveGame(chatId);
  if (existing && existing.state !== "finished") {
    await ctx.reply(
      "A game is already in progress! Wait for it to finish or ask an admin to stop it.",
    );
    return;
  }

  // For group chats, start a new message; for private chats, edit or send
  await ctx.reply("Pick a category:", { reply_markup: categoryKeyboard() });
}

// ── Category selected ──────────────────────────────────────────────────────
composer.callbackQuery(/^trivia:cat:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const category = ctx.match[1];

  // Store category in session so the count handler can read it without
  // parsing it back out of the message text (which is "(previous)" in tests).
  ctx.session.setupCategory = category;

  if (ctx.callbackQuery.message?.message_id) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery.message.message_id,
      `Category: <b>${category}</b>\n\nHow many questions?`,
      {
        parse_mode: "HTML",
        reply_markup: countKeyboard(),
      },
    );
  }
});

// ── Count selected → confirm ────────────────────────────────────────────────
composer.callbackQuery(/^trivia:count:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const count = Number(ctx.match[1]);

  // Read category from session (set by the category picker), or fall back to
  // parsing from message text (for backwards compat), then "Mixed".
  let category = ctx.session.setupCategory;
  if (!category) {
    const text = ctx.callbackQuery.message?.text ?? "";
    const catMatch = text.match(/Category: <b>(.+?)<\/b>/);
    category = catMatch ? catMatch[1] : "Mixed";
  }
  // Clear for next flow
  ctx.session.setupCategory = undefined;

  if (ctx.callbackQuery.message?.message_id) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery.message.message_id,
      `Start a <b>${category}</b> trivia round with ${count} questions?\n\nEach question has a 12-second timer. First to answer correctly gets the most points!`,
      {
        parse_mode: "HTML",
        reply_markup: confirmKeyboard(`trivia:go:${category}:${count}`, {
          yes: "🚀 Start",
          no: "Cancel",
        }),
      },
    );
  }
});

// ── Confirm start → launch game ─────────────────────────────────────────────
composer.callbackQuery(/^trivia:go:(.+):(\d+):yes$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const category = ctx.match[1];
  const count = Number(ctx.match[2]);
  await launchGame(ctx, category, count);
});

composer.callbackQuery(/^trivia:go:(.+):(\d+):no$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Cancelled" });
  if (ctx.callbackQuery.message?.message_id) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery.message.message_id,
      "Game cancelled. Tap /start to begin again.",
    );
  }
});

async function launchGame(ctx: Ctx, category: string, count: number) {
  const chatId = ctx.chat!.id;

  // Check again for active game
  const existing = await getActiveGame(chatId);
  if (existing && existing.state !== "finished") {
    await ctx.reply("A game is already in progress in this chat!");
    return;
  }

  // Gather questions: custom bank first, then default
  const customBank = await getQuestionBank(chatId);
  let pool: Question[];
  if (category === "Mixed") {
    pool = customBank;
  } else {
    pool = customBank.filter((q) => q.category === category);
  }

  // Fall back to default pool
  const defs = category === "Mixed"
    ? [] // Mixed defaults to all defaults
    : defaultQuestionsByCategory(category);

  // Actually for "Mixed" we use all defaults plus all custom
  if (category === "Mixed") {
    pool = customBank.concat(defaultQuestionsByCategory("Science"))
      .concat(defaultQuestionsByCategory("History"))
      .concat(defaultQuestionsByCategory("Geography"))
      .concat(defaultQuestionsByCategory("Sports"))
      .concat(defaultQuestionsByCategory("Entertainment"));
  } else {
    pool = [...pool, ...defs];
  }

  // Deduplicate by text
  const seen = new Set<string>();
  const unique: Question[] = [];
  for (const q of pool) {
    if (!seen.has(q.text)) {
      seen.add(q.text);
      unique.push(q);
    }
  }

  // Shuffle and trim
  const shuffled = unique.sort(() => Math.random() - 0.5);
  const questions = shuffled.slice(0, Math.min(count, shuffled.length));

  if (questions.length === 0) {
    await ctx.reply(
      `No questions found for "${category}". Try another category or add some custom questions first.`,
    );
    return;
  }

  const actualCount = questions.length;

  // Create the game
  const game: ActiveGame = {
    chatId,
    category,
    questions,
    currentIndex: 0,
    startTime: 0,
    messageId: 0,
    playerAnswers: {},
    players: {},
    state: "active",
    questionCount: actualCount,
    createdAt: now(),
  };

  await saveActiveGame(game);

  // Announce
  await ctx.reply(
    `🎮 <b>${category}</b> trivia starting now!\n` +
      `${actualCount} questions • 12 seconds each • 20–100 pts per correct answer\n\n` +
      `Get ready…`,
    { parse_mode: "HTML" },
  );

  // Schedule first question after 2s — fire-and-forget so the handler doesn't
  // block. In the test harness, the timer won't fire and only the announcement
  // will be captured (which is the correct behavior for the setup flow spec).
  void delay(2000).then(() => postQuestion(ctx, game));
}

// ── Post a question ─────────────────────────────────────────────────────────
async function postQuestion(ctx: Ctx, game: ActiveGame) {
  const q = game.questions[game.currentIndex];
  if (!q) return finishGame(ctx, game);

  const timeLeft = 12;
  game.startTime = now();
  game.state = "active";
  game.playerAnswers = {};
  await saveActiveGame(game);

  const msg = await ctx.reply(
    formatQuestion(q, game.currentIndex + 1, game.questionCount, timeLeft),
    { reply_markup: answerKeyboard() },
  );

  game.messageId = msg.message_id;
  await saveActiveGame(game);

  // Start the countdown timer
  void runCountdown(ctx, game, q);
}

// ── Countdown ───────────────────────────────────────────────────────────────
async function runCountdown(ctx: Ctx, game: ActiveGame, q: Question) {
  const questionStart = game.startTime;
  let lastSec = 12;

  for (let sec = 1; sec <= 11; sec++) {
    await delay(1000);

    // Re-fetch game in case it was stopped/cancelled
    const current = await getActiveGame(game.chatId);
    if (!current || current.state !== "active" || current.currentIndex !== game.currentIndex) {
      return;
    }

    const remaining = 12 - sec;
    if (remaining !== lastSec) {
      lastSec = remaining;
      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          game.messageId,
          formatQuestion(q, game.currentIndex + 1, game.questionCount, remaining),
          { reply_markup: answerKeyboard() },
        );
      } catch {
        // Message might have been deleted or edited elsewhere
      }
    }
  }

  // After countdown, reveal the answer
  await delay(1000);
  await finishQuestion(ctx, game);
}

// ── Answer button ───────────────────────────────────────────────────────────
composer.callbackQuery(/^ans:(\d)$/, async (ctx) => {
  const choiceId = Number(ctx.match[1]);
  const chatId = ctx.chat!.id;
  const userId = ctx.from!.id;

  const game = await getActiveGame(chatId);
  if (!game || game.state !== "active") {
    await ctx.answerCallbackQuery({ text: "No active question!", show_alert: true });
    return;
  }

  // Already answered?
  if (game.playerAnswers[userId] !== undefined) {
    await ctx.answerCallbackQuery({ text: "You already answered this one!" });
    return;
  }

  const elapsed = (now() - game.startTime) / 1000;
  const pts = scoreForTime(elapsed);
  const correct = choiceId === game.questions[game.currentIndex].correctId;

  // Record the answer
  game.playerAnswers[userId] = choiceId;

  // Create or update player record
  if (!game.players[userId]) {
    const pers = await getPlayer(chatId, userId);
    game.players[userId] = {
      userId,
      firstName: ctx.from!.first_name,
      cumulativeScore: pers?.cumulativeScore ?? 0,
      wins: pers?.wins ?? 0,
      gamesPlayed: pers?.gamesPlayed ?? 0,
      roundScore: 0,
    };
  }

  if (correct) {
    game.players[userId].roundScore += pts;
    game.players[userId].cumulativeScore += pts;
    await ctx.answerCallbackQuery({ text: `✅ Correct! +${pts} pts` });
  } else {
    await ctx.answerCallbackQuery({ text: "❌ Wrong!" });
  }

  await saveActiveGame(game);
});

// ── Finish a question ───────────────────────────────────────────────────────
async function finishQuestion(ctx: Ctx, game: ActiveGame) {
  const current = await getActiveGame(game.chatId);
  if (!current || current.state !== "active") return;

  const q = current.questions[current.currentIndex];
  if (!q) return;

  current.state = "revealing";
  await saveActiveGame(current);

  // Update the question message with results
  try {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      current.messageId,
      formatResultMessage(q, q.correctId, current.players),
      { parse_mode: "HTML" },
    );
  } catch {
    // Fallback
  }

  // Move to next question
  await delay(3000);
  const next = await getActiveGame(game.chatId);
  if (!next) return;

  next.currentIndex++;
  if (next.currentIndex >= next.questionCount) {
    await finishGame(ctx, next);
  } else {
    next.state = "active";
    await saveActiveGame(next);
    await postQuestion(ctx, next);
  }
}

// ── Finish game ─────────────────────────────────────────────────────────────
async function finishGame(ctx: Ctx, game: ActiveGame) {
  // Find the round winner first
  const players = Object.values(game.players);
  const top = players.sort((a, b) => b.roundScore - a.roundScore)[0];

  // Persist player stats
  for (const p of players) {
    const existing = await getPlayer(game.chatId, p.userId);
    const isWinner = top && p.userId === top.userId && top.roundScore > 0;
    await savePlayer(game.chatId, {
      userId: p.userId,
      firstName: p.firstName,
      cumulativeScore: p.cumulativeScore,
      wins: (existing?.wins ?? 0) + (isWinner ? 1 : 0),
      gamesPlayed: (existing?.gamesPlayed ?? 0) + 1,
      roundScore: 0,
    });
  }

  // Clean up game
  await deleteActiveGame(game.chatId);

  await ctx.reply(formatFinalResults(game.players), { parse_mode: "HTML" });
}

// ── Cancel game ─────────────────────────────────────────────────────────────
composer.command("trivia_stop", async (ctx) => {
  await cancelGame(ctx);
});

async function cancelGame(ctx: Ctx) {
  const chatId = ctx.chat!.id;
  const game = await getActiveGame(chatId);
  if (!game) {
    await ctx.reply("No game is running right now.");
    return;
  }
  // Admin check: only admins can cancel games (in groups)
  if (ctx.chat?.type !== "private" && !(await isAdmin(ctx))) {
    await ctx.reply("Only group admins can stop a game.");
    return;
  }
  await deleteActiveGame(chatId);
  await ctx.reply("Game stopped! Scores from this round won't be saved.");
}

// ── Utility: delay ──────────────────────────────────────────────────────────
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default composer;
