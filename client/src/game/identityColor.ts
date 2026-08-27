const IDENTITY_COLORS: Record<string, string> = {
  狼人: 'text-red-400',
  白狼王: 'text-red-400',
  好人: 'text-blue-400',
  平民: 'text-blue-400',
  神职: 'text-green-400',
  预言家: 'text-green-400',
  女巫: 'text-green-400',
  守卫: 'text-green-400',
  猎人: 'text-green-400',
  守墓人: 'text-green-400',
  白痴: 'text-green-400',
  骑士: 'text-green-400',
};

const MARK_IDENTITY_SELECTED_COLOR = 'bg-indigo-600';

function getMarkIdentityColor(identity: string): string {
  return IDENTITY_COLORS[identity] || 'text-slate-100';
}

export function getIdentityColor(identity: string): string {
  return getMarkIdentityColor(identity);
}

export function getEvaluationColor(identity: string): string {
  return getMarkIdentityColor(identity);
}

export function getIdentityButtonColor(_identity: string): string {
  return MARK_IDENTITY_SELECTED_COLOR;
}
