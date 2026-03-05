import type { GameState, GamePlayer } from '../../../shared/types/game';
import { BaseRole } from './BaseRole';

export class Werewolf extends BaseRole {
  readonly roleName = 'werewolf';
  readonly faction = 'evil' as const;
  readonly hasNightAction = true;

  performNightAction(gameState: GameState, player: GamePlayer, action: { target?: string }): boolean {
    if (!action.target) return false;

    if (!gameState.nightActions.wolves) {
      gameState.nightActions.wolves = { target: null, votes: {} };
    }

    gameState.nightActions.wolves.votes[player.userId] = action.target;

    // 检查所有存活狼人是否都已投票
    const aliveWolves = gameState.players.filter(
      p => p.alive && (p.role === 'werewolf' || p.role === 'wolfKing')
    );
    const votedWolves = Object.keys(gameState.nightActions.wolves.votes);
    const allVoted = aliveWolves.every(w => votedWolves.includes(w.userId));

    if (allVoted) {
      // 统计票数，选出目标
      const voteCount: Record<string, number> = {};
      for (const targetId of Object.values(gameState.nightActions.wolves.votes)) {
        voteCount[targetId] = (voteCount[targetId] || 0) + 1;
      }
      // 票数最高者为目标，平票随机选
      let maxVotes = 0;
      const candidates: string[] = [];
      for (const [targetId, count] of Object.entries(voteCount)) {
        if (count > maxVotes) {
          maxVotes = count;
          candidates.length = 0;
          candidates.push(targetId);
        } else if (count === maxVotes) {
          candidates.push(targetId);
        }
      }
      gameState.nightActions.wolves.target =
        candidates[Math.floor(Math.random() * candidates.length)];
    }

    return true;
  }

  getAvailableTargets(gameState: GameState, player: GamePlayer): string[] {
    // 狼人可以攻击任何存活的非狼队友玩家（包括自己，自刀是合法策略）
    const wolfTeammateIds = new Set(
      gameState.players
        .filter(p => p.alive && p.faction === 'evil' && p.userId !== player.userId)
        .map(p => p.userId)
    );
    return gameState.players
      .filter(p => p.alive && !wolfTeammateIds.has(p.userId))
      .map(p => p.userId);
  }
}
