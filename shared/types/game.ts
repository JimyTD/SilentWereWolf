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

/** 白痴首次被放逐时的公开免疫事件。该玩家存活，但身份公开且失去投票权。 */
export interface FoolImmunityRecord {
  userId: string;
  seatNumber: number;
  round: number;
}

// ========== 玩家私有信息（按角色裁剪后下发给本人） ==========

export interface PotionRecord {
  round: number;
  potion: 'antidote' | 'poison';
  target: string | null; // userId（解药救人时的被袭击者，可能为 null）
}

export interface GuardRecord {
  round: number;
  target: string; // userId
}

export interface WolfAttackRecord {
  round: number;
  target: string; // userId
}

export interface InvestigationRecord {
  round: number;
  kind: 'seer' | 'gravedigger';
  target: string; // userId
  faction: Faction;
}

/**
 * 玩家本人的角色资源与操作历史。
 * 只包含该玩家有权看到的私有信息，绝不包含他人私有信息。
 * 开局、阶段切换、夜晚行动提交与重连时由服务端下发，AI 上下文也复用同一份构建逻辑。
 */
export interface MyPrivateInfo {
  // 女巫：药水剩余情况与用药历史
  witch?: {
    antidoteUsed: boolean;
    poisonUsed: boolean;
    potionHistory: PotionRecord[];
  };
  // 守卫：上一轮守护目标（不可连守）与守护历史
  guard?: {
    lastGuardTarget: string | null;
    history: GuardRecord[];
  };
  // 预言家/守墓人：查验历史
  investigations?: InvestigationRecord[];
  // 狼人/白狼王：历轮袭击目标
  wolfAttacks?: WolfAttackRecord[];
  // 猎人：当前是否还能开枪
  hunterCanShoot?: boolean;
  // 骑士：是否已发动过决斗
  knightDuelUsed?: boolean;
  // 白痴：免疫是否已消耗
  foolImmunityUsed?: boolean;
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
    foolImmunities: FoolImmunityRecord[];
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

// ========== 胜利条件 ==========
export type WinCondition = 'edge' | 'city';

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
  winCondition: WinCondition;
}
