import type { GameState, GamePlayer } from '../../../shared/types/game';

/**
 * 角色基类，定义所有角色共用的接口
 */
export abstract class BaseRole {
  abstract readonly roleName: string;
  abstract readonly faction: 'good' | 'evil';
  abstract readonly hasNightAction: boolean;

  /**
   * 执行夜晚行动
   * 返回 true 表示行动已处理
   */
  abstract performNightAction(
    gameState: GameState,
    player: GamePlayer,
    action: { target?: string; potion?: string }
  ): boolean;

  /**
   * 获取夜晚可选目标列表
   */
  abstract getAvailableTargets(gameState: GameState, player: GamePlayer): string[];

  /**
   * 被出局时的触发效果（如猎人开枪）
   * 返回需要进入触发队列的事件，null 表示无触发
   */
  onDeath(
    _gameState: GameState,
    _player: GamePlayer,
    _cause: string
  ): { type: string; userId: string } | null {
    return null;
  }

  /**
   * 被放逐时的特殊处理（如白痴免疫）
   * 返回 true 表示阻止了出局
   */
  onExile(_gameState: GameState, _player: GamePlayer): boolean {
    return false;
  }
}
