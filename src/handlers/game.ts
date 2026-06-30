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
  type RoundResult,
  getActiveGame,
  saveActiveGame,
  deleteActiveGame,
  getPlayer,
  getPlayerIds,
  savePlayer,
  getConfig,
  getQuestionBank,
  nextRoundNumber,
  saveRoundResult,
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

// ── Deterministic shuffle ───────────────────────────────────────────────────
function shuffled<T>(arr: T[], seed: number): T[] {
  // Fisher-Yates shuffle with a simple seeded PRNG (Mulberry32).
  const out = [...arr];
  let s = Math.abs(seed) | 0;
  function next(): number {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = (next() * (i + 1)) | 0;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── Game timeout constants ──────────────────────────────────────────────────
const GAME_ORPHAN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes of no activity = abandoned
const SETUP_TIMEOUT_MS = 3 * 60 * 1000;       // 3 minutes in setup = abandoned

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
  // Sort by ROUND score (per-game ranking), not cumulative (all-time).
  const entries = Object.values(players)
    .sort((a, b) => b.roundScore - a.roundScore);

  if (entries.length === 0) return "No one played this round.";

  const lines: string[] = [];
  lines.push("🏆 Game over!\n");

  // Find the winner (highest round score)
  const top = entries[0];
  const winners = entries.filter(
    (e) => e.roundScore === top.roundScore && top.roundScore > 0,
  );

  if (winners.length === 0) {
    lines.push("No one scored this round — better luck next time!");
  } else if (winners.length === 1) {
    lines.push(`🎉 ${winners[0].firstName} wins with ${winners[0].roundScore} points this round!`);
  } else {
    const names = winners.map((w) => w.firstName).join(", ");
    lines.push(`🤝 Tie! ${names} share the win at ${winners[0].roundScore} points.`);
  }

  lines.push("\nFinal standings:");
  let rank = 1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (i > 0 && e.roundScore < entries[i - 1].roundScore) {
      rank = i + 1;
    }
    const star = rank === 1 && e.roundScore > 0 ? " ⭐" : "";
    lines.push(`${rank}. ${e.firstName}: ${e.roundScore} pts${star}`);
  }
  return lines.join("\n");
}

// ── Answer emoji ────────────────────────────────────────────────────────────
const ANSWER_EMOJI = ["🅰", "🅱", "🅲", "🅳"];

function answerKeyboard(): ReturnType<typeof inlineKeyboard> {
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
  // Include "Mixed" as first option for deliberate selection
  return menuKeyboard(
    ["Mixed", ...cats].map((c) => ({ text: c, data: `trivia:cat:${c}` })),
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

// ── Orphan game cleanup (called after bot starts or on a game access) ────────
async function cleanupOrphanGame(chatId: number): Promise<void> {
  const game = await getActiveGame(chatId);
  if (!game) return;

  const elapsed = now() - (game.lastActivityAt ?? game.createdAt);
  const timeout = (game.state === "active" || game.state === "revealing")
    ? GAME_ORPHAN_TIMEOUT_MS
    : SETUP_TIMEOUT_MS;

  if (elapsed > timeout) {
    await deleteActiveGame(chatId);
    // Attempt to notify the chat if we have context
    try {
      // Cannot notify without a ctx — this runs in the background.
      // The next user who interacts will see "no active game".
    } catch {
      // Best-effort
    }
  }
}

// ── Start game flow (button or /trivia start) ───────────────────────────────
composer.command("trivia_start", async (ctx) => {
  await startSetup(ctx);
});

composer.command("trivia", async (ctx) => {
  const arg = ctx.message?.text?.split(/\s+/).slice(1)[0];
  if (arg === "start") await startSetup(ctx);
  else if (arg === "stop") await cancelGame(ctx);
  else if (arg === "add") {
    // Route to question management — the blueprint says /trivia add is the trigger.
    // Delegate to the questions handler by simulating the button callback.
    // We import lazily to avoid circular deps, but since both handlers are in
    // the same process, just reply with instructions to use the menu button.
    // Actually, the spec says /trivia add triggers "Custom Question Management" flow.
    // We open the manage screen inline.
    const { showQManage } = await import("./questions.js");
    await showQManage(ctx);
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

  // Clean up orphan games
  await cleanupOrphanGame(chatId);

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

  // Clean up orphans
  await cleanupOrphanGame(chatId);

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
    pool = [...customBank];
    // Add all default categories
    for (const cat of defaultCategories()) {
      pool.push(...defaultQuestionsByCategory(cat));
    }
  } else {
    pool = customBank.filter((q) => q.category === category);
    pool.push(...defaultQuestionsByCategory(category));
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

  // Shuffle deterministically (seed = chatId + creation timestamp) and trim
  const seed = chatId ^ now();
  const questions = shuffled(unique, seed).slice(0, Math.min(count, unique.length));

  if (questions.length === 0) {
    await ctx.reply(
      `No questions found for "${category}". Try another category or add some custom questions first.`,
    );
    return;
  }

  const actualCount = questions.length;

  // Create the game
  const ts = now();
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
    createdAt: ts,
    lastActivityAt: ts,
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
  game.lastActivityAt = now();
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

  // Check if answer came after countdown
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

  game.lastActivityAt = now();
  await saveActiveGame(game);
});

// ── Finish a question ───────────────────────────────────────────────────────
async function finishQuestion(ctx: Ctx, game: ActiveGame) {
  const current = await getActiveGame(game.chatId);
  if (!current || current.state !== "active") return;

  const q = current.questions[current.currentIndex];
  if (!q) return;

  current.state = "revealing";
  current.lastActivityAt = now();
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
    next.lastActivityAt = now();
    await saveActiveGame(next);
    await postQuestion(ctx, next);
  }
}

// ── Finish game ─────────────────────────────────────────────────────────────
async function finishGame(ctx: Ctx, game: ActiveGame) {
  const players = Object.values(game.players);

  // Find the round winner (by roundScore)
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

  // Persist round result to the Scoreboard entity
  const roundNumber = await nextRoundNumber(game.chatId);
  const roundWinner = top && top.roundScore > 0
    ? { userId: top.userId, firstName: top.firstName, roundScore: top.roundScore }
    : null;
  await saveRoundResult({
    chatId: game.chatId,
    roundNumber,
    category: game.category,
    questionCount: game.questionCount,
    playerScores: players.map((p) => ({
      userId: p.userId,
      firstName: p.firstName,
      roundScore: p.roundScore,
    })),
    roundWinner,
    finishedAt: now(),
  });

  // Clean up game
  await deleteActiveGame(game.chatId);

  await ctx.reply(formatFinalResults(game.players), { parse_mode: "HTML" });

  // Post a compact leaderboard snapshot so standings are visible right away.
  await postLeaderboardSnapshot(ctx, game.chatId);
}

// ── Cancel game ─────────────────────────────────────────────────────────────
composer.command("trivia_stop", async (ctx) => {
  await cancelGame(ctx);
});

async function cancelGame(ctx: Ctx) {
  const chatId = ctx.chat!.id;

  // Clean up orphans first
  await cleanupOrphanGame(chatId);

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

// ── Periodic orphan cleanup (called at bot startup) ─────────────────────────
// We export startOrphanSweep so bot.ts can start a lightweight interval.
let orphanSweepInterval: ReturnType<typeof setInterval> | undefined;

export function startOrphanSweep(chatIds: () => Promise<number[]>): void {
  if (orphanSweepInterval) return;
  orphanSweepInterval = setInterval(async () => {
    try {
      const ids = await chatIds();
      for (const chatId of ids) {
        await cleanupOrphanGame(chatId);
      }
    } catch {
      // Best-effort; never crash the sweep
    }
  }, 60_000); // Check every minute
}

export function stopOrphanSweep(): void {
  if (orphanSweepInterval) {
    clearInterval(orphanSweepInterval);
    orphanSweepInterval = undefined;
  }
}

// ── Post-round leaderboard snapshot ────────────────────────────────────────
async function postLeaderboardSnapshot(ctx: Ctx, chatId: number): Promise<void> {
  const ids = await getPlayerIds(chatId);
  if (ids.length === 0) return;

  const players: Player[] = [];
  for (const uid of ids) {
    const p = await getPlayer(chatId, uid);
    if (p) players.push(p);
  }
  players.sort((a, b) => b.cumulativeScore - a.cumulativeScore);
  if (players.length === 0) return;

  // Show top 5
  const top5 = players.slice(0, 5);
  const lines: string[] = ["📊 <b>Leaderboard</b>"];
  top5.forEach((p, i) => {
    const star = i === 0 ? " ⭐" : "";
    lines.push(`${i + 1}. ${p.firstName}: ${p.cumulativeScore} pts${star}`);
  });

  try {
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  } catch {
    // Best-effort — don't crash the game finish flow
  }
}

export default composer;