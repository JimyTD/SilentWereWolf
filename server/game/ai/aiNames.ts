/**
 * AI 默认昵称池（LLM 取名失败时兜底）
 */
const DEFAULT_NAMES = [
  '林夕', '陈北', '苏然', '韩明', '沈默', '叶知秋',
  '顾南', '白川', '许晴', '周也', '方远', '江澄',
  '温宁', '魏然', '谢遥', '蓝湛', '赵简', '钱进',
  '孙朗', '李默', '吴声', '郑风', '王逸', '冯唐',
  '褚遂', '卫庄', '秦朗', '杨柳', '朱雀', '何安',
];

let nameIndex = 0;

/**
 * 从默认昵称池中获取一个不与已有昵称重复的名字
 */
export function getDefaultAIName(existingNames: string[]): string {
  const existing = new Set(existingNames);

  for (let i = 0; i < DEFAULT_NAMES.length; i++) {
    const idx = (nameIndex + i) % DEFAULT_NAMES.length;
    const name = DEFAULT_NAMES[idx];
    if (!existing.has(name)) {
      nameIndex = (idx + 1) % DEFAULT_NAMES.length;
      return name;
    }
  }

  // 所有默认名字都用完了，生成带编号的名字
  let counter = 1;
  while (existing.has(`旅人${counter}`)) {
    counter++;
  }
  return `旅人${counter}`;
}
