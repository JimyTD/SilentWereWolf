import type { Room, RoomPlayer } from './room';
import type {
  GameSettings,
  GamePlayer,
  Phase,
  Faction,
  IdentityMark,
  EvaluationMark,
  PlayerMarks,
  VoteRecord,
  DeathRecord,
  PlayerItem,
  NightActions,
} from './game';

// ========== 客户端 → 服务端 事件 ==========
export interface ClientToServerEvents {
  'room:create': (data: { settings: GameSettings }, callback: (res: RoomCreateResponse) => void) => void;
  'room:join': (data: { roomId: string; nickname: string }, callback: (res: RoomJoinResponse) => void) => void;
  'room:leave': () => void;
  'room:kick': (data: { targetUserId: string }) => void;
  'room:updateSettings': (data: { settings: GameSettings }) => void;
  'room:startGame': (callback: (res: BaseResponse) => void) => void;
  'room:addAI': (callback: (res: BaseResponse) => void) => void;
  'room:removeAI': (data: { targetUserId: string }) => void;
  'room:testAI': (callback: (res: BaseResponse) => void) => void;
  'client:nightAction': (data: NightActionPayload) => void;
  'client:submitMarks': (data: SubmitMarksPayload) => void;
  'client:vote': (data: { target: string }) => void;
  'client:hunterAction': (data: { action: 'shoot' | 'skip'; target?: string }) => void;
  'client:knightAction': (data: { action: 'duel' | 'skip'; target?: string }) => void;
  'client:wolfKingAction': (data: { action: 'drag' | 'skip'; target?: string }) => void;
}

// ========== 服务端 → 客户端 事件 ==========
export interface ServerToClientEvents {
  'server:connected': (data: ConnectedData) => void;
  'server:reconnected': (data: ReconnectedData) => void;
  'server:roomUpdate': (data: Room) => void;
  'server:playerJoined': (data: RoomPlayer) => void;
  'server:playerLeft': (data: { userId: string }) => void;
  'server:kicked': (data: { reason: string }) => void;
  'server:gameStart': (data: GameStartData) => void;
  'server:phaseChange': (data: PhaseChangeData) => void;
  'server:nightAction': (data: NightActionPrompt) => void;
  'server:witchInfo': (data: { victim: string | null }) => void;
  'server:wolfVoteUpdate': (data: { votes: Record<string, string> }) => void;
  'server:investigateResult': (data: { target: string; faction: Faction }) => void;
  'server:autopsyResult': (data: { target: string; faction: Faction }) => void;
  'server:dayAnnouncement': (data: DayAnnouncementData) => void;
  'server:hunterTrigger': (data: { canShoot: boolean; timeout: number }) => void;
  'server:hunterResult': (data: { shooter: string; target: string | null; targetDeath: boolean }) => void;
  'server:knightTurn': (data: { canDuel: boolean; timeout: number }) => void;
  'server:duelResult': (data: { loser: string }) => void;
  'server:markingTurn': (data: MarkingTurnData) => void;
  'server:marksRevealed': (data: PlayerMarks) => void;
  'server:votingStart': (data: VotingStartData) => void;
  'server:votingResult': (data: VotingResultData) => void;
  'server:foolImmunity': (data: { userId: string }) => void;
  'server:wolfKingTrigger': (data: { timeout: number }) => void;
  'server:wolfKingResult': (data: { dragger: string; target: string | null }) => void;
  'server:gameOver': (data: GameOverData) => void;
  'server:error': (data: { error: string; message: string }) => void;
}

// ========== Payload 类型 ==========
export interface BaseResponse {
  success: boolean;
  error?: string;
  message?: string;
}

export interface RoomCreateResponse extends BaseResponse {
  roomId?: string;
  room?: Room;
}

export interface RoomJoinResponse extends BaseResponse {
  room?: Room;
}

export interface ConnectedData {
  userId: string;
  roomId: string | null;
  room?: Room;
}

export interface ReconnectedData {
  room: Room;
  gameState: ClientGameState;
}

export interface GameStartData {
  role: string;
  faction: Faction;
  seatNumber: number;
  items: string[];
  teammates: { userId: string; seatNumber: number }[];
  players: PublicPlayerInfo[];
  settings: GameSettings;
  phase: Phase;
  round: number;
}

export interface PublicPlayerInfo {
  userId: string;
  nickname: string;
  seatNumber: number;
  alive: boolean;
}

export interface PhaseChangeData {
  phase: Phase;
  round: number;
}

export interface NightActionPrompt {
  role: string;
  timeout: number;
  availableTargets: string[];
  // 女巫额外信息
  witchInfo?: {
    victim: string | null;
    hasAntidote: boolean;
    hasPoison: boolean;
    canSelfSave: boolean;
  };
}

export interface NightActionPayload {
  action: string;
  target?: string;
  potion?: 'antidote' | 'poison' | 'none';
}

export interface DayAnnouncementData {
  round: number;
  type: 'night' | 'exile';
  deaths: {
    userId: string;
    seatNumber: number;
    cause: string;
    relics: PlayerItem[];
  }[];
  peacefulNight: boolean;
}

export interface MarkingTurnData {
  yourTurn: boolean;
  currentPlayer: string;
  timeout: number;
  evaluationMarkCount: number;
  availableIdentities: string[];
}

export interface SubmitMarksPayload {
  identityMark: IdentityMark;
  evaluationMarks: EvaluationMark[];
}

export interface VotingStartData {
  timeout: number;
  candidates: string[];
}

export interface VotingResultData {
  votes: VoteRecord[];
  exiled: string | null;
  tie: boolean;
}

export type GameOverReason = 'wolves_eliminated' | 'specials_eliminated' | 'villagers_eliminated' | 'good_eliminated';

export interface GameOverData {
  winner: Faction;
  reason: GameOverReason;
  players: (PublicPlayerInfo & {
    role: string;
    faction: Faction;
    items: PlayerItem[];
  })[];
  history: {
    rounds: NightActions[];
    marks: PlayerMarks[];
    votes: VoteRecord[][];
    deaths: DeathRecord[];
  };
}

// 客户端持有的游戏状态（服务端过滤后推送）
export interface ClientGameState {
  myRole: string;
  myFaction: Faction;
  myItems: string[];
  myTeammates: { userId: string; seatNumber: number }[];
  players: PublicPlayerInfo[];
  phase: Phase;
  round: number;
  marks: PlayerMarks[];
  votes: VoteRecord[][];
  announcements: DayAnnouncementData[];
  // 重连恢复用：查验历史（预言家/守墓人）
  investigations?: { target: string; faction: Faction }[];
}
