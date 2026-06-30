/**
 * Persistent key-value store for durable domain data.
 * Auto-selects: Redis (REDIS_URL) → in-memory (dev). Must not use
 * KEYS/SCAN/readAllKeys — all lookups go through explicit indices.
 */
import type { StorageAdapter } from "grammy";

// Reuse the toolkit's session-storage implementations for domain data.
import { MemorySessionStorage, RedisSessionStorage, resolveSessionStorage } from "./toolkit/index.js";

/**
 * A persistent KV store for domain data. The type parameter <T> is per-key
 * (the store is untyped internally — callers cast per key).
 */
export class PersistentStore {
  // Use StorageAdapter<object> — the PersistentStore wraps it with typed get/set.
  // deno-lint-disable no-explicit-any
  private constructor(private readonly adapter: StorageAdapter<any>) {}

  static create(): PersistentStore {
    const adapter = resolveSessionStorage<any>(undefined);
    return new PersistentStore(adapter);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const v = await this.adapter.read(key);
    return v as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.adapter.write(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.adapter.delete(key);
  }

  /**
   * Atomic check-and-set: writes value only if key does NOT already exist.
   * Returns true if the key was created, false if it already existed.
   */
  async setIfNotExists<T>(key: string, value: T): Promise<boolean> {
    const adapter = this.adapter as StorageAdapter<T> & { setIfNotExists?: (k: string, v: T) => Promise<boolean> | boolean };
    if (adapter.setIfNotExists) {
      return adapter.setIfNotExists(key, value);
    }
    // Fallback: check then set (NOT atomic — only used for adapters without SET NX)
    const existing = await this.adapter.read(key);
    if (existing !== undefined) return false;
    await this.adapter.write(key, value);
    return true;
  }
}

/** Singleton — created once per process. */
let _store: PersistentStore | undefined;

export function getStore(): PersistentStore {
  if (!_store) _store = PersistentStore.create();
  return _store;
}

/** Reset (test-only hook). */
export function __resetStore(): void {
  _store = undefined;
}

// ── Domain types ────────────────────────────────────────────────────────────

export interface Question {
  category: string;
  text: string;
  choices: string[];      // exactly 4 choices
  correctId: number;      // 0-3 index into choices
  sourceType: "default" | "custom";
  explanation?: string;
}

export interface Player {
  userId: number;
  firstName: string;
  cumulativeScore: number;
  wins: number;
  gamesPlayed: number;
  // per-round (transient, reset each game)
  roundScore: number;
}

export interface ActiveGame {
  chatId: number;
  category: string;
  questions: Question[];   // the selected questions for this round
  currentIndex: number;    // which question we're on (0-based)
  startTime: number;       // ms timestamp when current question was posted
  messageId: number;       // message_id of the current question post
  playerAnswers: Record<number, number>; // userId → chosen choice index
  players: Record<number, Player>;       // userId → Player (in-round state)
  state: "active" | "revealing" | "finished";
  questionCount: number;   // total questions in this round
  createdAt: number;       // ms timestamp of game creation
  lastActivityAt: number;  // ms timestamp of last activity (for timeout detection)
}

export interface GameConfig {
  chatId: number;
  questionCount: number;   // default 10
  countdownSec: number;    // default 12
}

export interface RoundResult {
  chatId: number;
  roundNumber: number;     // monotonically increasing per chat
  category: string;
  questionCount: number;
  playerScores: { userId: number; firstName: string; roundScore: number }[];
  roundWinner: { userId: number; firstName: string; roundScore: number } | null;
  finishedAt: number;      // ms timestamp
}

// ── Key builders ────────────────────────────────────────────────────────────

const PREFIX = "trivia:";

export function keyQBank(chatId: number): string {
  return `${PREFIX}qbank:${chatId}`;
}

export function keyPlayer(chatId: number, userId: number): string {
  return `${PREFIX}player:${chatId}:${userId}`;
}

export function keyPlayerIndex(chatId: number): string {
  return `${PREFIX}pindex:${chatId}`;
}

export function keyActiveGame(chatId: number): string {
  return `${PREFIX}game:${chatId}`;
}

export function keyConfig(chatId: number): string {
  return `${PREFIX}config:${chatId}`;
}

export function keyRoundCounter(chatId: number): string {
  return `${PREFIX}roundcnt:${chatId}`;
}

export function keyRoundResult(chatId: number, roundNumber: number): string {
  return `${PREFIX}round:${chatId}:${roundNumber}`;
}

export function keyRoundIndex(chatId: number): string {
  return `${PREFIX}roundidx:${chatId}`;
}

export function keyGameIndex(): string {
  return `${PREFIX}gameidx`;
}

// ── Domain operations ───────────────────────────────────────────────────────

/** Get the custom question bank for a chat. */
export async function getQuestionBank(chatId: number): Promise<Question[]> {
  const store = getStore();
  return (await store.get<Question[]>(keyQBank(chatId))) ?? [];
}

/** Add a question to a chat's custom bank. */
export async function addQuestion(chatId: number, q: Question): Promise<void> {
  const store = getStore();
  const bank = await getQuestionBank(chatId);
  bank.push(q);
  await store.set(keyQBank(chatId), bank);
}

/** Replace the entire custom bank (for CSV import). */
export async function setQuestionBank(chatId: number, questions: Question[]): Promise<void> {
  const store = getStore();
  await store.set(keyQBank(chatId), questions);
}

/** Delete a custom question by index. */
export async function deleteQuestion(chatId: number, index: number): Promise<void> {
  const store = getStore();
  const bank = await getQuestionBank(chatId);
  if (index >= 0 && index < bank.length) {
    bank.splice(index, 1);
    await store.set(keyQBank(chatId), bank);
  }
}

/** Get a player's stats. */
export async function getPlayer(chatId: number, userId: number): Promise<Player | undefined> {
  const store = getStore();
  return store.get<Player>(keyPlayer(chatId, userId));
}

/** Save a player's stats. */
export async function savePlayer(chatId: number, player: Player): Promise<void> {
  const store = getStore();
  await store.set(keyPlayer(chatId, player.userId), player);
  // Maintain the player index for this chat.
  const idx = (await store.get<number[]>(keyPlayerIndex(chatId))) ?? [];
  if (!idx.includes(player.userId)) {
    idx.push(player.userId);
    await store.set(keyPlayerIndex(chatId), idx);
  }
}

/** Get the list of player user IDs in a chat (for leaderboard). */
export async function getPlayerIds(chatId: number): Promise<number[]> {
  const store = getStore();
  return (await store.get<number[]>(keyPlayerIndex(chatId))) ?? [];
}

/** Get the active game for a chat. */
export async function getActiveGame(chatId: number): Promise<ActiveGame | undefined> {
  const store = getStore();
  return store.get<ActiveGame>(keyActiveGame(chatId));
}

/** Save the active game. Also maintains the global game index for orphan sweep. */
export async function saveActiveGame(game: ActiveGame): Promise<void> {
  const store = getStore();
  await store.set(keyActiveGame(game.chatId), game);
  // Maintain global index of chat IDs that have an active game
  const idx = await store.get<number[]>(keyGameIndex()) ?? [];
  if (!idx.includes(game.chatId)) {
    idx.push(game.chatId);
    await store.set(keyGameIndex(), idx);
  }
}

/**
 * Create a game atomically — only succeeds if no game exists for this chat.
 * Returns the created game, or undefined if a game already exists.
 */
export async function createGameIfNotExists(game: ActiveGame): Promise<ActiveGame | undefined> {
  const store = getStore();
  const created = await store.setIfNotExists(keyActiveGame(game.chatId), game);
  if (!created) return undefined;
  // Maintain global index
  const idx = await store.get<number[]>(keyGameIndex()) ?? [];
  if (!idx.includes(game.chatId)) {
    idx.push(game.chatId);
    await store.set(keyGameIndex(), idx);
  }
  return game;
}

/** Delete the active game (when finished or cancelled). Also cleans the index. */
export async function deleteActiveGame(chatId: number): Promise<void> {
  const store = getStore();
  await store.delete(keyActiveGame(chatId));
  // Remove from global index
  const idx = await store.get<number[]>(keyGameIndex()) ?? [];
  const pos = idx.indexOf(chatId);
  if (pos >= 0) {
    idx.splice(pos, 1);
    await store.set(keyGameIndex(), idx);
  }
}

/** Get all chat IDs that currently have an active game (for orphan sweep). */
export async function getActiveGameChatIds(): Promise<number[]> {
  const store = getStore();
  return (await store.get<number[]>(keyGameIndex())) ?? [];
}

/** Get game config for a chat. */
export async function getConfig(chatId: number): Promise<GameConfig> {
  const store = getStore();
  const def: GameConfig = { chatId, questionCount: 10, countdownSec: 12 };
  const saved = await store.get<GameConfig>(keyConfig(chatId));
  return saved ?? def;
}

/** Save game config for a chat. */
export async function saveConfig(config: GameConfig): Promise<void> {
  const store = getStore();
  await store.set(keyConfig(config.chatId), config);
}

/** Increment and return the next round number for a chat. */
export async function nextRoundNumber(chatId: number): Promise<number> {
  const store = getStore();
  const current = await store.get<number>(keyRoundCounter(chatId));
  const next = (current ?? 0) + 1;
  await store.set(keyRoundCounter(chatId), next);
  return next;
}

/** Save a round result and maintain the round index. */
export async function saveRoundResult(result: RoundResult): Promise<void> {
  const store = getStore();
  await store.set(keyRoundResult(result.chatId, result.roundNumber), result);
  // Maintain index of round numbers for this chat
  const idx = await store.get<number[]>(keyRoundIndex(result.chatId)) ?? [];
  if (!idx.includes(result.roundNumber)) {
    idx.push(result.roundNumber);
    await store.set(keyRoundIndex(result.chatId), idx);
  }
}

/** Get all round results for a chat. */
export async function getRoundResults(chatId: number): Promise<RoundResult[]> {
  const store = getStore();
  const nums = await store.get<number[]>(keyRoundIndex(chatId)) ?? [];
  const results: RoundResult[] = [];
  for (const n of nums) {
    const r = await store.get<RoundResult>(keyRoundResult(chatId, n));
    if (r) results.push(r);
  }
  return results.sort((a, b) => b.roundNumber - a.roundNumber);
}

/** Get the most recent round result. */
export async function getLastRoundResult(chatId: number): Promise<RoundResult | undefined> {
  const results = await getRoundResults(chatId);
  return results[0] ?? undefined;
}