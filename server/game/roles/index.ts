import { ROLES } from '../../../shared/constants';
import { BaseRole } from './BaseRole';
import { Werewolf } from './Werewolf';
import { Seer } from './Seer';
import { Witch } from './Witch';
import { Guard } from './Guard';
import { Villager } from './Villager';

const roleMap: Record<string, new () => BaseRole> = {
  [ROLES.WEREWOLF]: Werewolf,
  [ROLES.WOLF_KING]: Werewolf, // 首版白狼王复用狼人逻辑，次版扩展
  [ROLES.SEER]: Seer,
  [ROLES.WITCH]: Witch,
  [ROLES.GUARD]: Guard,
  [ROLES.VILLAGER]: Villager,
  // 次版角色占位：
  // [ROLES.HUNTER]: Hunter,
  // [ROLES.GRAVEDIGGER]: Gravedigger,
  // [ROLES.FOOL]: Fool,
  // [ROLES.KNIGHT]: Knight,
};

export function createRole(roleName: string): BaseRole {
  const RoleClass = roleMap[roleName];
  if (!RoleClass) {
    // 未实现的角色降级为平民
    return new Villager();
  }
  return new RoleClass();
}

export { BaseRole } from './BaseRole';
