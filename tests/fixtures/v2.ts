import type { Observation, SessionMeta } from '../../src/shared/protocol.js';

export const meta: SessionMeta = {
  id: 'ses_1',
  title: 'Synthetic garden',
  agent: 'build',
  projectID: 'prj_1',
  projectName: 'garden',
  directory: '/synthetic/garden',
};

function event(type: string, data: Record<string, unknown>, created = 1000, id = `evt_${type}_${created}`) {
  return { id, type, created, metadata: {}, data };
}

export const events = {
  created: (id = 'ses_1', title = 'Synthetic garden', agent = 'build', parentID?: string) =>
    event('session.created', { sessionID: id, projectID: 'prj_1', location: { directory: '/synthetic/garden' }, slug: 'x', version: '1', title, agent, ...(parentID ? { parentID } : {}) }),
  renamed: (title: string) => event('session.renamed', { sessionID: 'ses_1', title }, 1001),
  agentSelected: (agent: string) => event('session.agent.selected', { sessionID: 'ses_1', agent }, 1002),
  started: () => event('session.execution.started', { sessionID: 'ses_1' }, 1003),
  succeeded: () => event('session.execution.succeeded', { sessionID: 'ses_1' }, 1004),
  failed: () => event('session.execution.failed', { sessionID: 'ses_1', error: { message: 'private detail' } }, 1005),
  interrupted: () => event('session.execution.interrupted', { sessionID: 'ses_1', reason: 'user' }, 1006),
  toolCalled: (callID = 'call_a', tool = 'read') =>
    event('session.tool.called', { sessionID: 'ses_1', assistantMessageID: 'msg_1', id: callID, input: { secret: 'raw argument' }, executed: true, native: { name: tool } }, 1007, `evt_call_${callID}`),
  toolSuccess: (callID = 'call_a') =>
    event('session.tool.success', { sessionID: 'ses_1', assistantMessageID: 'msg_1', id: callID, content: [{ type: 'text', text: 'raw output' }], executed: true }, 1008, `evt_done_${callID}`),
  toolFailed: (callID = 'call_a') =>
    event('session.tool.failed', { sessionID: 'ses_1', assistantMessageID: 'msg_1', id: callID, error: { message: 'raw error' }, executed: true }, 1009, `evt_fail_${callID}`),
  permissionAsked: (id = 'perm_1') => event('permission.asked', { id, sessionID: 'ses_1', action: 'edit', resources: ['/synthetic/file.ts'] }, 1010, `evt_perm_${id}`),
  permissionReplied: (requestID = 'perm_1') => event('permission.replied', { sessionID: 'ses_1', requestID, reply: 'once' }, 1011, `evt_perm_reply_${requestID}`),
  formCreated: (id = 'form_1') => event('form.created', { form: { id, sessionID: 'ses_1', title: 'Choose a file', fields: [] } }, 1012, `evt_form_${id}`),
  formReplied: (id = 'form_1') => event('form.replied', { id, sessionID: 'ses_1', answer: { answers: [] } }, 1013, `evt_form_reply_${id}`),
  deleted: () => event('session.deleted', { sessionID: 'ses_1' }, 1014),
  statusIdle: () => event('session.status', { sessionID: 'ses_1', status: { type: 'idle' } }, 1015),
  unknown: () => event('filesystem.changed', {}, 1016),
};

export function observation(partial: Partial<Observation> & Pick<Observation, 'kind' | 'sessionID'>): Observation {
  return { sourceID: 'source', sequence: 1, at: 1000, ...partial };
}
