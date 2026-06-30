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

// ── Entry: /trivia_add command ──────────────────────────────────────────────
composer.command("trivia_add", async (ctx) => {
  await showQManage(ctx);
});

composer.callbackQuery("trivia:qmanage", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showQManage(ctx);
});

// Exported so game.ts /trivia add can also open the manage screen.
export async function showQManage(ctx: Ctx) {
  const chatId = ctx.chat!.id;

  // Admin check for group chats
  if (ctx.chat?.type !== "private" && !(await isAdmin(ctx))) {
    const deny = "Only group admins can manage questions.";
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(deny);
    } else {
      await ctx.reply(deny);
    }
    return;
  }

  const bank = await getQuestionBank(chatId);

  const lines: string[] = [];
  lines.push("📝 <b>Custom Questions</b>\n");
  if (bank.length === 0) {
    lines.push("No custom questions yet. Tap ➕ Add to create one, or send a CSV file to import in bulk.");
  } else {
    lines.push(`${bank.length} custom question${bank.length === 1 ? "" : "s"} in your bank.\n`);

    // Build keyboard with per-question delete buttons
    const rows: ReturnType<typeof inlineButton>[][] = [];

    // Show up to 10 questions with delete and edit buttons
    const show = bank.slice(0, 10);
    for (let i = 0; i < show.length; i++) {
      const q = show[i];
      const label =
        q.text.length > 40 ? q.text.slice(0, 40) + "…" : q.text;
      lines.push(`${i + 1}. [${q.category}] ${label}`);
      // Add edit + delete buttons for this question
      rows.push([
        inlineButton(`✏️ Edit #${i + 1}`, `trivia:qedit:${i}`),
        inlineButton(`🗑 Delete #${i + 1}`, `trivia:qdel:${i}`),
      ]);
    }
    if (bank.length > 10) {
      lines.push(`\n...and ${bank.length - 10} more. Delete to see older ones.`);
    }

    const kb = inlineKeyboard([
      [
        inlineButton("➕ Add one manually", "trivia:qadd"),
        inlineButton("📥 Import CSV", "trivia:qcsv"),
      ],
      ...rows,
      [inlineButton("🗑 Clear all custom", "trivia:qclear")],
    ]);

    const text = lines.join("\n");
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, { reply_markup: kb, parse_mode: "HTML" });
    } else {
      await ctx.reply(text, { reply_markup: kb, parse_mode: "HTML" });
    }
    return;
  }

  // Empty bank: just add/import/back
  const kb = inlineKeyboard([
    [
      inlineButton("➕ Add one manually", "trivia:qadd"),
      inlineButton("📥 Import CSV", "trivia:qcsv"),
    ],
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
  // Set session gate so only the NEXT text message is treated as question input
  ctx.session.questionImportMode = "pipe";
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
  // Set session gate so only the NEXT text message is treated as CSV import
  ctx.session.questionImportMode = "csv";
  await ctx.reply(
    "Send me a CSV text (or paste it). Each line is one question:\n\n" +
      '<code>Category,Question,Choice A,Choice B,Choice C,Choice D,CorrectIndex</code>\n\n' +
      'Example:\n' +
      '<code>Science,What is H2O?,Water,Salt,Sugar,Oil,0</code>',
    { parse_mode: "HTML" },
  );
});

// ── Per-question delete ──────────────────────────────────────────────────────
composer.callbackQuery(/^trivia:qdel:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.chat?.type !== "private" && !(await isAdmin(ctx))) {
    await ctx.reply("Only group admins can manage questions.");
    return;
  }
  const index = Number(ctx.match[1]);
  const chatId = ctx.chat!.id;
  const bank = await getQuestionBank(chatId);
  const q = bank[index];
  if (!q) {
    await ctx.reply("That question no longer exists.");
    return;
  }

  if (ctx.callbackQuery.message?.message_id) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery.message.message_id,
      `Delete this question?\n\n<b>${q.text}</b>`,
      {
        parse_mode: "HTML",
        reply_markup: confirmKeyboard(`trivia:qdel:ok:${index}`),
      },
    );
  }
});

composer.callbackQuery(/^trivia:qdel:ok:(\d+):yes$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Deleted!" });
  const index = Number(ctx.match[1]);
  const chatId = ctx.chat!.id;
  await deleteQuestion(chatId, index);
  await showQManage(ctx);
});

composer.callbackQuery(/^trivia:qdel:ok:(\d+):no$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showQManage(ctx);
});

// ── Per-question edit ────────────────────────────────────────────────────────
composer.callbackQuery(/^trivia:qedit:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.chat?.type !== "private" && !(await isAdmin(ctx))) {
    await ctx.reply("Only group admins can manage questions.");
    return;
  }
  const index = Number(ctx.match[1]);
  const chatId = ctx.chat!.id;
  const bank = await getQuestionBank(chatId);
  const q = bank[index];
  if (!q) {
    await ctx.reply("That question no longer exists.");
    return;
  }

  // Show editing instructions with current question data
  await ctx.reply(
    `Editing question #${index + 1}:\n\n` +
      `<b>${q.text}</b>\n` +
      `Category: ${q.category}\n` +
      `Choices: ${q.choices.join(" | ")}\n` +
      `Correct: ${q.choices[q.correctId]} (index ${q.correctId})\n\n` +
      `Send me the updated question in this format:\n` +
      '<code>Category|Question text|Choice A|Choice B|Choice C|Choice D|CorrectIndex(0-3)</code>\n\n' +
      `The old question will be replaced. Send "cancel" to abort.`,
    { parse_mode: "HTML" },
  );

  // Store the index being edited in session
  ctx.session.questionImportMode = "pipe"; // reuse pipe parser
  ctx.session.questionEditIndex = index;
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
// Gated by session.questionImportMode — only intercepts text when the user
// explicitly entered question-import mode via the "Add" or "CSV" button.
composer.on("message:text", async (ctx, next) => {
  // Only intercept when we're expecting question input
  const mode = ctx.session.questionImportMode;
  if (!mode) {
    return next();
  }

  // Check for cancel
  const text = ctx.message.text.trim();
  if (text.toLowerCase() === "cancel") {
    ctx.session.questionImportMode = undefined;
    await ctx.reply("Cancelled importing questions.");
    return;
  }

  // Clear the mode — one shot
  ctx.session.questionImportMode = undefined;

  // Admin check for group chats
  if (ctx.chat?.type !== "private" && !(await isAdmin(ctx))) {
    await ctx.reply("Only group admins can add questions.");
    return;
  }

  const chatId = ctx.chat!.id;
  const separator = mode === "pipe" ? "|" : ",";
  const lines = text.split("\n").filter((l) => l.trim() !== "");

  const editIndex = ctx.session.questionEditIndex;
  if (editIndex !== undefined) {
    ctx.session.questionEditIndex = undefined;
    // Only single-line edit supported
    return processEdit(ctx, chatId, editIndex, lines[0]?.trim() ?? text, separator);
  }

  return processImport(ctx, chatId, lines, separator);
});

// ── CSV parsing with quote support ────────────────────────────────────────────

/**
 * Split a single CSV/pipe-delimited line into fields, respecting double-quoted
 * fields that may contain the separator character. Standard CSV rules:
 *   - Fields containing the separator, double-quote, or newline are quoted.
 *   - A double-quote inside a quoted field is escaped as "".
 */
function parseCSVLine(line: string, separator: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          // Escaped double-quote: "" → "
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"' && current.length === 0) {
        inQuotes = true;
      } else if (ch === separator) {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

async function processEdit(
  ctx: Ctx,
  chatId: number,
  editIndex: number,
  line: string,
  separator: string,
) {
  const bank = await getQuestionBank(chatId);
  if (editIndex < 0 || editIndex >= bank.length) {
    await ctx.reply("That question no longer exists.");
    return;
  }

  const parts = parseCSVLine(line, separator).map((s) => s.trim());
  if (parts.length < 7) {
    await ctx.reply(`Not enough fields — need 7, got ${parts.length}. Edit cancelled.`);
    return;
  }
  const [category, qText, a, b, c, d, correctStr] = parts;
  const correctId = Number(correctStr);
  if (isNaN(correctId) || correctId < 0 || correctId > 3) {
    await ctx.reply(`Correct index must be 0–3, got "${correctStr}". Edit cancelled.`);
    return;
  }
  if (!qText) {
    await ctx.reply("Question text can't be empty. Edit cancelled.");
    return;
  }

  bank[editIndex] = {
    category: category || "General",
    text: qText,
    choices: [a, b, c, d],
    correctId,
    sourceType: "custom",
  };
  await setQuestionBank(chatId, bank);
  await ctx.reply(`✅ Question #${editIndex + 1} updated.`);
}

async function processImport(
  ctx: Ctx,
  chatId: number,
  lines: string[],
  separator: string,
) {
  const added: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const parts = parseCSVLine(line, separator).map((s) => s.trim());
    if (parts.length < 7) {
      errors.push(`Line ${i + 1}: not enough fields (need 7, got ${parts.length})`);
      continue;
    }
    const [category, qText, a, b, c, d, correctStr] = parts;
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
}

export default composer;