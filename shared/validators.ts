import { ROLES, ROLE_FACTION, FACTIONS, MAX_PLAYERS, MIN_PLAYERS, PRESETS } from './constants';
import type { GameSettings } from './types/game';

/**
 * 校验游戏配置合法性
 */
export function validateGameSettings(settings: GameSettings): { valid: boolean; error?: string } {
  let roles: Record<string, number>;

  if (settings.mode === 'preset') {
    if (!settings.preset || !PRESETS[settings.preset]) {
      return { valid: false, error: '无效的预设模板' };
    }
    roles = PRESETS[settings.preset];
  } else {
    roles = settings.roles;
  }

  // 计算总人数
  const totalPlayers = Object.values(roles).reduce((sum, count) => sum + count, 0);

  if (totalPlayers < MIN_PLAYERS) {
    return { valid: false, error: `总人数不能少于 ${MIN_PLAYERS} 人` };
  }
  if (totalPlayers > MAX_PLAYERS) {
    return { valid: false, error: `总人数不能超过 ${MAX_PLAYERS} 人` };
  }

  // 检查狼人数量
  const wolfCount = (roles[ROLES.WEREWOLF] || 0) + (roles[ROLES.WOLF_KING] || 0);
  if (wolfCount < 1) {
    return { valid: false, error: '至少需要 1 个狼人' };
  }

  // 好人数量必须大于狼人数量
  const goodCount = totalPlayers - wolfCount;
  if (goodCount <= wolfCount) {
    return { valid: false, error: '好人数量必须多于狼人数量' };
  }

  // 检查每个角色是否合法
  for (const [role, count] of Object.entries(roles)) {
    if (!ROLE_FACTION[role]) {
      return { valid: false, error: `未知角色：${role}` };
    }
    if (count < 0 || !Number.isInteger(count)) {
      return { valid: false, error: `角色数量不合法：${role}` };
    }
  }

  return { valid: true };
}

/**
 * 从配置中获取扁平角色列表
 */
export function getRolesFromSettings(settings: GameSettings): string[] {
  const roleConfig = settings.mode === 'preset' && settings.preset
    ? PRESETS[settings.preset]
    : settings.roles;

  const roles: string[] = [];
  for (const [role, count] of Object.entries(roleConfig)) {
    for (let i = 0; i < count; i++) {
      roles.push(role);
    }
  }
  return roles;
}

/**
 * 校验昵称格式
 */
export function validateNickname(nickname: string): { valid: boolean; error?: string } {
  if (!nickname || typeof nickname !== 'string') {
    return { valid: false, error: '昵称不能为空' };
  }
  const trimmed = nickname.trim();
  if (trimmed.length < 2 || trimmed.length > 8) {
    return { valid: false, error: '昵称长度必须在 2-8 个字符之间' };
  }
  return { valid: true };
}
