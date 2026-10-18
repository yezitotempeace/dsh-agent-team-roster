/**
 * Mount the plugin against the real services: the packaged SessionProjectionRegistry
 * and Agent Teams service plus the real Tools and SystemPrompt services, so a name
 * collision or API mismatch fails here instead of inside the user's live process.
 */
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { TeamService } from './core-pristine.js';
import { apply } from '../lib/index.js';

const LEAD_ID = 'session-lead';
const PEER_ID = 'session-peer';
const PEER2_ID = 'session-peer-2';
const ctx = new Context();
new SessionProjectionRegistry(ctx);
const agents = new Map();
ctx.provide('agents', { list: () => [...agents.values()], get: (id) => agents.get(id) });
ctx.provide('sessions', { flush: async () => {}, get: () => undefined });
ctx.provide('sessionPersistence', { open: async () => { throw new Error('no persisted session'); } });
ctx.provide('subagents', { interrupt() {}, drainContinuableChildren: async () => {} });
new SystemPrompt(ctx, {});
new Tools(ctx, {});
const service = new TeamService(ctx, {});

const session = (id, parentSession) => {
	const events = [];
	const handle = {
		id,
		header: { id, parentSession },
		inheritedEventCount: 0,
		get seq() { return events.length; },
		events,
		append(type, data) {
			const event = { type, data, seq: events.length };
			events.push(event);
			ctx.emit('session/event', handle, event);
			return event;
		},
		eventAt: (seq) => events[seq],
		snapshotEvents: (from = 0, to = events.length) => events.slice(from, to),
		steer() {},
	};
	ctx.emit('session/created', handle);
	return handle;
};
// One Agent per scope, as the live harness does: a second member Agent here would
// share this context and collide on the per-Agent section name.
const lead = { id: LEAD_ID, status: 'idle', options: {}, ctx, session: session(LEAD_ID, undefined) };
agents.set(LEAD_ID, lead);
const fold = (type, data) => lead.session.append(type, data);
const row = (id, name, phase) => ({ id, name, description: `${name} duty`, provider: 'spawn', context: 'fresh', phase });
const addMember = (id, name) => {
	fold('team/member', { version: 2, teamId: LEAD_ID, member: row(id, name, 'provisioning') });
	fold('team/member', { version: 2, teamId: LEAD_ID, member: row(id, name, 'active') });
};
addMember(PEER_ID, 'probe');
addMember(PEER2_ID, 'runner');

apply(ctx);
assert.equal(ctx.sessionProjections.registrations.get('agentTeam').def.apply.name, 'wrapped');
assert.ok(ctx.tools.get('rename_teammate'), 'rename_teammate must be registered in this scope');
assert.ok(ctx.tools.get('delete_teammate'), 'delete_teammate must be registered in this scope');
assert.ok(ctx.tools.get('cleanup_team'), 'cleanup_team must be registered in this scope');
// Only this plugin registers that section name in this process, so a duplicate proves it landed.
assert.throws(() => ctx.systemPrompt.section({ name: 'team:grounding', order: 40, text: 'probe' }), /already registered/);
// The client-facing view is the only thing the ordering changes; the fold state
// and the service contracts below keep the packaged order.
const registration = ctx.sessionProjections.registrations.get('agentTeam');
const viewOf = () => registration.def.wire.view(service.journal.state(service.membership(lead).root));
assert.deepEqual(viewOf().members.map((member) => member.name), ['lead', 'runner', 'probe']);
assert.deepEqual(registration.def.wire.viewSchema.parse(viewOf()).members.map((member) => member.name), ['lead', 'runner', 'probe']);
const older = await service.createTask(lead, { subject: 'older', description: 'older work' });
const newer = await service.createTask(lead, { subject: 'newer', description: 'newer work' });
assert.deepEqual(viewOf().tasks.map((task) => task.id), [newer.id, older.id]);
assert.deepEqual(service.listTasks(lead).map((task) => task.id), [older.id, newer.id], 'the service contract keeps numeric creation order');

// The packaged unit promises that a state change it ignores republishes nothing,
// because it reuses the previous view reference. Ordering must not break that.
const beforeMail = viewOf();
await service.sendMessage(lead, { target: 'runner', content: [{ type: 'text', text: 'ping' }], signal: new AbortController().signal });
assert.equal(viewOf(), beforeMail, 'a mailbox-only change keeps the packaged view reference');
assert.deepEqual(viewOf().members.map((member) => member.name), ['lead', 'runner', 'probe'], 'and the ordered value still reads newest first');
const rename = ctx.tools.get('rename_teammate');
const renamed = await rename.execute({ target: 'probe', new_name: 'scout' }, { agent: lead });
assert.deepEqual(renamed, { previousName: 'probe', name: 'scout', status: 'inactive' });
const deleted = await ctx.tools.get('delete_teammate').execute({ target: 'scout' }, { agent: lead });
assert.deepEqual(deleted, { name: 'scout', previousStatus: 'inactive', releasedTasks: [], discardedMessages: [] });
assert.deepEqual(service.listMembers(lead).map((member) => member.name), ['lead', 'runner']);
const cleaned = await ctx.tools.get('cleanup_team').execute({ scope: 'all' }, { agent: lead });
assert.deepEqual(cleaned, { scope: 'all', teammates: ['runner'], tasks: [], releasedTasks: [], skipped: [] });
assert.deepEqual(service.listMembers(lead).map((member) => member.name), ['lead']);
assert.deepEqual(service.listTasks(lead).map((task) => task.id), [older.id, newer.id], 'unfinished tasks survive the cleanup');


// A second activation in the same context fails loudly at the tool layer, and
// must leave the first activation's fold, wire views, and tools working.
assert.throws(() => apply(ctx), /already registered/);
assert.equal(ctx.sessionProjections.registrations.get('agentTeam').def.apply.name, 'wrapped');
assert.equal(ctx.sessionProjections.registrations.get('agentTeam').def.wire.view.name, 'wrapped');
assert.ok(ctx.tools.get('cleanup_team'));
assert.deepEqual(service.listMembers(lead).map((member) => member.name), ['lead']);
console.log('mount: ok');
