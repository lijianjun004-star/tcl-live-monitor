// Physical room <-> platform account registry. One physical room may simulcast on several
// platform accounts; its live time is counted ONCE (union), never per account.
export const PLATFORMS = Object.freeze(['jd', 'tmall', 'douyin']);

export function buildRegistry({ rooms, accounts }) {
  const roomIds = new Set();
  for (const r of rooms) {
    if (!r.id || roomIds.has(r.id)) throw new Error(`实体直播间 ID 重复或为空: ${r.id}`);
    roomIds.add(r.id);
  }
  const owner = new Map();
  for (const a of accounts) {
    if (!PLATFORMS.includes(a.platform)) throw new Error(`不支持的平台: ${a.platform}`);
    if (!roomIds.has(a.roomId)) throw new Error(`账号 ${a.id} 绑定了不存在的实体直播间 ${a.roomId}`);
    if (owner.has(a.id)) throw new Error(`账号 ${a.id} 同时绑定多个实体直播间`);
    owner.set(a.id, a.roomId);
  }
  const accountsOf = roomId => accounts.filter(a => a.roomId === roomId && a.enabled !== false && a.userConfirmed === true);
  return {
    accountsOf,
    roomOf: accountId => owner.get(accountId) ?? null,
    /** Only accounts the user explicitly confirmed may contribute to formal scores. */
    monitoredAccountIds: roomId => accountsOf(roomId).map(a => a.id),
    /** A slot's source is validated only if every contributing platform passed L2 acceptance. */
    sourceValidated: (roomId, validatedPlatforms) => {
      const list = accountsOf(roomId);
      return list.length > 0 && list.every(a => validatedPlatforms.includes(a.platform));
    },
  };
}
