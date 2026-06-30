import type { Ctx } from "./bot.js";

/**
 * Check if the user is an admin in the current chat. In private chats,
 * the user is always their own admin. In group chats, we check the
 * member's status.
 */
export async function isAdmin(ctx: Ctx): Promise<boolean> {
  // Private chats: the single user is always "admin" of their own bot
  if (ctx.chat?.type === "private") return true;

  // In groups, check member status via getChatMember
  try {
    const member = await ctx.api.getChatMember(ctx.chat!.id, ctx.from!.id);
    return member.status === "creator" || member.status === "administrator";
  } catch {
    // If we can't check, be permissive in private chats, deny in groups
    return false;
  }
}