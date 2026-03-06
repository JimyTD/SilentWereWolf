import type { GameState, GamePlayer } from '../../../shared/types/game';
import { DEATH_CAUSE } from '../../../shared/constants';
import { Werewolf } from './Werewolf';

/**
 * 白狼王：继承狼人的夜晚行动逻辑
 * 额外能力：被放逐时可选择带走一名存活玩家
 * - 被女巫毒死：不能带人
 * - 被骑士决斗：不能带人
 */
export class WolfKing extends Werewolf {
  override readonly roleName = 'wolfKing';

  onDeath(
    _gameState: GameState,
    player: GamePlayer,
    cause: string
  ): { type: string; userId: string } | null {
    // 只有被放逐时才能带人
    if (cause === DEATH_CAUSE.EXILED) {
      return { type: 'wolf_king_drag', userId: player.userId };
    }
    return null;
  }
}
