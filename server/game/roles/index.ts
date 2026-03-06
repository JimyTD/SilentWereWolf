import { ROLES } from '../../../shared/constants';
import { BaseRole } from './BaseRole';
import { Werewolf } from './Werewolf';
import { WolfKing } from './WolfKing';
import { Seer } from './Seer';
import { Witch } from './Witch';
import { Guard } from './Guard';
import { Hunter } from './Hunter';
import { Gravedigger } from './Gravedigger';
import { Fool } from './Fool';
import { Knight } from './Knight';
import { Villager } from './Villager';

const roleMap: Record<string, new () => BaseRole> = {
  [ROLES.WEREWOLF]: Werewolf,
  [ROLES.WOLF_KING]: WolfKing,
  [ROLES.SEER]: Seer,
  [ROLES.WITCH]: Witch,
  [ROLES.GUARD]: Guard,
  [ROLES.HUNTER]: Hunter,
  [ROLES.GRAVEDIGGER]: Gravedigger,
  [ROLES.FOOL]: Fool,
  [ROLES.KNIGHT]: Knight,
  [ROLES.VILLAGER]: Villager,
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
