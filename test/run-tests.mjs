/**
 * Tests for the Agent Teams roster plugin.
 *
 * The Team domain under test is the pristine installed module
 * (`core-pristine.js`, hash-checked against the stock file), the projection
 * registry is the real `@deepseek-ai/dsh-session-projection` service, and the
 * plugin code is the shipped `lib/index.js`. Only the surrounding runtime
 * services are fakes: agents, sessions, sessionPersistence, subagents, logger.
 *
 * Every durable write goes through the real projection drive, so the
 * assertions below read state folded by the extended `agentTeam` unit.
 */
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { TeamService } from './core-pristine.js';
import { applyRosterFold, installDisplayOrder, installRosterFold, orderCatalogView, orderTeamView, removeTeammate, renameTeammate } from '../lib/index.js';

const LEAD_ID = 'session-lead';
const TEAMMATE_ID = 'session-teammate-1';
const PEER_ID = 'session-teammate-2';

const passes = [];
const failures = [];
function check(name, fn) {
	try {
		fn();
		passes.push(name);
	} catch (error) {
		failures.push({ name, error: `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}` });
	}
}
async function checkAsync(name, fn) {
	try {
		await fn();
		passes.push(name);
	} catch (error) {
		failures.push({ name, error: `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}` });
	}
}
/** Assert one thrown error by its Team error code, independent of class identity. */
async function rejectsCode(name, thunk, code) {
	await checkAsync(name, async () => {
		let caught;
		try {
			await thunk();
		} catch (error) {
			caught = error;
		}
		assert.ok(caught !== undefined, 'expected the call to reject');
		assert.equal(caught.code, code, `expected code ${code}, got ${caught.code}: ${caught.message}`);
	});
}

/** Team state fields owned by the packaged fold; the plugin must not add any. */
const STATE_FIELDS = ['delivered', 'id', 'members', 'messages', 'nextTaskNumber', 'tasks'];

/** Clone a session handle so a fresh projection cell must fold the whole log. */
function cloneSession(source) {
	const events = source.events;
	return {
		id: source.id,
		header: source.header,
		inheritedEventCount: source.inheritedEventCount,
		seq: source.seq,
		events,
		eventAt: (seq) => events[seq],
		snapshotEvents: (from = 0, to = events.length) => events.slice(from, to),
		steer() {},
	};
}

/** An independent registry and Agent Teams service, with no fold extension. */
function createUnwrappedReader() {
	const ctx = new Context();
	new SessionProjectionRegistry(ctx);
	ctx.provide('agents', { list: () => [], get: () => undefined });
	ctx.provide('sessions', { flush: async () => {}, get: () => undefined });
	ctx.provide('sessionPersistence', {
		open: async () => {
			throw new Error('no persisted session in this harness');
		},
	});
	ctx.provide('subagents', { interrupt() {}, drainContinuableChildren: async () => {} });
	new TeamService(ctx, {});
	return ctx.sessionProjections;
}

function createHarness({ failDrain = false } = {}) {
	const ctx = new Context();
	new SessionProjectionRegistry(ctx);
	const agents = new Map();
	const calls = { interrupt: [], drain: [], warn: [] };

	ctx.provide('agents', { list: () => [...agents.values()], get: (id) => agents.get(id) });
	ctx.provide('sessions', { flush: async () => {}, get: () => undefined });
	ctx.provide('sessionPersistence', {
		open: async () => {
			throw new Error('no persisted session in this harness');
		},
	});
	ctx.provide('subagents', {
		interrupt: (id, authority) => calls.interrupt.push({ id, authority }),
		drainContinuableChildren: async (parent, childIds) => {
			calls.drain.push({ parentId: parent.id, childIds: [...childIds] });
			if (failDrain) throw new Error('drain exploded');
		},
	});
	// The runtime logger is cordis's own; spy on it so the warning path is observable.
	ctx.logger.warn = (...args) => calls.warn.push(args.map((arg) => (typeof arg === 'string' ? arg : String(arg?.message ?? arg))).join(' '));

	const session = (id, parentSession) => {
		const events = [];
		const handle = {
			id,
			header: { id, parentSession },
			inheritedEventCount: 0,
			get seq() {
				return events.length;
			},
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

	const leadSession = session(LEAD_ID, undefined);
	const leadAgent = { id: LEAD_ID, status: 'idle', options: {}, session: leadSession };
	agents.set(LEAD_ID, leadAgent);

	const service = new TeamService(ctx, {});
	const uninstall = installRosterFold(ctx.sessionProjections);
	const fold = (type, data, target = leadSession) => target.append(type, data);
	const member = (id, name, phase = 'provisioning', extra = {}) => ({
		id,
		name,
		description: `${name} duty`,
		provider: 'spawn',
		context: 'fresh',
		phase,
		...extra,
	});
	const addMember = (id, name, phase = 'provisioning', extra = {}) => fold('team/member', { version: 2, teamId: LEAD_ID, member: member(id, name, phase, extra) });
	const addActiveMember = (id, name) => {
		addMember(id, name);
		addMember(id, name, 'active');
	};
	const queueMessage = (id, senderId, targetId) =>
		fold('team/message/queued', {
			version: 2,
			teamId: LEAD_ID,
			message: { id, senderId, senderName: senderId === LEAD_ID ? 'lead' : 'peer', targetId, content: [{ type: 'text', text: 'hi' }] },
		});
	const deliverMessage = (id, targetId) => fold('team/message/delivered', { version: 2, teamId: LEAD_ID, messageId: id, targetId });
	const renameMember = (id, name, newName, extra = {}, phase = 'active') => fold('team/member', {
		version: 2,
		teamId: LEAD_ID,
		member: member(id, name, phase, { renamedTo: newName, ...extra }),
	});

	return {
		ctx,
		agents,
		calls,
		service,
		uninstall,
		fold,
		addMember,
		addActiveMember,
		queueMessage,
		deliverMessage,
		renameMember,
		leadAgent,
		addTeammate(id = TEAMMATE_ID, status = 'running') {
			const agent = { id, status, options: {}, session: session(id, LEAD_ID) };
			agents.set(id, agent);
			return agent;
		},
		state(agent = leadAgent) {
			return service.journal.state(agent);
		},
		leadSession,
		get failure() {
			try {
				service.journal.state(leadAgent);
				return undefined;
			} catch (error) {
				return error.message;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Fold extension: installation contract
// ---------------------------------------------------------------------------

check('install: refuses a registry without the projection table', () => {
	assert.throws(() => installRosterFold({ register: () => () => {} }), /does not expose sessionProjections\.registrations/);
});

check('install: refuses a registry without the agentTeam unit', () => {
	const ctx = new Context();
	new SessionProjectionRegistry(ctx);
	assert.throws(() => installRosterFold(ctx.sessionProjections), /agentTeam projection is not registered/);
});

await checkAsync('install: wraps the live unit, is idempotent, and restores the fold', async () => {
	const harness = createHarness();
	const registration = harness.ctx.sessionProjections.registrations.get('agentTeam');
	assert.equal(typeof registration.def.apply, 'function');
	assert.equal(registration.def.apply.name, 'wrapped');
	const wrapped = registration.def.apply;
	const again = installRosterFold(harness.ctx.sessionProjections);
	assert.equal(registration.def.apply, wrapped, 'a second install must not double-wrap');
	again();
	assert.equal(registration.def.apply, wrapped);
	harness.uninstall();
	assert.notEqual(registration.def.apply, wrapped, 'the disposer must restore the packaged fold');
	harness.uninstall();
});

// ---------------------------------------------------------------------------
// Fold extension: deletion rules
// ---------------------------------------------------------------------------

check('fold: active -> removed drops the member and keeps the state shape', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.addActiveMember(PEER_ID, 'peer');
	harness.addMember(TEAMMATE_ID, 'probe', 'removed');
	assert.equal(harness.failure, undefined);
	assert.deepEqual(harness.state().members.map((row) => row.name), ['peer']);
	assert.deepEqual(Object.keys(harness.state()).sort(), STATE_FIELDS);
});

check('fold: failed -> removed drops the member', () => {
	const harness = createHarness();
	harness.addMember(TEAMMATE_ID, 'probe');
	harness.addMember(TEAMMATE_ID, 'probe', 'failed', { error: 'boom' });
	harness.addMember(TEAMMATE_ID, 'probe', 'removed');
	assert.equal(harness.failure, undefined);
	assert.deepEqual(harness.state().members, []);
});

check('fold: provisioning -> removed is rejected', () => {
	const harness = createHarness();
	harness.addMember(TEAMMATE_ID, 'probe');
	harness.addMember(TEAMMATE_ID, 'probe', 'removed');
	assert.match(harness.failure, /invalid provisioning -> removed transition/);
});

check('fold: removing a member that is not on the roster is rejected', () => {
	const harness = createHarness();
	harness.addMember(TEAMMATE_ID, 'probe', 'removed');
	assert.match(harness.failure, /is not on the roster/);
});

check('fold: a malformed removal payload freezes the projection instead of throwing', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.fold('team/member', { version: 2, teamId: LEAD_ID, member: { phase: 'removed' } });
	assert.match(harness.failure, /removal payload is invalid/);
});

check('fold: a removal event for another Team is ignored', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.fold('team/member', { version: 2, teamId: 'session-other', member: { ...harness.state().members[0], phase: 'removed' } });
	assert.equal(harness.failure, undefined);
	assert.deepEqual(harness.state().members.map((row) => row.name), ['probe']);
});

check('fold: a removed name becomes reusable through the packaged fold', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.addMember(TEAMMATE_ID, 'probe', 'removed');
	harness.addActiveMember(PEER_ID, 'probe');
	assert.equal(harness.failure, undefined);
	assert.deepEqual(harness.state().members.map((row) => [row.id, row.name, row.phase]), [[PEER_ID, 'probe', 'active']]);
});

check('fold: removal drops undelivered mail and keeps delivered mail', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.addActiveMember(PEER_ID, 'peer');
	harness.queueMessage('message-dropped', LEAD_ID, TEAMMATE_ID);
	harness.queueMessage('message-kept', LEAD_ID, PEER_ID);
	harness.queueMessage('message-sent', LEAD_ID, TEAMMATE_ID);
	harness.deliverMessage('message-sent', TEAMMATE_ID);
	harness.addMember(TEAMMATE_ID, 'probe', 'removed');
	assert.equal(harness.failure, undefined);
	assert.deepEqual(harness.state().messages.map((message) => message.id), ['message-kept', 'message-sent']);
	assert.deepEqual(harness.state().delivered, ['message-sent']);
});

check('fold: a late acknowledgement for dropped mail is ignored', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.queueMessage('message-dropped', LEAD_ID, TEAMMATE_ID);
	harness.addMember(TEAMMATE_ID, 'probe', 'removed');
	harness.deliverMessage('message-dropped', TEAMMATE_ID);
	assert.equal(harness.failure, undefined);
	assert.deepEqual(harness.state().delivered, []);
});

check('fold: an acknowledgement for an unknown message of a live target still fails', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.deliverMessage('message-missing', TEAMMATE_ID);
	assert.match(harness.failure, /was delivered before queueing/);
});

check('fold: events of other domains keep the state reference', () => {
	const harness = createHarness();
	const before = harness.state();
	harness.fold('turn/end', { reason: { kind: 'completed' } });
	assert.equal(harness.state(), before, 'an ignored event must not change the state reference');
	assert.equal(harness.failure, undefined);
});

check('fold: a foreign team event keeps the state reference', () => {
	const harness = createHarness();
	const before = harness.state();
	harness.fold('team/member', { version: 2, teamId: 'session-other', member: { id: 'x', name: 'y', description: 'd', provider: 'spawn', context: 'fresh', phase: 'provisioning' } });
	assert.equal(harness.state(), before);
	assert.equal(harness.failure, undefined);
});

check('fold: removal keeps the failure short-circuit of the packaged fold', () => {
	const harness = createHarness();
	const failed = { ...harness.state(), failure: 'earlier failure' };
	const original = () => {
		throw new Error('must not be called');
	};
	const next = applyRosterFold(failed, { type: 'team/member', data: { version: 2, teamId: LEAD_ID, member: { id: TEAMMATE_ID, name: 'probe', phase: 'removed' } } }, original);
	assert.equal(next, failed);
});

// ---------------------------------------------------------------------------
// Replay of a durable log that contains a removal
// ---------------------------------------------------------------------------

check('replay: a fresh cell over a log with a removal folds cleanly', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.queueMessage('message-pending', LEAD_ID, TEAMMATE_ID);
	harness.addMember(TEAMMATE_ID, 'probe', 'removed');
	const replayed = harness.ctx.sessionProjections.stateOf(cloneSession(harness.leadSession), 'agentTeam');
	assert.equal(replayed.failure, undefined);
	assert.deepEqual(replayed.members, []);
	assert.deepEqual(replayed.messages, []);
	assert.deepEqual(replayed.delivered, []);
});

check('replay: an unwrapped reader freezes on the removal payload', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.addMember(TEAMMATE_ID, 'probe', 'removed');
	const state = createUnwrappedReader().stateOf(cloneSession(harness.leadSession), 'agentTeam');
	assert.match(state.failure, /persisted Agent Teams team\/member payload is invalid/);
});

// ---------------------------------------------------------------------------
// Deletion through the live service
// ---------------------------------------------------------------------------

await checkAsync('delete: releases tasks, stops the runtime, and removes the member', async () => {
	const harness = createHarness();
	const teammate = harness.addTeammate(TEAMMATE_ID, 'running');
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	const task = await harness.service.createTask(harness.leadAgent, { subject: 'probe work', description: 'do it' });
	const claimed = await harness.service.updateTask(teammate, { taskId: task.id, expectedRevision: task.revision, action: 'claim' });
	harness.queueMessage('message-pending', LEAD_ID, TEAMMATE_ID);

	const result = await removeTeammate(harness.ctx, harness.leadAgent, 'probe');

	assert.deepEqual(result, { name: 'probe', previousStatus: 'running', releasedTasks: [task.id], discardedMessages: ['message-pending'] });
	assert.deepEqual(harness.calls.interrupt.map((call) => call.id), [TEAMMATE_ID]);
	assert.deepEqual(harness.calls.interrupt[0].authority, { kind: 'ancestor', agent: harness.leadAgent });
	assert.deepEqual(harness.calls.drain, [{ parentId: LEAD_ID, childIds: [TEAMMATE_ID] }]);
	assert.equal(harness.failure, undefined);
	assert.deepEqual(harness.state().members, []);
	assert.deepEqual(harness.state().messages, []);
	const released = harness.service.getTask(harness.leadAgent, task.id);
	assert.equal(released.status, 'pending');
	assert.equal(released.ownerName, undefined);
	assert.equal(released.revision, claimed.revision + 1);
});

await checkAsync('delete: an inactive teammate reports inactive and needs no interrupt', async () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	const result = await removeTeammate(harness.ctx, harness.leadAgent, 'probe');
	assert.equal(result.previousStatus, 'inactive');
	assert.deepEqual(harness.calls.interrupt, []);
	assert.deepEqual(result.releasedTasks, []);
});

await checkAsync('delete: the removed member leaves the service roster and its mailbox', async () => {
	const harness = createHarness();
	harness.addTeammate(TEAMMATE_ID, 'inactive');
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	await removeTeammate(harness.ctx, harness.leadAgent, 'probe');
	assert.deepEqual(harness.service.listMembers(harness.leadAgent).map((row) => row.name), ['lead']);
	await rejectsCode('delete: messaging a deleted teammate fails', () => harness.service.sendMessage(harness.leadAgent, { target: 'probe', content: [{ type: 'text', text: 'hi' }], signal: new AbortController().signal }), 'TEAM_MEMBER_NOT_FOUND');
});

await checkAsync('delete: deleting twice reports the member as gone', async () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	await removeTeammate(harness.ctx, harness.leadAgent, 'probe');
	await rejectsCode('delete: the second deletion fails', () => removeTeammate(harness.ctx, harness.leadAgent, 'probe'), 'TEAM_MEMBER_NOT_FOUND');
});

await rejectsCode('delete: a non-Lead caller is refused', () => {
	const harness = createHarness();
	const teammate = harness.addTeammate(TEAMMATE_ID, 'inactive');
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	return removeTeammate(harness.ctx, teammate, 'probe');
}, 'TEAM_LEAD_REQUIRED');

await rejectsCode('delete: an unknown target is refused', () => {
	const harness = createHarness();
	return removeTeammate(harness.ctx, harness.leadAgent, 'nobody');
}, 'TEAM_MEMBER_NOT_FOUND');

await rejectsCode('delete: the Lead itself is refused', () => {
	const harness = createHarness();
	return removeTeammate(harness.ctx, harness.leadAgent, 'lead');
}, 'TEAM_INVALID_TARGET');

await rejectsCode('delete: a provisioning member is refused', () => {
	const harness = createHarness();
	harness.addMember(TEAMMATE_ID, 'probe');
	return removeTeammate(harness.ctx, harness.leadAgent, 'probe');
}, 'TEAM_MEMBER_BUSY');

await checkAsync('delete: a drain failure is reported as a warning, not as a deletion failure', async () => {
	const harness = createHarness({ failDrain: true });
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	const result = await removeTeammate(harness.ctx, harness.leadAgent, 'probe');
	assert.equal(result.name, 'probe');
	assert.deepEqual(harness.state().members, []);
	assert.equal(harness.calls.warn.length, 1);
	assert.match(harness.calls.warn[0], /draining the removed teammate runtime failed/);
});

// ---------------------------------------------------------------------------
// Fold extension: rename
// ---------------------------------------------------------------------------

check('fold: rename changes the name and keeps the row, phase, and state shape', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	const before = harness.state().members[0];
	harness.renameMember(TEAMMATE_ID, 'probe', 'scout');
	const state = harness.state();
	assert.equal(state.failure, undefined);
	assert.deepEqual(Object.keys(state).sort(), [...STATE_FIELDS].sort());
	assert.equal(state.members.length, 1);
	assert.equal(state.members[0].name, 'scout');
	assert.equal(state.members[0].phase, 'active');
	assert.deepEqual({ ...state.members[0], name: 'probe' }, before);
	assert.equal(state.members[0].renamedTo, undefined);
});

check('fold: rename keeps a failed member', () => {
	const harness = createHarness();
	harness.addMember(TEAMMATE_ID, 'probe');
	harness.addMember(TEAMMATE_ID, 'probe', 'failed');
	harness.renameMember(TEAMMATE_ID, 'probe', 'scout', {}, 'failed');
	const state = harness.state();
	assert.equal(state.failure, undefined);
	assert.equal(state.members[0].name, 'scout');
	assert.equal(state.members[0].phase, 'failed');
});

check('fold: renaming a provisioning member is rejected', () => {
	const harness = createHarness();
	harness.addMember(TEAMMATE_ID, 'probe');
	harness.renameMember(TEAMMATE_ID, 'probe', 'scout', {}, 'provisioning');
	assert.match(harness.failure, /invalid provisioning -> rename transition/);
});

check('fold: renaming onto another member name is rejected', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.addActiveMember(PEER_ID, 'peer');
	harness.renameMember(TEAMMATE_ID, 'probe', 'peer');
	assert.match(harness.failure, /teammate name "peer" is reused by another member/);
});

check('fold: a rename payload that rewrites immutable fields is rejected', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.renameMember(TEAMMATE_ID, 'other', 'scout');
	assert.match(harness.failure, /changed immutable identity fields/);
});

check('fold: renaming a member that is not on the roster is rejected', () => {
	const harness = createHarness();
	harness.renameMember(TEAMMATE_ID, 'probe', 'scout');
	assert.match(harness.failure, /teammate "probe" is not on the roster/);
});

check('fold: a non-string rename payload is left to the packaged fold, which rejects it', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.fold('team/member', { version: 2, teamId: LEAD_ID, member: { id: TEAMMATE_ID, name: 'probe', phase: 'active', renamedTo: 7 } });
	assert.match(harness.failure, /persisted Agent Teams team\/member payload is invalid/);
});

check('fold: rename keeps messages, delivered mail, and tasks', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.queueMessage('message-pending', LEAD_ID, TEAMMATE_ID);
	harness.queueMessage('message-done', LEAD_ID, TEAMMATE_ID);
	harness.deliverMessage('message-done', TEAMMATE_ID);
	harness.renameMember(TEAMMATE_ID, 'probe', 'scout');
	const state = harness.state();
	assert.deepEqual(state.messages.map((message) => message.id), ['message-pending', 'message-done']);
	assert.deepEqual(state.delivered, ['message-done']);
});

check('fold: a rename to the current name keeps the state reference', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	const before = harness.state();
	harness.renameMember(TEAMMATE_ID, 'probe', 'probe');
	assert.equal(harness.state(), before);
});

check('fold: a rename frees the previous name for a new member', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.renameMember(TEAMMATE_ID, 'probe', 'scout');
	harness.addActiveMember(PEER_ID, 'probe');
	const state = harness.state();
	assert.equal(state.failure, undefined);
	assert.deepEqual(state.members.map((member) => member.name), ['scout', 'probe']);
});

check('fold: a rename event for another Team is ignored', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	const before = harness.state();
	harness.fold('team/member', { version: 2, teamId: 'session-other-team', member: { id: TEAMMATE_ID, name: 'probe', description: 'probe duty', provider: 'spawn', context: 'fresh', phase: 'active', renamedTo: 'scout' } });
	assert.equal(harness.state(), before);
});

// ---------------------------------------------------------------------------
// Replay of a durable log that contains a rename
// ---------------------------------------------------------------------------

check('replay: a fresh cell over a log with a rename folds cleanly', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.queueMessage('message-pending', LEAD_ID, TEAMMATE_ID);
	harness.renameMember(TEAMMATE_ID, 'probe', 'scout');
	const replayed = harness.ctx.sessionProjections.stateOf(cloneSession(harness.leadSession), 'agentTeam');
	assert.equal(replayed.failure, undefined);
	assert.deepEqual(replayed.members.map((member) => member.name), ['scout']);
	assert.deepEqual(replayed.messages.map((message) => message.id), ['message-pending']);
});

check('replay: a log with a rename and then a removal folds cleanly', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.renameMember(TEAMMATE_ID, 'probe', 'scout');
	harness.addMember(TEAMMATE_ID, 'scout', 'removed');
	const replayed = harness.ctx.sessionProjections.stateOf(cloneSession(harness.leadSession), 'agentTeam');
	assert.equal(replayed.failure, undefined);
	assert.deepEqual(replayed.members, []);
});

check('replay: an unwrapped reader freezes on the rename payload', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.renameMember(TEAMMATE_ID, 'probe', 'scout');
	const state = createUnwrappedReader().stateOf(cloneSession(harness.leadSession), 'agentTeam');
	assert.match(state.failure, /persisted Agent Teams team\/member payload is invalid/);
});

// ---------------------------------------------------------------------------
// Rename through the live service
// ---------------------------------------------------------------------------

await checkAsync('rename: renames the member, keeps its work, and returns both names', async () => {
	const harness = createHarness();
	harness.addTeammate(TEAMMATE_ID, 'running');
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.queueMessage('message-pending', LEAD_ID, TEAMMATE_ID);
	const teammate = harness.agents.get(TEAMMATE_ID);
	const task = await harness.service.createTask(harness.leadAgent, { subject: 'probe work', description: 'do it' });
	await harness.service.updateTask(teammate, { taskId: task.id, expectedRevision: task.revision, action: 'claim' });

	const result = await renameTeammate(harness.ctx, harness.leadAgent, 'probe', 'scout');

	assert.deepEqual(result, { previousName: 'probe', name: 'scout', status: 'running' });
	assert.equal(harness.failure, undefined);
	assert.equal(harness.state().members[0].name, 'scout');
	assert.equal(harness.state().members[0].phase, 'active');
	assert.deepEqual(harness.state().messages.map((message) => message.targetId), [TEAMMATE_ID]);
	assert.deepEqual(harness.calls.interrupt, []);
	assert.deepEqual(harness.calls.drain, []);
	const view = harness.service.getTask(harness.leadAgent, task.id);
	assert.equal(view.status, 'in_progress');
	assert.equal(view.ownerName, 'scout');
	assert.deepEqual(harness.service.listMembers(harness.leadAgent).map((row) => row.name), ['lead', 'scout']);
});

await checkAsync('rename: the new name addresses the member and the old name stops working', async () => {
	const harness = createHarness();
	harness.addTeammate(TEAMMATE_ID, 'inactive');
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	await renameTeammate(harness.ctx, harness.leadAgent, 'probe', 'scout');
	await rejectsCode('rename: the old name is gone', () => harness.service.sendMessage(harness.leadAgent, { target: 'probe', content: [{ type: 'text', text: 'hi' }], signal: new AbortController().signal }), 'TEAM_MEMBER_NOT_FOUND');
});

await checkAsync('rename: renaming to the current name appends nothing', async () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	const before = harness.leadSession.events.length;
	const result = await renameTeammate(harness.ctx, harness.leadAgent, 'probe', 'probe');
	assert.deepEqual(result, { previousName: 'probe', name: 'probe', status: 'inactive' });
	assert.equal(harness.leadSession.events.length, before);
});

await checkAsync('rename: a renamed member can then be deleted by its new name', async () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	await renameTeammate(harness.ctx, harness.leadAgent, 'probe', 'scout');
	const result = await removeTeammate(harness.ctx, harness.leadAgent, 'scout');
	assert.equal(result.name, 'scout');
	assert.deepEqual(harness.state().members, []);
});

await rejectsCode('rename: a non-Lead caller is refused', () => {
	const harness = createHarness();
	const teammate = harness.addTeammate(TEAMMATE_ID, 'inactive');
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	return renameTeammate(harness.ctx, teammate, 'probe', 'scout');
}, 'TEAM_LEAD_REQUIRED');

await rejectsCode('rename: an unknown target is refused', () => {
	const harness = createHarness();
	return renameTeammate(harness.ctx, harness.leadAgent, 'nobody', 'scout');
}, 'TEAM_MEMBER_NOT_FOUND');

await rejectsCode('rename: the Lead itself is refused', () => {
	const harness = createHarness();
	return renameTeammate(harness.ctx, harness.leadAgent, 'lead', 'scout');
}, 'TEAM_INVALID_TARGET');

await rejectsCode('rename: a provisioning member is refused', () => {
	const harness = createHarness();
	harness.addMember(TEAMMATE_ID, 'probe');
	return renameTeammate(harness.ctx, harness.leadAgent, 'probe', 'scout');
}, 'TEAM_MEMBER_BUSY');

await rejectsCode('rename: an invalid new name is refused', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	return renameTeammate(harness.ctx, harness.leadAgent, 'probe', 'Scout Leader');
}, 'TEAM_INVALID_MEMBER_NAME');

await rejectsCode('rename: the reserved name is refused', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	return renameTeammate(harness.ctx, harness.leadAgent, 'probe', 'lead');
}, 'TEAM_INVALID_MEMBER_NAME');

await rejectsCode('rename: a name in use is refused', () => {
	const harness = createHarness();
	harness.addActiveMember(TEAMMATE_ID, 'probe');
	harness.addActiveMember(PEER_ID, 'peer');
	return renameTeammate(harness.ctx, harness.leadAgent, 'probe', 'peer');
}, 'TEAM_MEMBER_NAME_TAKEN');

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Display order and bulk cleanup
// ---------------------------------------------------------------------------

/** A registry stand-in holding only the wire views the plugin rewrites. */
function fakeWireRegistry(views) {
	return {
		registrations: new Map(Object.entries(views).map(([key, view]) => [key, {
			def: {
				wire: {
					viewSchema: { parse: (value) => value },
					view,
				},
			},
		}])),
	};
}

const TEAM_VIEW = {
	members: [
		{ id: 'session-lead', name: 'lead', role: 'lead', phase: 'active' },
		{ id: 'session-1', name: 'probe', role: 'teammate', phase: 'active' },
		{ id: 'session-2', name: 'scout', role: 'teammate', phase: 'active' },
		{ id: 'session-3', name: 'runner', role: 'teammate', phase: 'failed' },
	],
	tasks: [{ id: 'task-1' }, { id: 'task-2' }, { id: 'task-3' }],
	failure: 'kept',
};

check('orderTeamView: keeps the Lead first and renders teammates and tasks newest first', () => {
	const ordered = orderTeamView(TEAM_VIEW);
	assert.deepEqual(ordered.members.map((member) => member.name), ['lead', 'runner', 'scout', 'probe']);
	assert.deepEqual(ordered.tasks.map((task) => task.id), ['task-3', 'task-2', 'task-1']);
	assert.equal(ordered.failure, 'kept');
	assert.deepEqual(TEAM_VIEW.members.map((member) => member.name), ['lead', 'probe', 'scout', 'runner'], 'the packaged view is not mutated');
});

check('orderTeamView: an unexpected view value is returned unchanged', () => {
	assert.deepEqual(orderTeamView({ members: [], tasks: [] }), { members: [], tasks: [] });
	assert.equal(orderTeamView(undefined), undefined);
	assert.equal(orderTeamView('nope'), 'nope');
});

check('orderCatalogView: renders the newest child first without mutating the input', () => {
	const entries = [{ id: 'old', createdAt: 1 }, { id: 'newest', createdAt: 9 }, { id: 'middle', createdAt: 5 }];
	assert.deepEqual(orderCatalogView(entries).map((entry) => entry.id), ['newest', 'middle', 'old']);
	assert.deepEqual(entries.map((entry) => entry.id), ['old', 'newest', 'middle']);
	assert.equal(orderCatalogView(undefined), undefined);
});

check('installDisplayOrder: rewrites both wire views and one disposer restores them', () => {
	const registry = fakeWireRegistry({ agentTeam: () => TEAM_VIEW, subagentCatalog: () => [{ id: 'old', createdAt: 1 }, { id: 'new', createdAt: 2 }] });
	const dispose = installDisplayOrder(registry);
	assert.deepEqual(registry.registrations.get('agentTeam').def.wire.view(undefined).members.map((member) => member.name), ['lead', 'runner', 'scout', 'probe']);
	assert.deepEqual(registry.registrations.get('subagentCatalog').def.wire.view(undefined).map((entry) => entry.id), ['new', 'old']);
	dispose();
	assert.deepEqual(registry.registrations.get('agentTeam').def.wire.view(undefined).members.map((member) => member.name), ['lead', 'probe', 'scout', 'runner']);
	assert.deepEqual(registry.registrations.get('subagentCatalog').def.wire.view(undefined).map((entry) => entry.id), ['old', 'new']);
});

check('installDisplayOrder: a second install is inert and its disposer leaves the first wrap alone', () => {
	const registry = fakeWireRegistry({ agentTeam: () => TEAM_VIEW, subagentCatalog: () => [] });
	const dispose = installDisplayOrder(registry);
	const disposeAgain = installDisplayOrder(registry);
	disposeAgain();
	assert.deepEqual(registry.registrations.get('agentTeam').def.wire.view(undefined).members.map((member) => member.name), ['lead', 'runner', 'scout', 'probe']);
	dispose();
	assert.deepEqual(registry.registrations.get('agentTeam').def.wire.view(undefined).members.map((member) => member.name), ['lead', 'probe', 'scout', 'runner']);
});

check('installDisplayOrder: an unchanged source value keeps one ordered reference', () => {
	let current = { members: [{ id: 'l', name: 'lead', role: 'lead' }, { id: 'a', name: 'a', role: 'teammate' }], tasks: [] };
	const registry = fakeWireRegistry({ agentTeam: () => current, subagentCatalog: () => [] });
	const dispose = installDisplayOrder(registry);
	const view = registry.registrations.get('agentTeam').def.wire.view;
	// The packaged unit promises that a change it ignores republishes nothing,
	// which only holds while the client value keeps its reference.
	const first = view(undefined);
	assert.equal(view(undefined), first);
	assert.notEqual(first, current);
	// The packaged value lists rows oldest first, so a new teammate is appended.
	current = { members: [...current.members, { id: 'b', name: 'b', role: 'teammate' }], tasks: [] };
	const second = view(undefined);
	assert.notEqual(second, first);
	assert.deepEqual(second.members.map((member) => member.name), ['lead', 'b', 'a']);
	dispose();
	assert.equal(registry.registrations.get('agentTeam').def.wire.view(undefined), current, 'the packaged view is restored');
});

check('installDisplayOrder: a non-object source value is ordered without memoizing', () => {
	const registry = fakeWireRegistry({ agentTeam: () => TEAM_VIEW, subagentCatalog: () => undefined });
	installDisplayOrder(registry);
	const view = registry.registrations.get('agentTeam').def.wire.view;
	assert.equal(view(undefined), view(undefined), 'the packaged source is a stable object here');
	assert.equal(registry.registrations.get('subagentCatalog').def.wire.view(undefined), undefined);
});

check('installDisplayOrder: a missing Agent Teams wire view fails loudly', () => {
	assert.throws(() => installDisplayOrder(fakeWireRegistry({})), /agentTeam projection exposes no wire view/);
	assert.throws(() => installDisplayOrder({ registrations: new Map([['agentTeam', { def: {} }]]) }), /exposes no wire view/);
});

check('installDisplayOrder: a missing catalog wire view warns and still orders the Team view', () => {
	const warnings = [];
	const registry = fakeWireRegistry({ agentTeam: () => TEAM_VIEW });
	const dispose = installDisplayOrder(registry, { logger: { warn: (message) => warnings.push(message) } });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /subagentCatalog projection exposes no wire view/);
	assert.deepEqual(registry.registrations.get('agentTeam').def.wire.view(undefined).tasks.map((task) => task.id), ['task-3', 'task-2', 'task-1']);
	dispose();
});

console.log(`${passes.length} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure.name}: ${failure.error}`);
process.exitCode = failures.length === 0 ? 0 : 1;
