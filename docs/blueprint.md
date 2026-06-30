# ChatTrivia — Bot specification

**Archetype:** community

**Voice:** friendly and competitive — write every user-facing message, button label, error, and empty state in this voice.

A fast-paced multiple-choice trivia bot for Telegram groups with live scoring, leaderboards, and admin-managed question packs. Runs timed rounds with countdowns, tracks per-round and all-time stats, and enforces single active game per chat.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Telegram group chat members (casual players)
- Group admins (question management)

## Success criteria

- Games start and end cleanly with live updates
- Leaderboards update accurately
- Concurrent games are prevented
- Custom questions persist per chat

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open trivia menu with start/setup options
- **/trivia start** (command, actor: user, command: /trivia start) — Begin new trivia round setup
- **/trivia stop** (command, actor: admin, command: /trivia stop) — Cancel active game
- **/leaderboard** (command, actor: user, command: /leaderboard) — Show group all-time leaderboard
- **Start New Game** (button, actor: user, callback: trivia:start) — Initiate trivia setup flow
  - inputs: category selection, question count
  - outputs: setup confirmation

## Flows

### Game Setup
_Trigger:_ /trivia start

1. Show category picker
2. Select question count
3. Confirm start
4. Validate no active game

_Data touched:_ Game Session

### Question Round
_Trigger:_ Game in progress

1. Post question with choices
2. Track answers with countdown
3. Calculate time-based scoring
4. Show live scoreboard
5. Post final results

_Data touched:_ Question, Player, Scoreboard

### Leaderboard Management
_Trigger:_ /leaderboard

1. Fetch top players
2. Show paginated list
3. Allow /mystats for personal stats

_Data touched:_ Player

### Custom Question Management
_Trigger:_ /trivia add

1. Admin prompt for question details
2. Validate CSV import
3. Add to chat's question bank

_Data touched:_ Question

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Game Session** _(retention: session)_ — Active trivia round state
  - fields: chat_id, current_question, timer_state, player_answers, round_scores
- **Question** _(retention: persistent)_ — Trivia question with choices and metadata
  - fields: category, text, choices, correct_id, source_type, explanation
- **Player** _(retention: persistent)_ — User participation stats
  - fields: telegram_id, round_score, cumulative_score, wins, games_played
- **Scoreboard** _(retention: persistent)_ — Live and historical rankings
  - fields: chat_id, player_scores, round_winner

## Integrations

- **Telegram** (required) — Group chat messaging and inline buttons
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Add/edit/delete custom questions
- View group leaderboard
- Cancel active games

## Notifications

- Game timeout alerts in chat
- Leaderboard updates after rounds
- Admin question import status

## Permissions & privacy

- Track user scores only within their chat
- Require admin role for question management
- No personal data beyond Telegram IDs

## Edge cases

- Concurrent game attempts
- Inactive game timeout during setup
- Players answering after countdown
- Multiple answers from same user

## Required tests

- End-to-end game flow with scoring
- Leaderboard persistence across sessions
- Custom question import validation
- Timeout handling for abandoned games

## Assumptions

- Default 12s per-question countdown
- Time-based scoring formula (100-20 points)
- One active game per chat enforced
- CSV format for question imports
