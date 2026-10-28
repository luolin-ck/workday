import type { Message } from '../shared/types';

type UserIndex = {byId: Map<string, Message | null>; byRequest: Map<string, Message | null>};
const key = (conversationId: string, id: string) => JSON.stringify([conversationId, id]);
function userIndex(messages: Message[]): UserIndex {
  const index: UserIndex = {byId: new Map(), byRequest: new Map()};
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const [map, id] of [[index.byId, message.id], [index.byRequest, message.requestId]] as const) {
      const idKey = key(message.conversationId, id);
      map.set(idKey, map.has(idKey) ? null : message);
    }
  }
  return index;
}
function linkedUser(message: Message, index: UserIndex): Message | undefined {
  const snapshot = message.snapshot && typeof message.snapshot === 'object' && !Array.isArray(message.snapshot)
    ? message.snapshot as {userMessageId?: unknown} : undefined;
  const declared = [message.replyToMessageId, snapshot?.userMessageId].filter(id => id !== undefined);
  const original = index.byRequest.get(key(message.conversationId, message.requestId));
  if (declared.length) {
    if (declared.some(id => typeof id !== 'string' || id !== declared[0])) return;
    const user = index.byId.get(key(message.conversationId, declared[0] as string));
    if (!user || original === null || (original && original.id !== user.id)) return;
    return user;
  }
  return original ?? undefined;
}

export function chatUserResolver(messages: Message[]): (message: Message) => Message | undefined {
  const index = userIndex(messages);
  return message => linkedUser(message, index);
}

// Keep stored attempts intact. Completed articles require an explicit successful replacement.
export function visibleChatMessages(messages: Message[]): Message[] {
  const users = userIndex(messages), newest = new Map<string, string>(), hidden = new Set<Message>();
  const byId = new Map<string, {message: Message; position: number} | null>();
  messages.forEach((message, position) => {
    const id = key(message.conversationId, message.id);
    byId.set(id, byId.has(id) ? null : {message, position});
  });
  messages.forEach((message, position) => {
    if (message.role !== 'assistant' || message.status !== 'complete') return;
    if (!byId.get(key(message.conversationId, message.id))) return;
    const replacement = (message.snapshot as {replacesMessageId?: unknown} | undefined)?.replacesMessageId;
    if (typeof replacement !== 'string') return;
    const target = byId.get(key(message.conversationId, replacement));
    if (!target || target.position >= position || target.message.role !== 'assistant' || target.message.status !== 'complete' || target.message.requestId === message.requestId) return;
    const user = linkedUser(message, users), previousUser = linkedUser(target.message, users);
    if (user && previousUser && user.id === previousUser.id) hidden.add(target.message);
  });
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const user = linkedUser(message, users);
    if (!user) continue;
    const turn = key(user.conversationId, user.id), latestRequest = newest.get(turn);
    if (latestRequest && latestRequest !== message.requestId && ['failed', 'cancelled'].includes(message.status)) hidden.add(message);
    if (!latestRequest) newest.set(turn, message.requestId);
  }
  return messages.filter(message => !hidden.has(message));
}

export function acceptRetryAttempt(messages: Message[], conversationId: string, retry: {requestId: string; userMessageId: string; continuationPrefix?:string}, createdAt: string): Message[] {
  const user = userIndex(messages).byId.get(key(conversationId, retry.userMessageId));
  if (!user) return messages;
  const matches = (message: Message) => message.conversationId === conversationId && message.requestId === retry.requestId && message.role === 'assistant';
  const prefixSnapshot=retry.continuationPrefix!==undefined?{continuationPrefix:retry.continuationPrefix}:{};
  if (messages.some(matches)) return messages.map(message => {
    if(!matches(message))return message;
    const prefixed=(message.snapshot as {continuationPrefix?:string}|undefined)?.continuationPrefix===retry.continuationPrefix;
    return {...message,replyToMessageId:message.replyToMessageId??user.id,
      content:retry.continuationPrefix!==undefined&&message.status==='running'&&!prefixed?retry.continuationPrefix+message.content:message.content,
      ...(retry.continuationPrefix!==undefined?{snapshot:{...(message.snapshot as object|undefined),...prefixSnapshot}}:{})};
  });
  return [...messages, {id: `stream-${retry.requestId}`, conversationId, requestId: retry.requestId, replyToMessageId: user.id, role: 'assistant', status: 'running', content: retry.continuationPrefix??'', ...(retry.continuationPrefix!==undefined?{snapshot:prefixSnapshot}:{}), createdAt}];
}

// A history request begun before a stream/acceptance update must not erase that update.
export function mergeChatHistory(result: Message[], current: Message[]): Message[] {
  const same = (left: Message, right: Message) => left.conversationId === right.conversationId &&
    (left.id === right.id || (left.role === 'assistant' && right.role === 'assistant' && left.requestId === right.requestId));
  const merged = result.map(message => {
    if (message.role !== 'assistant' || message.status !== 'running') return message;
    const live = current.find(item => same(item, message));
    if (live && live.status !== 'running') return live;
    return live ? {...message, content: live.content.length > message.content.length ? live.content : message.content, toolCalls: live.toolCalls ?? message.toolCalls} : message;
  });
  for (const live of current) {
    if (!merged.some(item => same(item, live))) merged.push(live);
  }
  return merged;
}
