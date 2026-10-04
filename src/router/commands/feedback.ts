import type { CommandContext, CommandResult } from '../index.ts';
import { requireCharacter } from './common.ts';

export const FEEDBACK_USAGE = '用法：.反馈 你遇到的问题或建议（例：.反馈 消化度涨得太慢）';
export const FEEDBACK_MAX_LENGTH = 500;
export const FEEDBACK_MIN_LENGTH = 4;

/** .反馈：写入 feedback 表，封测复盘时统一分类处理 */
export async function handleFeedback(ctx: CommandContext): Promise<CommandResult> {
  const { deps, msg, now } = ctx;
  const content = ctx.args.join(' ').trim();

  if (!content) return { privateText: FEEDBACK_USAGE, detailToPrivate: true };
  if (content.length < FEEDBACK_MIN_LENGTH) {
    return { privateText: '写得太短了，多写几个字吧（至少 4 个字）。', detailToPrivate: true };
  }
  if (content.length > FEEDBACK_MAX_LENGTH) {
    return {
      privateText: `反馈太长了（最多 ${FEEDBACK_MAX_LENGTH} 字），精简一下再发。`,
      detailToPrivate: true,
    };
  }

  const character = deps.characters.findByUserId(msg.userId);
  const id = deps.feedback.add({
    userId: msg.userId,
    characterId: character?.id ?? null,
    content,
    createdAt: now,
  });

  return {
    privateText: [
      `反馈已记录（编号 #${id}）。`,
      '封测期间我们每天汇总一次，严重问题会进当天日报。',
      '急事可以直接私聊客服 QQ（见 .帮助 公告）。',
    ].join('\n'),
    groupText: `【${character?.name ?? (msg.nickname || msg.userId)}】提交了一条反馈（#${id}）。`,
    detailToPrivate: true,
  };
}
