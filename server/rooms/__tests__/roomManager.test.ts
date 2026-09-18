/**
 * RoomManager 的权限校验（离线，不触网）
 *
 * 覆盖「测试 AI」权限：该操作会真实调用一次模型、消耗一次额度，
 * 所以必须和 kick / updateSettings / startGame 一样在服务端校验，不能只靠前端按钮显隐。
 */
import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../shared/constants';
import type { GameSettings } from '../../../shared/types/game';
import { RoomManager } from '../RoomManager';

/** 4 人板子（1 狼 + 1 预言家 + 2 平民），与 joinRoom 的入座人数对应 */
function createSettings(): GameSettings {
  return {
    mode: 'custom',
    roles: {
      [ROLES.WEREWOLF]: 1,
      [ROLES.SEER]: 1,
      [ROLES.VILLAGER]: 2,
    },
    items: { enabled: false, pool: [] },
    timers: { marking: 60, voting: 30, nightAction: 20 },
    lastWords: false,
    deepMode: false,
    winCondition: 'edge',
  };
}

function createRoomWithHost(manager: RoomManager): string {
  const created = manager.createRoom('host', '房主', 'sock-host', createSettings());
  expect(created.success).toBe(true);
  return created.roomId!;
}

describe('测试 AI 的调用权限', () => {
  it('房主在等待中的房间可以通过', () => {
    const manager = new RoomManager();
    createRoomWithHost(manager);

    expect(manager.checkTestAIPermission('host')).toMatchObject({ success: true });
  });

  it('非房主被拒绝，且理由为 NOT_HOST', () => {
    const manager = new RoomManager();
    const roomId = createRoomWithHost(manager);
    manager.joinRoom(roomId, 'guest', '客人', 'sock-guest');

    const result = manager.checkTestAIPermission('guest');

    expect(result.success).toBe(false);
    expect(result.error).toBe('NOT_HOST');
  });

  it('不在任何房间的人被拒绝', () => {
    const manager = new RoomManager();

    const result = manager.checkTestAIPermission('nobody');

    expect(result.success).toBe(false);
    expect(result.error).toBe('NOT_IN_ROOM');
  });

  it('游戏进行中不允许测试（房主也不行）', () => {
    const manager = new RoomManager();
    const roomId = createRoomWithHost(manager);
    manager.joinRoom(roomId, 'p2', 'p2', 'sock-2');
    manager.joinRoom(roomId, 'p3', 'p3', 'sock-3');
    manager.joinRoom(roomId, 'p4', 'p4', 'sock-4');
    expect(manager.startGame('host').success).toBe(true);

    const result = manager.checkTestAIPermission('host');

    expect(result.success).toBe(false);
    expect(result.error).toBe('GAME_IN_PROGRESS');
  });
});
