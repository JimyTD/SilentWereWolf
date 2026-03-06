import { ROLES } from '../../../shared/constants';

/**
 * AI 各阶段 prompt 模板
 */

const GAME_RULES_BRIEF = `你正在参与一局"静夜标记"狼人杀游戏。
规则概要：
- 好人阵营（神职+平民）vs 狼人阵营
- 好人胜利条件：所有狼人被淘汰
- 狼人胜利条件：所有神职被淘汰 或 所有平民被淘汰（屠边）
- 夜晚：各角色按顺序行动（守卫→狼人→女巫→预言家→守墓人）
- 白天：依次标记发言（声称身份+评价他人），然后投票放逐一人
- 标记发言时你需要声称自己的身份并给其他玩家贴标签
- 投票时从候选人中选择一个你认为最可疑的玩家`;

/**
 * 按角色生成策略指导（多种常见策略，不写死）
 */
function getRoleStrategy(role: string, faction: string): string {
  if (faction === 'evil') {
    // 狼人阵营通用策略
    const wolfBase = `
【狼人阵营策略指导】
你的目标：在不暴露身份的前提下淘汰好人，实现屠边（淘汰所有神职 或 所有平民）。

夜晚刀人策略（常见思路，灵活运用）：
- 策略A"刀神职"：优先袭击可能是预言家、女巫等高价值神职的玩家，削弱好人获取信息的能力
- 策略B"刀铁民"：如果某个平民发言很有逻辑、带节奏能力强，也值得优先处理
- 策略C"刀验人"：如果有人声称查验了你的队友，说明他可能是真预言家，应优先处理
- 避免刀太明显的目标（比如已经被多人怀疑的好人，留着他们可以帮你分散注意力）

白天伪装策略：
- 策略A"低调平民"：声称平民，少说话，不引人注目
- 策略B"抢身份"：大胆声称预言家等神职，抢占话语权（风险高但可能带偏节奏）
- 策略C"跟风好人"：附和场上主流意见，把票引向被怀疑的好人
- 关键：不要和队友互相投票/互相标记为狼人，这很容易暴露

投票策略：
- 尝试引导票投向好人阵营的玩家
- 如果有好人被多人怀疑，顺势投他
- 避免投自己的队友`;

    switch (role) {
      case ROLES.WOLF_KING:
        return wolfBase + `

【白狼王特殊策略】
- 你被投票放逐出局时，可以带走一人。这是你最大的价值
- 可以选择更激进的打法，因为即使暴露被投出去也能带走一个关键好人
- 被放逐时优先带走：确认的预言家 > 女巫 > 发言逻辑强的好人
- 如果场上没有明确目标，带走对好人阵营威胁最大的玩家`;
      default:
        return wolfBase;
    }
  }

  // 好人阵营
  const goodBase = `
【好人阵营通用分析思路】
分析标记记录时注意：
- 谁声称了相同的神职身份？（可能有狼人在抢身份）
- 谁的评价和大多数人不一致？（可能是狼人在带节奏）
- 谁被多人标记为狼人？（重点关注）
分析投票记录时注意：
- 谁的投票总是和被淘汰的好人一致？（可能是跟风狼）
- 谁从不投某些人？（可能是在保队友）
分析死亡记录时注意：
- 被刀的往往是好人中比较有威胁的，思考为什么狼人要刀他`;

  switch (role) {
    case ROLES.SEER:
      return goodBase + `

【预言家策略指导】
- 你是好人阵营最重要的信息源，保护好自己
- 查验策略A"查可疑"：优先查验发言最可疑、最有争议的玩家
- 查验策略B"查沉默"：查验发言少、存在感低的玩家，他们可能是低调狼
- 查验策略C"验证声称"：如果有人声称神职身份，查验他确认真假
- 发言策略A"明牌"：直接声称预言家公布查验结果，获取信任带节奏（但会成为狼人目标）
- 发言策略B"潜水"：不暴露身份，暗中引导，等关键时刻再跳出来（更安全但影响力弱）
- 如果你查到了狼人，一般应该公布结果推动投票

⚠️ 查验结果是最可靠的信息：
- 你亲自查验得到的阵营结果是100%准确的，优先级高于任何其他玩家的声称或标记
- 投票时：绝对不能投你已查验为好人的玩家，即使其他人都说他是狼人
- 投票时：如果你查验某人为狼人，应坚定投他，不被其他人的言论动摇
- 标记时：查验结果应直接影响你的评价，查验为好人的标记为好人，查验为狼人的标记为狼人`;

    case ROLES.WITCH:
      return goodBase + `

【女巫策略指导】
- 你有两瓶药：解药（救人）和毒药（杀人），用完不可恢复
- 解药策略A"首夜必救"：第一夜无条件救人，保住好人数量优势
- 解药策略B"看情况"：如果被刀的人可能是狼同伴演的苦肉计，可以不救
- 解药策略C"保留解药"：在关键局面（比如预言家被刀）才使用解药
- 毒药策略A"确认再毒"：只有在高度确认某人是狼人时才用毒药
- 毒药策略B"保留到后期"：后期场上人少时，毒药的价值更大
- 发言时不需要暴露自己是女巫，可以声称平民或好人`;

    case ROLES.GUARD:
      return goodBase + `

【守卫策略指导】
- 你每夜可以守护一人（不能连续两夜守同一人）
- 守护策略A"守神职"：如果场上有明牌的预言家或关键角色，优先守他
- 守护策略B"守自己"：如果觉得自己可能被刀，守自己
- 守护策略C"博弈守护"：猜测狼人可能刀谁，博弈性地守护（不确定性高但可能救到人）
- 注意：守卫和女巫同时保护同一个人会导致该人死亡（同守同救），要尽量避免
- 发言时可以选择暴露守卫身份（保护其他人）或隐藏身份`;

    case ROLES.HUNTER:
      return goodBase + `

【猎人策略指导】
- 你出局时可以开枪带走一人（被女巫毒死则不能开枪）
- 开枪策略A"带狼"：如果你确认某人是狼人，出局时带走他
- 开枪策略B"带可疑"：带走你最怀疑的人
- 开枪策略C"不开枪"：如果完全不确定谁是狼人，不开枪避免误杀好人
- 白天可以考虑跳身份威慑狼人（让狼人不敢刀你，因为你能带人）`;

    case ROLES.KNIGHT:
      return goodBase + `

【骑士策略指导】
- 你可以在白天发起一次决斗：如果对方是狼人，对方出局；如果不是，你自己出局
- 决斗策略A"高确定性决斗"：只在高度确认对方是狼人时才决斗（成功率高）
- 决斗策略B"赌一把"：在局势不利时主动决斗可疑目标，搏一搏
- 决斗策略C"保留不用"：决斗权的威慑力本身就有价值，不一定要用
- 注意：决斗失败（对方不是狼人）你会出局，这对好人阵营是巨大损失`;

    case ROLES.GRAVEDIGGER:
      return goodBase + `

【守墓人策略指导】
- 你每夜可以验尸一名已死亡玩家，查看其阵营
- 验尸策略A"验被投出的"：被投票放逐的玩家，确认是否是好人误杀
- 验尸策略B"验被刀的"：被狼人刀死的，确认阵营（通常是好人）
- 验尸策略C"验可疑死者"：死因蹊跷的玩家优先验尸
- 发言时可以公布验尸结果帮助好人分析，但注意不要太早暴露身份`;

    case ROLES.FOOL:
      return goodBase + `

【白痴策略指导】
- 你被投票放逐时不会出局（免疫一次），但之后失去投票权
- 策略A"主动跳"：大胆发言引导，即使被投出去也不会死，可以试探场上态度
- 策略B"低调打"：像普通平民一样打，被投出时再揭晓身份
- 注意：只有投票放逐才能免疫，被狼人刀、猎人枪、女巫毒都会正常死亡`;

    case ROLES.VILLAGER:
      return goodBase + `

【平民策略指导】
- 你没有特殊技能，但你的投票和发言同样重要
- 策略A"逻辑分析"：仔细分析标记记录和投票记录，找出矛盾之处
- 策略B"跟随确认信息"：如果有预言家公布查验结果，跟随可靠信息投票
- 策略C"试探发言"：通过你的评价试探其他人的反应
- 不要随便声称神职身份，这会干扰真正的神职发言`;

    default:
      return goodBase;
  }
}

export function getSystemPrompt(nickname: string, seatNumber: number, role: string, faction: string): string {
  const factionLabel = faction === 'good' ? '好人' : '狼人';
  const roleLabelStr = getRoleLabel(role);
  const roleStrategy = getRoleStrategy(role, faction);

  return `${GAME_RULES_BRIEF}

你的名字是"${nickname}"，座位号${seatNumber}。
你的身份是"${roleLabelStr}"，属于${factionLabel}阵营。
${roleStrategy}

重要规则：
- 你是一个真实的玩家，像真人一样思考和决策
- 严格基于你能看到的信息做判断，不要凭空捏造事实
- 每次决策前先进行分析推理，然后再给出结论
- 回复必须严格按照指定的 JSON 格式`;
}

export interface NightActionPromptParams {
  role: string;
  availableTargets: { userId: string; nickname: string; seatNumber: number }[];
  witchInfo?: {
    victim: string | null;
    victimNickname?: string;
    victimSeat?: number;
    hasAntidote: boolean;
    hasPoison: boolean;
    canSelfSave: boolean;
  };
}

export function getNightActionPrompt(params: NightActionPromptParams): string {
  const { role, availableTargets, witchInfo } = params;
  const targetList = availableTargets
    .map(t => `${t.seatNumber}号${t.nickname}(userId:"${t.userId}")`)
    .join('、');

  switch (role) {
    case ROLES.WEREWOLF:
    case ROLES.WOLF_KING:
      return `现在是夜晚，轮到你选择袭击目标。
可选目标：${targetList}

请先分析每个目标的价值（谁可能是神职？谁对我们威胁最大？），然后选择目标。
返回 JSON：
{"analysis": "你的分析推理过程", "target": "目标的userId"}`;

    case ROLES.SEER:
      return `现在是夜晚，轮到你查验一名玩家的阵营。
可选目标：${targetList}

请先分析谁最值得查验（谁最可疑？谁的身份最有争议？已知信息还有哪些盲点？），然后选择目标。
返回 JSON：
{"analysis": "你的分析推理过程", "target": "目标的userId"}`;

    case ROLES.WITCH: {
      let info = '现在是夜晚，轮到女巫行动。\n';
      if (witchInfo) {
        if (witchInfo.victim && witchInfo.hasAntidote) {
          info += `今夜被刀的是：${witchInfo.victimSeat}号${witchInfo.victimNickname}\n`;
          info += witchInfo.canSelfSave ? '你可以使用解药（包括自救）。\n' : '你可以使用解药救人（不能自救）。\n';
        } else if (!witchInfo.hasAntidote) {
          info += '你的解药已经用过了。\n';
        }
        if (witchInfo.hasPoison) {
          info += `你可以使用毒药毒杀一人。可选毒药目标：${targetList}\n`;
        } else {
          info += '你的毒药已经用过了。\n';
        }
        if (!witchInfo.hasAntidote && !witchInfo.hasPoison) {
          info += '你没有药可以使用，将自动跳过。\n';
          return info + '\n请返回 JSON：\n{"analysis": "无药可用", "potion": "none", "target": null}';
        }
      }
      info += `
请先分析当前局势（该不该用药？用哪瓶？救人还是毒人更有价值？），然后决定行动。
返回 JSON：
- 使用解药：{"analysis": "分析过程", "potion": "antidote", "target": null}
- 使用毒药：{"analysis": "分析过程", "potion": "poison", "target": "目标的userId"}
- 不使用：{"analysis": "分析过程", "potion": "none", "target": null}`;
      return info;
    }

    case ROLES.GUARD:
      return `现在是夜晚，轮到你选择守护目标。你不能连续两夜守护同一个人。
可选目标：${targetList}
你也可以选择不守护任何人。

请先分析谁最可能被刀（谁最有价值？狼人最想杀谁？），然后选择守护目标。
返回 JSON：
- 守护某人：{"analysis": "分析过程", "target": "目标的userId"}
- 不守护：{"analysis": "分析过程", "target": null}`;

    case ROLES.GRAVEDIGGER:
      return `现在是夜晚，轮到你验尸。你可以查看一名已死亡玩家的阵营。
可选目标：${targetList}

请先分析验哪个死者最有价值（确认谁的阵营对推理帮助最大？），然后选择。
返回 JSON：
{"analysis": "分析过程", "target": "目标的userId"}
或不验尸：{"analysis": "分析过程", "target": null}`;

    default:
      return `现在是夜晚，你没有需要操作的行动。请返回：{"action": "skip"}`;
  }
}

export interface MarkingPromptParams {
  evaluationMarkCount: number;
  availableIdentities: string[];
  availableTargets: { userId: string; nickname: string; seatNumber: number }[];
  availableReasons: string[];
}

export function getMarkingPrompt(params: MarkingPromptParams): string {
  const { evaluationMarkCount, availableIdentities, availableTargets, availableReasons } = params;
  const targetList = availableTargets
    .map(t => `${t.seatNumber}号${t.nickname}(userId:"${t.userId}")`)
    .join('、');

  return `现在是标记发言阶段，轮到你发言。

你需要：
1. 声称自己的身份（可以是真实的或伪装的）
2. 评价 ${evaluationMarkCount} 名其他存活玩家

可选身份：${availableIdentities.join('、')}
可选理由：${availableReasons.join('、')}
可评价的玩家：${targetList}
评价身份选项：${[...availableIdentities, '狼人'].join('、')}

请先分析当前局势：
- 你目前掌握了哪些确定的信息？（私有信息如查验结果、用药记录等是最可靠的）
- 有哪些历史记录（标记、投票）可以作为分析依据？
- 信息是否充足？如果信息不足（比如第一轮没有历史数据），应保守评价，多标记"好人"，只在有明确依据时才标记"狼人"
- 不要为了表现积极而随意指控他人为狼人，错误指控会误导好人阵营

然后返回 JSON：
{
  "analysis": "你的分析推理过程",
  "identity": "你声称的身份",
  "reason": "声称理由(英文key)",
  "evaluations": [
    {"target": "userId", "identity": "评价身份", "reason": "理由(英文key)"},
    ...共 ${evaluationMarkCount} 条
  ]
}

理由的英文key对应：直觉判断=intuition, 投票分析=vote_analysis, 标记分析=mark_analysis, 日志推理=log_reasoning, 查验结论=investigation, 用药结果=potion_result
身份使用中文，如：预言家、女巫、守卫、平民、好人、神职、狼人`;
}

// 投票分析偏好：给不同 AI 注入不同的分析角度，减少投票雪崩
const VOTING_PERSONALITIES = [
  // 偏重标记内容分析
  `你的分析偏好：你更擅长从标记发言内容中找矛盾。重点关注：谁的声称前后不一致？谁的评价和事实对不上？有人声称相同的身份吗？`,
  // 偏重投票行为分析
  `你的分析偏好：你更擅长分析投票行为模式。重点关注：谁的投票总是和结果一致（可能是跟风狼）？谁从不投某些人（可能在保队友）？有没有可疑的投票同盟？`,
  // 偏重沉默/低调玩家
  `你的分析偏好：你倾向于关注低调的玩家。重点关注：谁说的话最少、评价最模糊？低调可能是在伪装。不要只看被多人指控的热门目标，也要考虑被忽略的玩家。`,
  // 偏重死亡线索分析
  `你的分析偏好：你更擅长从死亡记录和遗物中推理。重点关注：谁被狼人刀了——说明他可能对狼人有威胁，他之前指控过谁？遗物透露了什么信息？`,
  // 偏重反多数派思考
  `你的分析偏好：你倾向于独立思考，不轻易从众。如果很多人都指向同一个目标，你要想：这是因为证据确凿，还是被带节奏了？也许真正的狼人正在利用多数人的判断来甩锅。`,
];

export function getVotingPrompt(
  candidates: { userId: string; nickname: string; seatNumber: number }[],
  self?: { seatNumber: number; nickname: string },
  personalityIndex?: number,
): string {
  const targetList = candidates
    .map(t => `${t.seatNumber}号${t.nickname}(userId:"${t.userId}")`)
    .join('、');

  const selfReminder = self
    ? `\n注意：你是${self.seatNumber}号${self.nickname}，候选人列表中没有你自己，你只能从以上候选人中选择。`
    : '';

  // 选择个性化分析偏好
  const idx = personalityIndex !== undefined
    ? personalityIndex % VOTING_PERSONALITIES.length
    : Math.floor(Math.random() * VOTING_PERSONALITIES.length);
  const personality = VOTING_PERSONALITIES[idx];

  return `现在是投票阶段，你需要投票放逐一名玩家。
候选人：${targetList}${selfReminder}

${personality}

请先分析：
- 【最高优先级】你的私有信息（查验结果、用药记录等）是最可靠的一手情报，必须首先考虑。如果你查验过某人是好人，绝对不能投他；如果查验过某人是狼人，应优先投他
- 如果有查验结论等确凿证据指向某人，跟随证据投票是正确的
- 如果没有确凿证据，请根据你自己的分析偏好独立判断，不要简单跟从多数人的意见
- 回顾本轮标记发言，结合你的分析偏好找出可疑之处
- 综合以上信息，你认为谁最可能是狼人？

然后返回 JSON：
{"analysis": "你的分析推理过程", "target": "目标的userId"}`;
}

export function getHunterPrompt(canShoot: boolean, targets: { userId: string; nickname: string; seatNumber: number }[]): string {
  if (!canShoot) {
    return '你被毒死了，无法开枪。请返回：{"action": "skip", "target": null}';
  }
  const targetList = targets
    .map(t => `${t.seatNumber}号${t.nickname}(userId:"${t.userId}")`)
    .join('、');

  return `你是猎人，你已出局，可以选择开枪带走一人。
可选目标：${targetList}

请先分析：谁最可能是狼人？你有确定的信息吗？如果不确定，是否值得赌一把还是不开枪更安全？

然后返回 JSON：
- 开枪：{"analysis": "分析过程", "action": "shoot", "target": "目标的userId"}
- 不开枪：{"analysis": "分析过程", "action": "skip", "target": null}`;
}

export function getKnightPrompt(targets: { userId: string; nickname: string; seatNumber: number }[]): string {
  const targetList = targets
    .map(t => `${t.seatNumber}号${t.nickname}(userId:"${t.userId}")`)
    .join('、');

  return `你是骑士，你可以选择与一名玩家决斗。如果对方是狼人，对方出局；如果不是，你自己出局。
可选目标：${targetList}

请先分析：你有多大把握某人是狼人？决斗失败的代价很大（你会出局），是否值得冒险？

然后返回 JSON：
- 决斗：{"analysis": "分析过程", "action": "duel", "target": "目标的userId"}
- 不决斗：{"analysis": "分析过程", "action": "skip", "target": null}`;
}

export function getWolfKingPrompt(targets: { userId: string; nickname: string; seatNumber: number }[]): string {
  const targetList = targets
    .map(t => `${t.seatNumber}号${t.nickname}(userId:"${t.userId}")`)
    .join('、');

  return `你是白狼王，你被放逐出局，可以选择带走一名玩家。
可选目标：${targetList}

请先分析：谁是好人阵营中最有价值的目标？带走谁对狼人阵营最有利？

然后返回 JSON：
- 带人：{"analysis": "分析过程", "action": "drag", "target": "目标的userId"}
- 不带人：{"analysis": "分析过程", "action": "skip", "target": null}`;
}

function getRoleLabel(role: string): string {
  const map: Record<string, string> = {
    werewolf: '狼人', wolfKing: '白狼王', seer: '预言家', witch: '女巫',
    hunter: '猎人', guard: '守卫', gravedigger: '守墓人', fool: '白痴',
    knight: '骑士', villager: '平民',
  };
  return map[role] || role;
}
