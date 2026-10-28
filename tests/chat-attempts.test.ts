import { describe, expect, it } from 'vitest';
import type { Message } from '../src/shared/types';
import { acceptRetryAttempt, mergeChatHistory, visibleChatMessages } from '../src/renderer/chat-attempts';

const time = '2026-10-27T06:30:00.000Z';
const user = (id = 'u1', requestId = 'r1', conversationId = 'c1'): Message => ({id, requestId, conversationId, role: 'user', content: 'same prompt', status: 'complete', createdAt: time});
const assistant = (id: string, requestId: string, status: Message['status'], extra: Partial<Message> = {}): Message => ({id, requestId, conversationId: 'c1', role: 'assistant', content: status === 'failed' ? 'old partial answer' : 'new answer', status, createdAt: time, replyToMessageId: 'u1', ...extra});
const ids = (messages: Message[]) => visibleChatMessages(messages).map(m => m.id);

describe('retry transcript presentation', () => {
  it('replaces completed articles only after a verified newer successful replacement, and folds chains', () => {
    const original=assistant('original','r1','complete');
    const replace=(id:string,request:string,status:Message['status'],target='original')=>assistant(id,request,status,{snapshot:{userMessageId:'u1',replacesMessageId:target}});
    for(const status of ['running','failed','cancelled'] as const)expect(ids([user(),original,replace('next','r2',status)])).toContain('original');
    const tool:Message={...assistant('tool','r1','complete'),role:'tool'};
    const messages=[user(),original,tool,replace('next','r2','complete'),replace('last','r3','complete','next')],before=structuredClone(messages);
    expect(ids(messages)).toEqual(['u1','tool','last']);expect(messages).toEqual(before);
  });
  it('retains completed messages when replacement provenance is untrusted or not strictly later', () => {
    const original=assistant('original','r1','complete');
    const replacement=assistant('new','r2','complete',{snapshot:{userMessageId:'u1',replacesMessageId:'original'}});
    const variants=[{...replacement,requestId:'r1'},{...replacement,replyToMessageId:'u2'},{...replacement,conversationId:'c2'},{...replacement,snapshot:{replacesMessageId:4}}];
    for(const variant of variants)expect(ids([user(),user('u2','other'),original,variant])).toContain('original');
    expect(ids([user(),replacement,original])).toContain('original');
    expect(ids([user(),original,{...original},replacement])).toContain('original');
  });
  it.each(['running', 'complete', 'failed', 'cancelled'] as const)('replaces an old failed article with an accepted %s attempt', status => {
    const messages = [user(), assistant('old', 'r1', 'failed', {error: 'old error'}), assistant('new', 'r2', status)];
    expect(ids(messages)).toEqual(['u1', 'new']);
  });
  it('collapses repeated failed/cancelled attempts without mutating provenance or metrics', () => {
    const old = assistant('old', 'r1', 'failed', {metrics: {startedAt: time, durationMs: 12, rounds: 1, completedRounds: 0, usage: {totalTokens: 5}}});
    const newest = assistant('new', 'r3', 'complete', {metrics: {startedAt: time, durationMs: 30, rounds: 1, completedRounds: 1, usage: {totalTokens: 9}}});
    const messages = [user(), old, assistant('middle', 'r2', 'cancelled'), newest];
    const before = structuredClone(messages);
    expect(visibleChatMessages(messages)).toEqual([messages[0], newest]);
    expect(messages).toEqual(before);
    expect(visibleChatMessages(messages)[1]).toBe(newest);
  });
  it('retains failed/cancelled attempts when no different accepted request follows', () => {
    const messages = [user(), assistant('old', 'r1', 'failed'), assistant('same-request', 'r1', 'running'), user('u2', 'other'), assistant('other', 'other', 'cancelled', {replyToMessageId: 'u2'})];
    expect(ids(messages)).toEqual(messages.map(m => m.id));
  });
  it('supports legacy original request and snapshot user links using saved order, not timestamps', () => {
    const messages = [user(), assistant('old', 'r1', 'failed', {replyToMessageId: undefined, createdAt: '2099-01-01T00:00:00Z'}), assistant('middle', 'r2', 'cancelled', {replyToMessageId: undefined, snapshot: {userMessageId: 'u1'}}), assistant('new', 'r3', 'complete', {createdAt: '2000-01-01T00:00:00Z'})];
    expect(ids(messages)).toEqual(['u1', 'new']);
  });
  it('preserves completed tool evidence, successful assistant records and unrelated turns', () => {
    const tool: Message = {id: 'tool', requestId: 'r1', conversationId: 'c1', role: 'tool', content: 'completed reusable tool result', status: 'complete', createdAt: time};
    const messages = [user(), assistant('old-success', 'r0', 'complete'), assistant('old', 'r1', 'failed', {media: [{id: 'old-image'} as any]}), tool, assistant('new', 'r2', 'complete', {media: [{id: 'current-image'} as any]}), user('u2', 'other'), assistant('other', 'other', 'failed', {replyToMessageId: 'u2'})];
    expect(ids(messages)).toEqual(['u1', 'old-success', 'tool', 'new', 'u2', 'other']);
    expect(visibleChatMessages(messages).find(m => m.id === 'tool')).toBe(tool);
  });
  it('does not treat tool-only output as an accepted retry', () => {
    const messages = [user(), assistant('old', 'r1', 'failed'), {id: 'tool', requestId: 'r2', conversationId: 'c1', role: 'tool', content: 'result', status: 'complete', createdAt: time} as Message];
    expect(ids(messages)).toEqual(messages.map(m => m.id));
  });
  it('does not infer ambiguous, invalid, conflicting or cross-conversation roots', () => {
    const messages = [user(), user('u2', 'r-other'), user('elsewhere', 'r1', 'c2'),
      assistant('invalid', 'r1', 'failed', {replyToMessageId: 'missing'}),
      assistant('conflict', 'r1', 'failed', {snapshot: {userMessageId: 'u2'}}),
      assistant('unlinked', 'unknown', 'failed', {replyToMessageId: undefined}),
      assistant('cross', 'r1', 'failed', {replyToMessageId: 'elsewhere'}),
      assistant('other-conversation', 'r1', 'failed', {conversationId: 'c2', replyToMessageId: 'elsewhere'}),
      assistant('new', 'r2', 'complete')];
    expect(ids(messages)).toEqual(messages.map(m => m.id));
  });
});

describe('accepted retry binding', () => {
  it('creates a fresh bound running article only from an accepted request, with no old metrics', () => {
    const old = assistant('old', 'r1', 'failed', {metrics: {startedAt: time, rounds: 1, completedRounds: 0}});
    const messages = [user(), old];
    expect(ids(messages)).toEqual(['u1', 'old']); // rejection leaves the original state unchanged
    const result = acceptRetryAttempt(messages, 'c1', {requestId: 'r2', userMessageId: 'u1'}, time);
    expect(ids(result)).toEqual(['u1', 'stream-r2']);
    expect(result.at(-1)).toMatchObject({requestId: 'r2', replyToMessageId: 'u1', status: 'running', content: ''});
    expect(result.at(-1)?.metrics).toBeUndefined();
    expect(messages).toEqual([user(), old]);
  });
  it.each(['running', 'complete', 'failed'] as const)('binds an already arrived %s row without duplication or resetting data', status => {
    const live = assistant('stream-r2', 'r2', status, {replyToMessageId: undefined, content: 'arrived before retry response', metrics: {startedAt: time, rounds: 1, completedRounds: 0}});
    const result = acceptRetryAttempt([user(), assistant('old', 'r1', 'failed'), live], 'c1', {requestId: 'r2', userMessageId: 'u1'}, time);
    expect(result).toHaveLength(3);
    expect(ids(result)).toEqual(['u1', 'stream-r2']);
    expect(result[2]).toEqual({...live, replyToMessageId: 'u1'});
  });
  it('does not bind an absent or wrong-conversation user', () => {
    const messages = [user(), assistant('old', 'r1', 'failed')];
    expect(acceptRetryAttempt(messages, 'c2', {requestId: 'r2', userMessageId: 'u1'}, time)).toBe(messages);
    expect(acceptRetryAttempt(messages, 'c1', {requestId: 'r2', userMessageId: 'missing'}, time)).toBe(messages);
  });
});

describe('history arriving after live retry updates', () => {
  it('keeps a finished retry when an older history snapshot arrives late', () => {
    const old = [user(), assistant('old', 'r1', 'failed')];
    const current = [...old, assistant('new', 'r2', 'complete')];
    expect(ids(mergeChatHistory(old, current))).toEqual(['u1', 'new']);
  });
  it('does not regress a completed retry to running or duplicate its stream placeholder', () => {
    const result = [user(), assistant('old', 'r1', 'failed'), assistant('persisted', 'r2', 'running', {content: ''})];
    const current = [user(), assistant('old', 'r1', 'failed'), assistant('stream-r2', 'r2', 'complete')];
    const merged = mergeChatHistory(result, current);
    expect(ids(merged)).toEqual(['u1', 'stream-r2']);
    expect(merged.at(-1)?.status).toBe('complete');
  });
  it('merges richer live text into the persisted running row and preserves its linkage and metrics', () => {
    const stored = assistant('persisted', 'r2', 'running', {content: 'start', metrics: {startedAt: time, rounds: 1, completedRounds: 0}});
    const live = assistant('stream-r2', 'r2', 'running', {replyToMessageId: undefined, content: 'start plus stream'});
    const merged = mergeChatHistory([user(), stored], [user(), live]);
    expect(merged.at(-1)).toEqual({...stored, content: live.content});
  });
});

it('applies a continuation prefix once using provenance, not matching text, across delta and history races',()=>{
 const retry={requestId:'r2',userMessageId:'u1',continuationPrefix:'A'},old=[user(),assistant('old','r1','cancelled')];
 const early=assistant('stream-r2','r2','running',{content:'Again',replyToMessageId:undefined});
 const accepted=acceptRetryAttempt([...old,early],'c1',retry,time);
 expect(accepted.at(-1)?.content).toBe('AAgain');expect(acceptRetryAttempt(accepted,'c1',retry,time).at(-1)?.content).toBe('AAgain');
 const stored=assistant('stored','r2','running',{content:'AAgain',snapshot:{continuationPrefix:'A'}});
 expect(acceptRetryAttempt([...old,stored],'c1',retry,time).at(-1)?.content).toBe('AAgain');
 const initial=acceptRetryAttempt(old,'c1',retry,time);expect(initial.at(-1)?.content).toBe('A');
 expect(mergeChatHistory([...old,stored],accepted).at(-1)?.content).toBe('AAgain');
});
