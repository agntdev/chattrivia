import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  confirmKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import { isAdmin } from "../admin.js";
import {
  type Question,
  addQuestion,
  getQuestionBank,
  deleteQuestion,
  setQuestionBank,
} from "../storage.js";

// ── Register main menu item ─────────────────────────────────────────────────
registerMainMenuItem({
  label: "📝 Manage Questions",
  data: "trivia:qmanage",
  order: 30,
});

const composer = new Composer<Ctx>();

// ── Entry: manage questions menu ────────────────────────────────────────────
composer.command("trivia_add", async (ctx) => {
  await showQManage(ctx);
});

composer.callbackQuery("trivia:qmanage", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showQManage(ctx);
});

async function showQManage(ctx: Ctx) {
  // Admin check for group chats
  if (ctx.chat?.type !== "private" && !(await isAdmin(ctx))) {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText("Only group admins can manage questions.");
    } else {
      await ctx.reply("Only group admins can manage questions.");
    }
    return;
  }

  const chatId = ctx.chat!.id;
  const bank = await getQuestionBank(chatId);

  const lines: string[] = [];
  lines.push("📝 <b>Custom Questions</b>\n");
  if (bank.length === 0) {
    lines.push("No custom questions yet. Tap ➕ Add to create one, or send a CSV file to import in bulk.");
  } else {
    lines.push(`${bank.length} custom question${bank.length === 1 ? "" : "s"} in your bank.\n`);
    // Show first few
    const preview = bank.slice(0, 5);
    for (let i = 0; i < preview.length; i++) {
      lines.push(`${i + 1}. ${preview[i].text.slice(0, 50)}${preview[i].text.length > 50 ? "…" : ""}`);
    }
    if (bank.length > 5) {
      lines.push(`...and ${bank.length - 5} more.`);
    }
  }

  const kb = inlineKeyboard([
    [
      inlineButton("➕ Add one manually", "trivia:qadd"),
      inlineButton("📥 Import CSV", "trivia:qcsv"),
    ],
    ...(bank.length > 0
      ? [[inlineButton("🗑 Clear all custom", "trivia:qclear")]]
      : []),
  ]);

  const text = lines.join("\n");
  if (ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, { reply_markup: kb, parse_mode: "HTML" });
  } else {
    await ctx.reply(text, { reply_markup: kb, parse_mode: "HTML" });
  }
}

// ── Add question manually ───────────────────────────────────────────────────
composer.callbackQuery("trivia:qadd", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.chat?.type !== "private" && !(await isAdmin(ctx))) {
    await ctx.reply("Only group admins can manage questions.");
    return;
  }
  await ctx.reply(
    "Send me a question to add. Use this format on ONE line:\n\n" +
      '<code>Category|Question text|Choice A|Choice B|Choice C|Choice D|CorrectIndex(0-3)</code>\n\n' +
      'Example:\n' +
      '<code>Science|What is H2O?|Water|Salt|Sugar|Oil|0</code>',
    { parse_mode: "HTML" },
  );
});

// ── CSV import prompt ───────────────────────────────────────────────────────
composer.callbackQuery("trivia:qcsv", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.chat?.type !== "private" && !(await isAdmin(ctx))) {
    await ctx.reply("Only group admins can manage questions.");
    return;
  }
  await ctx.reply(
    "Send me a CSV text (or paste it). Each line is one question:\n\n" +
      '<code>Category,Question,Choice A,Choice B,Choice C,Choice D,CorrectIndex</code>\n\n' +
      'Example:\n' +
      '<code>Science,What is H2O?,Water,Salt,Sugar,Oil,0</code>',
    { parse_mode: "HTML" },
  );
});

// ── Clear all custom questions ──────────────────────────────────────────────
composer.callbackQuery("trivia:qclear", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.chat?.type !== "private" && !(await isAdmin(ctx))) {
    await ctx.reply("Only group admins can manage questions.");
    return;
  }
  if (ctx.callbackQuery.message?.message_id) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery.message.message_id,
      "Delete all your custom questions? This can't be undone.",
      { reply_markup: confirmKeyboard("trivia:qclear:ok") },
    );
  }
});

composer.callbackQuery("trivia:qclear:ok:yes", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Cleared!" });
  const chatId = ctx.chat!.id;
  await setQuestionBank(chatId, []);
  await showQManage(ctx);
});

composer.callbackQuery("trivia:qclear:ok:no", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showQManage(ctx);
});

// ── Process question input (pipe-separated or CSV) ──────────────────────────
composer.on("message:text", async (ctx, next) => {
  // Only intercept when we're expecting question input
  const text = ctx.message.text.trim();

  // Check if this looks like a question import (pipe or comma separated)
  const isPipe = text.includes("|") && text.split("|").length >= 7;
  const isCsv = text.includes(",") && text.split(",").length >= 7 && !text.includes("|");

  if (!isPipe && !isCsv) {
    // Not a question import — let other handlers try
    return next();
  }

  // Admin check for group chats
  if (ctx.chat?.type !== "private" && !(await isAdmin(ctx))) {
    await ctx.reply("Only group admins can add questions.");
    return;
  }

  const chatId = ctx.chat!.id;
  const separator = isPipe ? "|" : ",";
  const lines = text.split("\n").filter((l) => l.trim() !== "");

  const added: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const parts = line.split(separator);
    if (parts.length < 7) {
      errors.push(`Line ${i + 1}: not enough fields (need 7, got ${parts.length})`);
      continue;
    }
    const [category, qText, a, b, c, d, correctStr] = parts.map((s) => s.trim());
    const correctId = Number(correctStr);
    if (isNaN(correctId) || correctId < 0 || correctId > 3) {
      errors.push(`Line ${i + 1}: correct index must be 0–3, got "${correctStr}"`);
      continue;
    }
    if (!qText) {
      errors.push(`Line ${i + 1}: question text is empty`);
      continue;
    }

    const q: Question = {
      category: category || "General",
      text: qText,
      choices: [a, b, c, d],
      correctId,
      sourceType: "custom",
    };
    await addQuestion(chatId, q);
    added.push(qText.slice(0, 40));
  }

  let msg = "";
  if (added.length > 0) {
    msg += `✅ Added ${added.length} question${added.length === 1 ? "" : "s"}`;
    if (errors.length > 0) msg += `, ${errors.length} error${errors.length === 1 ? "" : "s"}`;
    msg += ".";
  } else {
    msg += "❌ No questions added.";
  }
  if (errors.length > 0) {
    msg += `\n\n${errors.slice(0, 5).join("\n")}`;
    if (errors.length > 5) msg += `\n...and ${errors.length - 5} more errors.`;
  }

  await ctx.reply(msg);
});

export default composer;