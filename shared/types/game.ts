import type { ROLES, FACTIONS, PHASES, ITEMS, DEATH_CAUSE, COMMON_REASONS, SPECIAL_REASONS } from '../constants';

// ========== 基础类型 ==========
export type Role = typeof ROLES[keyof typeof ROLES];
export type Faction = typeof FACTIONS[keyof typeof FACTIONS];
export type Phase = typeof PHASES[keyof typeof PHASES];
export type ItemType = typeof ITEMS[keyof typeof ITEMS];
export type DeathCause = typeof DEATH_CAUSE[keyof typeof DEATH_CAUSE];
export type CommonReason = typeof COMMON_REASONS[keyof typeof COMMON_REASONS];
export type SpecialReason = typeof SPECIAL_REASONS[keyof typeof SPECIAL_REASONS];
export type MarkReason = CommonReason | SpecialReason;

// ========== 物品 ==========
export interface PlayerItem {
  type: ItemType;
  value: number | string;
  revealed: boolean;
}

// ========== 角色状态（各角色技能使用情况） ==========
export interface WitchState {
  antidoteUsed: boolean;
  poisonUsed: boolean;
}

export interface GuardState {
  lastGuardTarget: string | null; // userId
}

export interface FoolState {
  immunityUsed: boolean;
}

export interface KnightState {
  duelUsed: boolean;
}

export interface HunterState {
  canShoot: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export type RoleState = WitchState | GuardState | FoolState | KnightState | HunterState | Record<string, boolean | string | number | null>;

// ========== 玩家游戏状态 ==========
export interface GamePlayer {
  userId: string;
  seatNumber: number;
  role: Role;
  faction: Faction;
  alive: boolean;
  items: PlayerItem[];
  roleState: RoleState;
}

// ========== 夜晚行动 ==========
export interface NightActions {
  guard: { target: string | null } | null;
  wolves: {
    target: string | null;
    votes: Record<string, string>; // wolfUserId → targetUserId
  } | null;
  witch: {
    action: 'none' | 'antidote' | 'poison';
    target: string | null;
  } | null;
  seer: { target: string | null } | null;
  gravedigger: { target: string | null } | null;
}

// ========== 标记 ==========
export interface IdentityMark {
  identity: string;
  reason: MarkReason;
}

export interface EvaluationMark {
  target: string; // userId
  identity: string;
  reason: MarkReason;
}

export interface PlayerMarks {
  player: string; // userId
  round: number;
  identityMark: IdentityMark;
  evaluationMarks: EvaluationMark[];
}

// ========== 投票 ==========
export interface VoteRecord {
  voter: string; // userId
  target: string; // userId
}

// ========== 死亡记录 ==========
export interface DeathRecord {
  userId: string;
  seatNumber: number;
  cause: DeathCause;
  round: number;
  relics: PlayerItem[];
}

// ========== 游戏状态（服务端完整状态） ==========
export interface GameState {
  roomId: string;
  status: 'playing' | 'finished';
  round: number;
  phase: Phase;
  players: GamePlayer[];
  nightActions: NightActions;
  markingOrder: string[];
  markingCurrent: number;
  history: {
    rounds: NightActions[];
    marks: PlayerMarks[];
    votes: VoteRecord[][];
    deaths: DeathRecord[];
  };
  winner: Faction | null;
  // 夜晚当前等待的角色
  nightCurrentRole: Role | null;
  // 触发链队列
  pendingTriggers: PendingTrigger[];
}

export interface PendingTrigger {
  type: 'hunter_shoot' | 'wolf_king_drag' | 'fool_immunity' | 'knight_duel';
  userId: string;
  timeout: number;
}

// ========== 游戏配置 ==========
export interface GameSettings {
  mode: 'preset' | 'custom';
  preset?: string;
  roles: Record<string, number>;
  items: {
    enabled: boolean;
    pool: ItemType[];
  };
  timers: {
    marking: number;
    voting: number;
    nightAction: number;
  };
  lastWords: boolean;
  deepMode: boolean;
}
