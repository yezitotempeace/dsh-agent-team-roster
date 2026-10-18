/**
 * Wiring tests: `apply(ctx)` through fake tools/systemPrompt services, with the
 * real projection registry, the real Agent Teams service, and the real
 * `defineTool` from @deepseek-ai/dsh-tools.
 */
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { TeamService } from './core-pristine.js';
import { apply, cleanupTeam } from '../lib/index.js';

const LEAD_ID = 'session-lead';
const PEER_ID = 'session-peer';
const STRANGER_ID = 'session-stranger';
const passes = [];
const failures = [];
async function check(name, fn) {
	try {
		await fn();
		passes.push(name);
	} catch (error) {
		failures.push({ name, error: `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}` });
	}
}

function createRuntime({ refuseToolRegistration = false } = {}) {
	const ctx = new Context();
	new SessionProjectionRegistry(ctx);
	const agents = new Map();
	const disposed = [];
	const tools = {
		registered: [],
		register(definition) {
			if (refuseToolRegistration && definition.name === 'delete_teammate') throw new Error('tool registration refused');
			this.registered.push(definition);
			return () => { disposed.push(`tool:${definition.name}`); };
		},
	};
	const sections = [];
	const systemPrompt = {
		section(declaration) {
			sections.push(declaration);
			return () => { disposed.push(`section:${declaration.name}`); };
		},
		getSectionOrder(name) { return name === 'TEAM_POLICY' ? 40 : undefined; },
	};
	ctx.provide('agents', { list: () => [...agents.values()], get: (id) => agents.get(id) });
	ctx.provide('sessions', { flush: async () => {}, get: () => undefined });
	ctx.provide('sessionPersistence', { open: async () => { throw new Error('no persisted session'); } });
	ctx.provide('subagents', { interrupt() {}, drainContinuableChildren: async () => {} });
	ctx.provide('tools', tools);
	ctx.provide('systemPrompt', systemPrompt);
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
	// A live Agent always carries its scoped context; the plugin registers into it.
	const leadAgent = { id: LEAD_ID, status: 'idle', options: {}, ctx, session: session(LEAD_ID, undefined) };
	agents.set(LEAD_ID, leadAgent);
	const service = new TeamService(ctx, {});
	const addAgent = (id, parentId = LEAD_ID) => {
		const agent = { id, status: 'inactive', options: {}, ctx, session: session(id, parentId) };
		agents.set(id, agent);
		return agent;
	};
	const fold = (type, data) => leadAgent.session.append(type, data);
	const member = (id, name, phase) => ({ id, name, description: `${name} duty`, provider: 'spawn', context: 'fresh', phase });
	const addActiveMember = (id, name) => {
		fold('team/member', { version: 2, teamId: LEAD_ID, member: member(id, name, 'provisioning') });
		fold('team/member', { version: 2, teamId: LEAD_ID, member: member(id, name, 'active') });
	};
	return { ctx, agents, tools, sections, disposed, service, leadAgent, addAgent, addActiveMember, fold };
}

await check('apply: wraps the fold and both wire views, adds one grounding section, and registers each tool once', async () => {
	const runtime = createRuntime();
	apply(runtime.ctx);
	const registration = runtime.ctx.sessionProjections.registrations.get('agentTeam');
	assert.equal(registration.def.apply.name, 'wrapped');
	assert.equal(registration.def.wire.view.name, 'wrapped');
	assert.deepEqual(runtime.sections.map((section) => [section.name, section.order]), [['team:grounding', 40]]);
	assert.deepEqual(runtime.tools.registered.map((tool) => tool.name), ['rename_teammate', 'delete_teammate', 'cleanup_team']);
});

await check('apply: the registered tool deletes a teammate through the real service', async () => {
	const runtime = createRuntime();
	const teammate = runtime.addAgent(PEER_ID, LEAD_ID);
	runtime.addActiveMember(PEER_ID, 'probe');
	apply(runtime.ctx);
	const tool = runtime.tools.registered.find((candidate) => candidate.name === 'delete_teammate');
	const value = await tool.execute({ target: 'probe' }, { agent: runtime.leadAgent });
	assert.deepEqual(value, { name: 'probe', previousStatus: 'inactive', releasedTasks: [], discardedMessages: [] });
	assert.deepEqual(runtime.service.listMembers(runtime.leadAgent).map((row) => row.name), ['lead']);
	assert.ok(teammate.id === PEER_ID);
});

await check('apply: the tool results render as compact JSON', async () => {
	const runtime = createRuntime();
	apply(runtime.ctx);
	const byName = (name) => runtime.tools.registered.find((candidate) => candidate.name === name);
	assert.deepEqual(byName('delete_teammate').output.render({}, { name: 'probe', previousStatus: 'running', releasedTasks: ['task-1'], discardedMessages: [] }), [{ type: 'text', text: '{"name":"probe","previousStatus":"running","releasedTasks":["task-1"],"discardedMessages":[]}' }]);
	assert.deepEqual(byName('rename_teammate').output.render({}, { previousName: 'probe', name: 'scout', status: 'running' }), [{ type: 'text', text: '{"previousName":"probe","name":"scout","status":"running"}' }]);
	assert.deepEqual(byName('cleanup_team').output.render({}, { scope: 'all', teammates: ['probe'], tasks: ['task-1'], releasedTasks: [], skipped: [] }), [{ type: 'text', text: '{"scope":"all","teammates":["probe"],"tasks":["task-1"],"releasedTasks":[],"skipped":[]}' }]);
});

await check('apply: the registered rename tool renames a teammate through the real service', async () => {
	const runtime = createRuntime();
	runtime.addAgent(PEER_ID, LEAD_ID);
	runtime.addActiveMember(PEER_ID, 'probe');
	apply(runtime.ctx);
	const tool = runtime.tools.registered.find((candidate) => candidate.name === 'rename_teammate');
	const value = await tool.execute({ target: 'probe', new_name: 'scout' }, { agent: runtime.leadAgent });
	assert.deepEqual(value, { previousName: 'probe', name: 'scout', status: 'inactive' });
	assert.deepEqual(runtime.service.listMembers(runtime.leadAgent).map((row) => row.name), ['lead', 'scout']);
});

await check('apply: a stale Agent identity is not scoped in', async () => {
	const runtime = createRuntime();
	apply(runtime.ctx);
	assert.equal(runtime.tools.registered.length, 3, 'the Lead leads its own Team, so it is scoped in at activation');
	runtime.ctx.emit('agent/created', { agent: { id: STRANGER_ID, status: 'idle', ctx: runtime.ctx } });
	assert.equal(runtime.tools.registered.length, 3, 'a stale identity must not be scoped in');
	assert.equal(runtime.sections.length, 1);
});

await check('apply: an Agent created after activation is scoped in on agent/created', async () => {
	const runtime = createRuntime();
	apply(runtime.ctx);
	assert.equal(runtime.tools.registered.length, 3, 'the Lead is scoped in at activation');
	const teammate = runtime.addAgent(PEER_ID, LEAD_ID);
	runtime.addActiveMember(PEER_ID, 'probe');
	runtime.ctx.emit('agent/created', { agent: teammate });
	assert.deepEqual(runtime.tools.registered.map((tool) => tool.name), ['rename_teammate', 'delete_teammate', 'cleanup_team', 'rename_teammate', 'delete_teammate', 'cleanup_team']);
	runtime.ctx.emit('agent/created', { agent: teammate });
	assert.equal(runtime.tools.registered.length, 6, 'activation must be idempotent per Agent');
});

await check('apply: a teammate scope is installed too, and Lead-only is enforced by the service call', async () => {
	const runtime = createRuntime();
	const teammate = runtime.addAgent(PEER_ID, LEAD_ID);
	runtime.addActiveMember(PEER_ID, 'probe');
	apply(runtime.ctx);
	runtime.ctx.emit('agent/created', { agent: teammate });
	for (const [name, args] of [['delete_teammate', { target: 'other' }], ['rename_teammate', { target: 'other', new_name: 'scout' }], ['cleanup_team', { scope: 'all' }]]) {
		const tool = runtime.tools.registered.find((candidate) => candidate.name === name);
		let caught;
		try {
			await tool.execute(args, { agent: teammate });
		} catch (error) {
			caught = error;
		}
		assert.equal(caught?.code, 'TEAM_LEAD_REQUIRED', `${name} must be Lead-only`);
	}
});

await check('apply: a mid-install failure undoes what it registered and restores the fold', async () => {
	const runtime = createRuntime({ refuseToolRegistration: true });
	let caught;
	try {
		apply(runtime.ctx);
	} catch (error) {
		caught = error;
	}
	assert.equal(caught?.message, 'tool registration refused');
	assert.deepEqual(runtime.disposed, ['tool:rename_teammate', 'section:team:grounding']);
	assert.notEqual(runtime.ctx.sessionProjections.registrations.get('agentTeam').def.apply.name, 'wrapped', 'the packaged fold is restored');
	assert.notEqual(runtime.ctx.sessionProjections.registrations.get('agentTeam').def.wire.view.name, 'wrapped', 'the packaged wire view is restored');
});

await check('apply: the live Team view renders the roster and the task board newest first', async () => {
	const runtime = createRuntime();
	const first = runtime.addAgent(PEER_ID, LEAD_ID);
	runtime.addActiveMember(PEER_ID, 'probe');
	const second = runtime.addAgent('session-second', LEAD_ID);
	runtime.addActiveMember('session-second', 'scout');
	apply(runtime.ctx);
	const wire = runtime.ctx.sessionProjections.registrations.get('agentTeam').def.wire;
	const view = wire.view(runtime.service.journal.state(runtime.service.membership(runtime.leadAgent).root));
	assert.deepEqual(view.members.map((member) => member.name), ['lead', 'scout', 'probe']);
	assert.deepEqual(wire.viewSchema.parse(view).members.map((member) => member.name), ['lead', 'scout', 'probe'], 'the ordered view still passes the packaged wire schema');
	assert.ok(first.id === PEER_ID && second.id === 'session-second');
});

await check('apply: the live task board renders the newest task first', async () => {
	const runtime = createRuntime();
	apply(runtime.ctx);
	const older = await runtime.service.createTask(runtime.leadAgent, { subject: 'older', description: 'older work' });
	const newer = await runtime.service.createTask(runtime.leadAgent, { subject: 'newer', description: 'newer work' });
	const wire = runtime.ctx.sessionProjections.registrations.get('agentTeam').def.wire;
	const view = wire.view(runtime.service.journal.state(runtime.service.membership(runtime.leadAgent).root));
	assert.deepEqual(view.tasks.map((task) => task.id), [newer.id, older.id]);
});

await check('apply: a registered subagent catalog view renders newest first', async () => {
	const runtime = createRuntime();
	const state = { entries: [{ id: 'child-old', createdAt: 1 }, { id: 'child-new', createdAt: 2 }] };
	runtime.ctx.sessionProjections.register({
		key: 'subagentCatalog',
		stateVersion: 3,
		stateSchema: { parse: (value) => value },
		init: () => ({ entries: [] }),
		apply: (current) => current,
		wire: {
			viewSchema: { parse: (value) => value },
			view: (current) => current.entries,
		},
	});
	apply(runtime.ctx);
	const wire = runtime.ctx.sessionProjections.registrations.get('subagentCatalog').def.wire;
	assert.deepEqual(wire.view(state).map((entry) => entry.id), ['child-new', 'child-old']);
});

await check('apply: cleanup_team deletes settled teammates and completed tasks, and reports what it left alone', async () => {
	const runtime = createRuntime();
	runtime.addAgent(PEER_ID, LEAD_ID);
	runtime.addActiveMember(PEER_ID, 'probe');
	const busy = runtime.addAgent('session-busy', LEAD_ID);
	runtime.addActiveMember('session-busy', 'runner');
	busy.status = 'running';
	const done = await runtime.service.createTask(runtime.leadAgent, { subject: 'done', description: 'finished work' });
	await runtime.service.updateTask(runtime.leadAgent, { taskId: done.id, expectedRevision: done.revision, action: 'reassign', owner: 'probe' });
	const claimed = runtime.service.listTasks(runtime.leadAgent).find((task) => task.id === done.id);
	await runtime.service.updateTask(runtime.leadAgent, { taskId: done.id, expectedRevision: claimed.revision, action: 'complete' });
	const open = await runtime.service.createTask(runtime.leadAgent, { subject: 'open', description: 'unfinished work' });
	apply(runtime.ctx);
	const tool = runtime.tools.registered.find((candidate) => candidate.name === 'cleanup_team');
	const value = await tool.execute({ scope: 'all' }, { agent: runtime.leadAgent });
	assert.deepEqual(value, {
		scope: 'all',
		teammates: ['probe'],
		tasks: [done.id],
		releasedTasks: [],
		skipped: [{ kind: 'teammate', target: 'runner', reason: 'running' }],
	});
	assert.deepEqual(runtime.service.listMembers(runtime.leadAgent).map((row) => row.name), ['lead', 'runner']);
	assert.deepEqual(runtime.service.listTasks(runtime.leadAgent).map((task) => task.id), [open.id]);
});

await check('apply: cleanup_team releases an unfinished task owned by a deleted teammate', async () => {
	const runtime = createRuntime();
	runtime.addAgent(PEER_ID, LEAD_ID);
	runtime.addActiveMember(PEER_ID, 'probe');
	const held = await runtime.service.createTask(runtime.leadAgent, { subject: 'held', description: 'running work' });
	await runtime.service.updateTask(runtime.leadAgent, { taskId: held.id, expectedRevision: held.revision, action: 'reassign', owner: 'probe' });
	apply(runtime.ctx);
	const tool = runtime.tools.registered.find((candidate) => candidate.name === 'cleanup_team');
	const value = await tool.execute({ scope: 'teammates' }, { agent: runtime.leadAgent });
	assert.deepEqual(value, { scope: 'teammates', teammates: ['probe'], tasks: [], releasedTasks: [held.id], skipped: [] });
	assert.deepEqual(runtime.service.listTasks(runtime.leadAgent).map((task) => task.status), ['pending']);
});

await check('apply: an unknown cleanup scope is rejected by the tool parameters and by the service call', async () => {
	const runtime = createRuntime();
	runtime.addAgent(PEER_ID, LEAD_ID);
	runtime.addActiveMember(PEER_ID, 'probe');
	apply(runtime.ctx);
	const tool = runtime.tools.registered.find((candidate) => candidate.name === 'cleanup_team');
	let caught;
	try {
		await tool.execute({ scope: 'everything' }, { agent: runtime.leadAgent });
	} catch (error) {
		caught = error;
	}
	assert.equal(caught?.code, 'INVALID_ARGS', 'the declared parameter enum rejects it first');
	// The service entry point keeps its own guard for callers that bypass the tool schema.
	await assert.rejects(() => cleanupTeam(runtime.ctx, runtime.leadAgent, 'everything'), /cleanup scope must be one of/);
	assert.deepEqual(runtime.service.listMembers(runtime.leadAgent).map((row) => row.name), ['lead', 'probe']);
});

console.log(`${passes.length} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure.name}: ${failure.error}`);
process.exitCode = failures.length === 0 ? 0 : 1;
