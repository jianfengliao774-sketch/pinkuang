export const COMMUNITY_DESTINATION = Object.freeze({
  chatId: '-1004492628953', threadId: 2, username: 'BEMineCommunity',
});

/** Explicit operator allowlist; never infer or fall back to a group's general topic. */
export function assertCommunityDestination(value) {
  if (!value || value.chatId !== COMMUNITY_DESTINATION.chatId
    || value.threadId !== COMMUNITY_DESTINATION.threadId || value.username !== COMMUNITY_DESTINATION.username)
    throw new Error('Community destination is not the approved group topic.');
  return value;
}

export function communityConfiguration(env, publicBaseUrl) {
  if (env.BEMINE_COMMUNITY_ENABLED !== '1') return null;
  const value = assertCommunityDestination({
    chatId: env.BEMINE_COMMUNITY_CHAT_ID,
    threadId: Number(env.BEMINE_COMMUNITY_THREAD_ID),
    username: env.BEMINE_COMMUNITY_USERNAME,
  });
  return { ...value, photoUrl: new URL('images/bemine-share-v11-tech.jpg', publicBaseUrl).href };
}

export async function verifyCommunityDestination(client, community, botId) {
  assertCommunityDestination(community);
  if (!Number.isSafeInteger(botId) || botId <= 0) throw new Error('Invalid bot identity.');
  const chat = await client.request('getChat', { chat_id: community.chatId });
  if (String(chat?.id) !== community.chatId || chat.username !== community.username
    || chat.type !== 'supergroup' || chat.is_forum !== true)
    throw new Error('Community identity or forum mode does not match.');
  const member = await client.request('getChatMember', { chat_id: community.chatId, user_id: botId });
  if (member?.user?.id !== botId || !['member', 'administrator', 'creator'].includes(member.status)
    || member.status === 'member' && (chat.permissions?.can_send_messages !== true || chat.permissions?.can_send_photos !== true))
    throw new Error('Community bot membership or posting permission unavailable.');
  return true;
}
