// ========== 角色 ==========
export const ROLES = {
  WEREWOLF: 'werewolf',
  SEER: 'seer',
  WITCH: 'witch',
  HUNTER: 'hunter',
  GUARD: 'guard',
  GRAVEDIGGER: 'gravedigger',
  FOOL: 'fool',
  KNIGHT: 'knight',
  WOLF_KING: 'wolfKing',
  VILLAGER: 'villager',
} as const;

export const FACTIONS = {
  GOOD: 'good',
  EVIL: 'evil',
} as const;

// 角色→阵营映射
export const ROLE_FACTION: Record<string, string> = {
  [ROLES.WEREWOLF]: FACTIONS.EVIL,
  [ROLES.WOLF_KING]: FACTIONS.EVIL,
  [ROLES.SEER]: FACTIONS.GOOD,
  [ROLES.WITCH]: FACTIONS.GOOD,
  [ROLES.HUNTER]: FACTIONS.GOOD,
  [ROLES.GUARD]: FACTIONS.GOOD,
  [ROLES.GRAVEDIGGER]: FACTIONS.GOOD,
  [ROLES.FOOL]: FACTIONS.GOOD,
  [ROLES.KNIGHT]: FACTIONS.GOOD,
  [ROLES.VILLAGER]: FACTIONS.GOOD,
};

// 角色是否为神职（非平民的好人）
export const SPECIAL_ROLES: Set<string> = new Set([
  ROLES.SEER,
  ROLES.WITCH,
  ROLES.HUNTER,
  ROLES.GUARD,
  ROLES.GRAVEDIGGER,
  ROLES.FOOL,
  ROLES.KNIGHT,
]);

// ========== 游戏阶段 ==========
export const PHASES = {
  NIGHT: 'night',
  DAY_ANNOUNCEMENT: 'day_announcement',
  DAY_HUNTER: 'day_hunter',
  DAY_KNIGHT: 'day_knight',
  DAY_MARKING: 'day_marking',
  DAY_VOTING: 'day_voting',
  DAY_TRIGGER: 'day_trigger',
  GAME_OVER: 'game_over',
} as const;

// 夜晚行动顺序
export const NIGHT_ACTION_ORDER = [
  ROLES.GUARD,
  ROLES.WEREWOLF,
  ROLES.WITCH,
  ROLES.SEER,
  ROLES.GRAVEDIGGER,
] as const;

// ========== 房间 ==========
export const ROOM_STATUS = {
  WAITING: 'waiting',
  PLAYING: 'playing',
  FINISHED: 'finished',
} as const;

export const MAX_PLAYERS = 12;
export const MIN_PLAYERS = 4;
export const ROOM_ID_MIN = 100000;
export const ROOM_ID_MAX = 999999;
export const RECONNECT_TIMEOUT = 60000; // 60 秒
export const ROOM_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 分钟

// ========== 物品 ==========
export const ITEMS = {
  MOONSTONE: 'moonstone',
  BALANCE: 'balance',
  HOUND_WHISTLE: 'houndWhistle',
} as const;

// ========== 标记理由 ==========
export const COMMON_REASONS = {
  INTUITION: 'intuition',
  VOTE_ANALYSIS: 'vote_analysis',
  MARK_ANALYSIS: 'mark_analysis',
  LOG_REASONING: 'log_reasoning',
} as const;

export const SPECIAL_REASONS = {
  INVESTIGATION: 'investigation',
  POTION_RESULT: 'potion_result',
} as const;

// ========== 预设模板 ==========
export const PRESETS: Record<string, Record<string, number>> = {
  '4standard': {
    [ROLES.WEREWOLF]: 1,
    [ROLES.GUARD]: 1,
    [ROLES.WITCH]: 1,
    [ROLES.VILLAGER]: 1,
  },
  '5standard': {
    [ROLES.WEREWOLF]: 1,
    [ROLES.SEER]: 1,
    [ROLES.WITCH]: 1,
    [ROLES.VILLAGER]: 2,
  },
  '6standard': {
    [ROLES.WEREWOLF]: 2,
    [ROLES.SEER]: 1,
    [ROLES.WITCH]: 1,
    [ROLES.HUNTER]: 1,
    [ROLES.VILLAGER]: 1,
  },
  '9standard': {
    [ROLES.WEREWOLF]: 3,
    [ROLES.SEER]: 1,
    [ROLES.WITCH]: 1,
    [ROLES.HUNTER]: 1,
    [ROLES.GUARD]: 1,
    [ROLES.VILLAGER]: 2,
  },
};

// 死因枚举
export const DEATH_CAUSE = {
  ATTACKED: 'attacked',
  POISONED: 'poisoned',
  EXILED: 'exiled',
  SHOT: 'shot',
  WOLF_KING_DRAG: 'wolfKingDrag',
  DUEL: 'duel',
  GUARD_WITCH_CLASH: 'guardWitchClash',
} as const;

// 默认计时器（秒）
export const DEFAULT_TIMERS = {
  MARKING: 60,
  VOTING: 30,
  NIGHT_ACTION: 20,
} as const;
