/**
 * Agent Teams roster administration: rename and delete teammates.
 *
 * The shipped `dsh-experimental-agent-team` package owns the durable roster: a
 * teammate exists while the folded `agentTeam` projection keeps a member row,
 * and that fold treats `name` as an immutable identity field. This plugin does
 * not copy or patch the package; it extends the live projection unit in place:
 *
 * - `installRosterFold` wraps the registered `agentTeam` unit's `apply`, so two
 *   roster mutations become expressible as new values of the existing
 *   `team/member` event type:
 *   - `renamedTo` on the member payload renames that member and keeps its real
 *     phase, history, session, tasks, and pending mail.
 *   - `phase: "removed"` drops that member row and its undelivered mail.
 *   Everything else is delegated to the packaged fold, so every official reader
 *   (roster, mailbox, task board, tools, client view) sees the change without
 *   knowing about this plugin, and state shape plus `stateVersion` stay official.
 * - `renameTeammate` and `removeTeammate` perform one mutation each through the
 *   live service, validating everything before the durable append so an invalid
 *   request can never freeze the Team projection.
 * - `installDisplayOrder` wraps the registered wire views of `agentTeam` and
 *   `subagentCatalog` so the roster, the shared task board, and the subagent
 *   conversation catalog render newest first. The wire view is the client-facing
 *   projection value, so fold state, `stateVersion`, and every service contract
 *   keep the packaged order.
 * - `cleanupTeam` deletes settled teammates and completed tasks in bulk through
 *   the same service paths the single-target tools use.
 *
 * The mutations are recorded as new values of an existing event type; a dsh
 * build without this plugin folds either value as invalid and freezes that
 * session's Team projection. See README.md.
 *
 * @module dsh-agent-team-roster
 */
import { TeamError, TeamId } from '@deepseek-ai/dsh-experimental-agent-team';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Cordis plugin name. */
export const name = 'agent-team-roster';
/** Services required by the roster plugin. */
export const inject = [
	'agents',
	'agentTeams',
	'sessionProjections',
	'subagents',
	'systemPrompt',
	'tools',
];

/** Projection unit key owned by the shipped Agent Teams package. */
const TEAM_PROJECTION_KEY = 'agentTeam';
/** Member phase that records one durable deletion. */
const REMOVED_PHASE = 'removed';
/** Member payload field that records one durable rename. */
const RENAME_FIELD = 'renamedTo';
/** Marks an already wrapped fold, so reload and double install stay harmless. */
const WRAPPED = Symbol('dsh-agent-team-roster.wrapped');
/** Fallback copy of the packaged member-name rule, used only if the roster seam is absent. */
const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** Projection unit key owning the direct-child conversation catalog. */
const CATALOG_PROJECTION_KEY = 'subagentCatalog';
/** Marks an already wrapped wire view, so reload and double install stay harmless. */
const ORDER_WRAPPED = Symbol('dsh-agent-team-roster.order.wrapped');
/** Deletion scopes accepted by the cleanup tool. */
const CLEANUP_SCOPES = ['teammates', 'tasks', 'all'];

/**
 * Model-facing grounding rule. It is the only prompt text this plugin adds:
 * both tools are described by their own definitions.
 */
const POLICY = `Report and judge only what an artifact supports. Re-derive each claim from the real artifacts — files, command output, session logs, tool results — yourself before reporting it, and state plainly what you did not verify. Unverified reports and judgments are rejected.`;

/** Canonical value schema for one deletion result, in the tool declaration dialect. */
const DELETE_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		name: {
			type: 'string',
			required: true,
		},
		previousStatus: {
			type: 'string',
			required: true,
			enum: ['running', 'inactive'],
		},
		releasedTasks: {
			type: 'array',
			required: true,
			items: { type: 'string' },
		},
		discardedMessages: {
			type: 'array',
			required: true,
			items: { type: 'string' },
		},
	},
};

/** Canonical value schema for one rename result, in the tool declaration dialect. */
const RENAME_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		previousName: {
			type: 'string',
			required: true,
		},
		name: {
			type: 'string',
			required: true,
		},
		status: {
			type: 'string',
			required: true,
			enum: ['running', 'inactive'],
		},
	},
};

/** Canonical value schema for one cleanup result, in the tool declaration dialect. */
const CLEANUP_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		scope: {
			type: 'string',
			required: true,
			enum: CLEANUP_SCOPES,
		},
		teammates: {
			type: 'array',
			required: true,
			items: { type: 'string' },
		},
		tasks: {
			type: 'array',
			required: true,
			items: { type: 'string' },
		},
		releasedTasks: {
			type: 'array',
			required: true,
			items: { type: 'string' },
		},
		skipped: {
			type: 'array',
			required: true,
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					kind: {
						type: 'string',
						required: true,
						enum: ['teammate', 'task'],
					},
					target: {
						type: 'string',
						required: true,
					},
					reason: {
						type: 'string',
						required: true,
					},
				},
			},
		},
	},
};

// ---------------------------------------------------------------------------
// Fold extension
// ---------------------------------------------------------------------------

/**
 * Test whether one event records a deletion.
 * @param event - candidate Session event.
 * @returns whether the event is a `team/member` removal.
 */
function isRemovalEvent(event) {
	return event?.type === 'team/member' && event.data?.member?.phase === REMOVED_PHASE;
}

/**
 * Test whether one event records a rename.
 * @param event - candidate Session event.
 * @returns whether the event is a `team/member` rename.
 */
function isRenameEvent(event) {
	return event?.type === 'team/member' && typeof event.data?.member?.[RENAME_FIELD] === 'string';
}

/**
 * Test whether one event acknowledges the delivery of a message this plugin
 * dropped with its removed target. The packaged fold rejects that ordering, and
 * a durable acknowledgement can land after the removal commit.
 * @param state - current Team state.
 * @param event - candidate Session event.
 * @returns whether the fold must ignore this acknowledgement.
 */
function isDiscardedDelivery(state, event) {
	if (event?.type !== 'team/message/delivered') return false;
	const data = event.data;
	if (data === undefined || data.teamId !== state.id) return false;
	if (typeof data.messageId !== 'string' || typeof data.targetId !== 'string') return false;
	if (state.messages.some((message) => message.id === data.messageId)) return false;
	return !state.members.some((member) => member.id === data.targetId);
}

/**
 * Replace one array entry, appending when the index does not exist.
 * @param items - source array.
 * @param index - entry index, or a negative value to append.
 * @param item - replacement entry.
 * @returns a new array.
 */
function replaceAt(items, index, item) {
	const next = [...items];
	if (index < 0) next.push(item);
	else next[index] = item;
	return next;
}

/**
 * Drop one removed member and its undelivered mail.
 * @param state - current Team state.
 * @param member - removal payload member snapshot.
 * @returns the next state, which keeps the official shape.
 */
function dropRemovedMember(state, member) {
	if (member === undefined || typeof member.id !== 'string' || typeof member.name !== 'string') throw new Error('persisted Agent Teams team/member removal payload is invalid');
	const prior = state.members.find((candidate) => candidate.id === member.id);
	if (prior === undefined) throw new Error(`teammate "${member.name}" is not on the roster`);
	if (prior.phase !== 'active' && prior.phase !== 'failed') throw new Error(`teammate "${member.name}" has an invalid ${prior.phase} -> ${REMOVED_PHASE} transition`);
	const delivered = state.delivered;
	return {
		...state,
		members: state.members.filter((candidate) => candidate.id !== member.id),
		messages: state.messages.filter((message) => message.targetId !== member.id || delivered.includes(message.id)),
	};
}

/**
 * Rename one member, keeping every other field of its row.
 * @param state - current Team state.
 * @param member - rename payload member snapshot.
 * @returns the next state, which keeps the official shape.
 */
function applyRename(state, member) {
	const name = member?.[RENAME_FIELD];
	if (member === undefined || typeof member.id !== 'string' || typeof member.name !== 'string' || typeof name !== 'string') throw new Error('persisted Agent Teams team/member rename payload is invalid');
	const index = state.members.findIndex((candidate) => candidate.id === member.id);
	const prior = state.members[index];
	if (prior === undefined) throw new Error(`teammate "${member.name}" is not on the roster`);
	if (prior.phase !== 'active' && prior.phase !== 'failed') throw new Error(`teammate "${prior.name}" has an invalid ${prior.phase} -> rename transition`);
	if (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context) throw new Error(`teammate "${member.id}" changed immutable identity fields`);
	if (state.members.some((candidate) => candidate.id !== prior.id && candidate.name === name)) throw new Error(`teammate name "${name}" is reused by another member`);
	if (prior.name === name) return state;
	return {
		...state,
		members: replaceAt(state.members, index, {
			...prior,
			name,
		}),
	};
}

/**
 * Extend one Team fold with the roster mutations, then delegate everything else.
 * @param state - current Team state.
 * @param event - committed Session event.
 * @param original - the packaged fold for every other event.
 * @returns the next state; an invalid mutation freezes the projection the same
 * way the packaged fold freezes it.
 */
export function applyRosterFold(state, event, original) {
	if (state.failure !== undefined) return state;
	if (isRemovalEvent(event) || isRenameEvent(event)) {
		if (event.data.teamId !== state.id) return state;
		try {
			return isRemovalEvent(event) ? dropRemovedMember(state, event.data.member) : applyRename(state, event.data.member);
		} catch (error) {
			return { ...state, failure: error instanceof Error ? error.message : String(error) };
		}
	}
	if (isDiscardedDelivery(state, event)) return state;
	return original(state, event);
}

/**
 * Extend the live `agentTeam` projection unit in place.
 * @param registry - the `sessionProjections` service.
 * @returns the disposer that restores the packaged fold.
 * @throws when this dsh build no longer exposes the projection registry shape
 * this extension relies on, so the plugin fails loudly instead of silently
 * installing unusable tools.
 */
export function installRosterFold(registry) {
	const registrations = registry?.registrations;
	if (!(registrations instanceof Map)) throw new Error('agent-team-roster: this dsh build does not expose sessionProjections.registrations, so the Agent Teams fold cannot be extended');
	const registration = registrations.get(TEAM_PROJECTION_KEY);
	if (registration === undefined) throw new Error(`agent-team-roster: the ${TEAM_PROJECTION_KEY} projection is not registered`);
	const definition = registration.def;
	if (definition === undefined || typeof definition.apply !== 'function') throw new Error(`agent-team-roster: the ${TEAM_PROJECTION_KEY} projection has no fold to extend`);
	if (definition.apply[WRAPPED] === true) return () => {};
	const original = definition.apply;
	const wrapped = (state, event) => applyRosterFold(state, event, original);
	wrapped[WRAPPED] = true;
	definition.apply = wrapped;
	return () => {
		if (definition.apply === wrapped) definition.apply = original;
	};
}

// ---------------------------------------------------------------------------
// Display order
// ---------------------------------------------------------------------------

/**
 * Copy rows in reverse order, so the newest durable row renders first.
 * @param rows - packaged rows in oldest-first order.
 * @returns a new array; the input is never mutated.
 */
function newestFirst(rows) {
	return [...rows].reverse();
}

/**
 * Order one Team projection view for display: the Lead row stays first because
 * it anchors the panel to the current conversation, and the teammates and tasks
 * after it render newest first.
 * @param view - packaged Team projection view.
 * @returns a new view value, or the input when it is not the packaged shape.
 */
export function orderTeamView(view) {
	const members = view?.members;
	const tasks = view?.tasks;
	if (!Array.isArray(members) || !Array.isArray(tasks)) return view;
	return {
		...view,
		members: [...members.filter((member) => member?.role === 'lead'), ...newestFirst(members.filter((member) => member?.role !== 'lead'))],
		tasks: newestFirst(tasks),
	};
}

/**
 * Order one subagent conversation catalog view newest first.
 * @param entries - packaged direct-child rows in catalog event order.
 * @returns a new array, or the input when it is not the packaged shape.
 */
export function orderCatalogView(entries) {
	if (!Array.isArray(entries)) return entries;
	return [...entries].sort((left, right) => (right?.createdAt ?? 0) - (left?.createdAt ?? 0));
}

/**
 * Resolve the writable wire view of one registered projection.
 * @param registry - the `sessionProjections` service.
 * @param key - projection unit key.
 * @returns the registration's wire object, or undefined when the build differs.
 */
function wireViewOf(registry, key) {
	const wire = registry?.registrations?.get?.(key)?.def?.wire;
	if (wire === undefined || typeof wire.view !== 'function') return undefined;
	return wire;
}

/**
 * Replace one projection's wire view with an ordered wrapper.
 * @param wire - the registration's wire object.
 * @param order - display-order transform applied to the packaged view value.
 * @returns the disposer that restores the packaged view.
 */
function wrapWireView(wire, order) {
	if (wire.view[ORDER_WRAPPED] === true) return () => {};
	const original = wire.view;
	// A packaged view memoizes its latest value so state changes the unit itself
	// ignores (mailbox-only Team changes) reuse one reference and republish
	// nothing. Keying the ordered value by that source reference keeps the
	// contract: an unchanged source value yields one unchanged ordered value.
	const ordered = new WeakMap();
	const wrapped = (state) => {
		const source = original(state);
		if (source === null || typeof source !== 'object') return order(source);
		let value = ordered.get(source);
		if (value === undefined) {
			value = order(source);
			ordered.set(source, value);
		}
		return value;
	};
	wrapped[ORDER_WRAPPED] = true;
	wire.view = wrapped;
	return () => {
		if (wire.view === wrapped) wire.view = original;
	};
}

/**
 * Extend the live `agentTeam` and `subagentCatalog` projection units so their
 * client-facing views render newest first, leaving every stored value intact.
 * @param registry - the `sessionProjections` service.
 * @param ctx - plugin context, used for the one optional-seam warning.
 * @returns the disposer that restores both packaged views.
 * @throws when this dsh build no longer exposes the Agent Teams wire view, so
 * the plugin fails loudly instead of rendering the packaged order silently.
 */
export function installDisplayOrder(registry, ctx = {}) {
	const team = wireViewOf(registry, TEAM_PROJECTION_KEY);
	if (team === undefined) throw new Error(`agent-team-roster: the ${TEAM_PROJECTION_KEY} projection exposes no wire view to reorder`);
	const catalog = wireViewOf(registry, CATALOG_PROJECTION_KEY);
	if (catalog === undefined) ctx.logger?.warn(`agent-team-roster: the ${CATALOG_PROJECTION_KEY} projection exposes no wire view, so subagent conversations keep their packaged order`);
	const disposers = [wrapWireView(team, orderTeamView)];
	if (catalog !== undefined) disposers.push(wrapWireView(catalog, orderCatalogView));
	return () => {
		for (const dispose of disposers.reverse()) dispose();
	};
}

// ---------------------------------------------------------------------------
// Roster mutations
// ---------------------------------------------------------------------------

/** Availability of one live Agent, matching the packaged roster rule. */
function availability(agent) {
	return agent?.status === 'running' ? 'running' : 'inactive';
}

/**
 * Validate one model-facing member name with the packaged rule.
 * @param service - the Agent Teams service.
 * @param value - candidate name.
 * @returns the accepted name.
 */
function memberName(service, value) {
	const validate = service.roster?.memberName;
	if (typeof validate === 'function') return validate.call(service.roster, value);
	if (!MEMBER_NAME.test(value) || value.length > 64 || value === 'lead') throw new TeamError('teammate name must be lower-kebab-case, at most 64 characters, and not "lead"', 'TEAM_INVALID_MEMBER_NAME');
	return value;
}

/**
 * Rename one settled teammate as its Team Lead.
 * @param ctx - plugin context.
 * @param caller - exact live Agent used as the authority credential.
 * @param targetName - current model-facing member name.
 * @param requestedName - new model-facing member name.
 * @returns the previous name, the new name, and the sampled status.
 */
export async function renameTeammate(ctx, caller, targetName, requestedName) {
	const service = ctx.agentTeams;
	const membership = service.membership(caller);
	if (membership.role !== 'lead') throw new TeamError('only the Team Lead can rename teammates', 'TEAM_LEAD_REQUIRED');
	const root = membership.root;
	const current = targetName.trim();
	if (current === 'lead') throw new TeamError('the Team Lead cannot be renamed', 'TEAM_INVALID_TARGET');
	const name = memberName(service, requestedName.trim());
	const state = service.journal.state(root);
	const member = state.members.find((candidate) => candidate.name === current);
	if (member === undefined) throw new TeamError(`teammate "${current}" not found`, 'TEAM_MEMBER_NOT_FOUND');
	if (member.phase === 'provisioning') throw new TeamError(`teammate "${current}" is still provisioning`, 'TEAM_MEMBER_BUSY');
	if (state.members.some((candidate) => candidate.id !== member.id && candidate.name === name)) throw new TeamError(`teammate name "${name}" was already used in this Team`, 'TEAM_MEMBER_NAME_TAKEN');
	if (member.name === name) return {
		previousName: member.name,
		name,
		status: availability(ctx.agents.get(member.id)),
	};
	await service.journal.transact(root.id, async () => {
		const latest = service.journal.state(root);
		const row = latest.members.find((candidate) => candidate.id === member.id);
		if (row === undefined) throw new TeamError(`teammate "${current}" not found`, 'TEAM_MEMBER_NOT_FOUND');
		if (row.phase === 'provisioning') throw new TeamError(`teammate "${current}" is still provisioning`, 'TEAM_MEMBER_BUSY');
		if (latest.members.some((candidate) => candidate.id !== member.id && candidate.name === name)) throw new TeamError(`teammate name "${name}" was already used in this Team`, 'TEAM_MEMBER_NAME_TAKEN');
		await service.journal.appendAndFlush(root, 'team/member', {
			version: 2,
			teamId: TeamId(root.id),
			member: {
				...row,
				[RENAME_FIELD]: name,
			},
		});
	});
	return {
		previousName: member.name,
		name,
		status: availability(ctx.agents.get(member.id)),
	};
}

/**
 * Await the in-flight delivery operation for one target, if any.
 * @param service - the Agent Teams service.
 * @param memberId - target Session identity.
 */
async function settleDelivery(service, memberId) {
	const tail = service.mailbox?.dispatchTails?.get?.(memberId);
	if (tail !== undefined) await tail.catch(() => {});
}

/**
 * Release every unfinished task owned by one member, as its Team Lead.
 * @param service - the Agent Teams service.
 * @param caller - exact live Lead Agent.
 * @param name - model-facing member name.
 * @returns the released task identities.
 */
async function releaseTasks(service, caller, name) {
	const released = [];
	for (const task of service.listTasks(caller)) {
		if (task.status !== 'in_progress' || task.ownerName !== name) continue;
		await service.updateTask(caller, {
			taskId: task.id,
			expectedRevision: task.revision,
			action: 'release',
		});
		released.push(task.id);
	}
	return released;
}

/**
 * Stop one removed member's runtime after its removal is durable.
 * @param ctx - plugin context carrying the subagent service.
 * @param service - the Agent Teams service.
 * @param root - exact live Lead Agent.
 * @param memberId - removed member Session identity.
 */
async function drainRuntime(ctx, service, root, memberId) {
	const timeoutMs = service.config?.disposalTimeoutMs ?? 5_000;
	let timer;
	try {
		await Promise.race([
			ctx.subagents.drainContinuableChildren(root, [memberId]),
			new Promise((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} catch (error) {
		ctx.logger?.warn(`agent-team-roster: draining the removed teammate runtime failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Delete one settled teammate as its Team Lead.
 * @param ctx - plugin context.
 * @param caller - exact live Agent used as the authority credential.
 * @param targetName - model-facing member name.
 * @returns the removed name, sampled status, released tasks, and dropped messages.
 */
export async function removeTeammate(ctx, caller, targetName) {
	const service = ctx.agentTeams;
	const membership = service.membership(caller);
	if (membership.role !== 'lead') throw new TeamError('only the Team Lead can delete teammates', 'TEAM_LEAD_REQUIRED');
	const root = membership.root;
	const name = targetName.trim();
	if (name === 'lead') throw new TeamError('the Team Lead cannot be deleted', 'TEAM_INVALID_TARGET');
	const state = service.journal.state(root);
	const member = state.members.find((candidate) => candidate.name === name);
	if (member === undefined) throw new TeamError(`teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND');
	if (member.phase === 'provisioning') throw new TeamError(`teammate "${name}" is still provisioning`, 'TEAM_MEMBER_BUSY');
	const live = ctx.agents.get(member.id);
	const previousStatus = availability(live);
	const discardedMessages = state.messages
		.filter((message) => message.targetId === member.id && !state.delivered.includes(message.id))
		.map((message) => message.id);
	if (live !== undefined) ctx.subagents.interrupt(member.id, { kind: 'ancestor', agent: caller });
	const releasedTasks = await releaseTasks(service, caller, name);
	await settleDelivery(service, member.id);
	await service.journal.transact(root.id, async () => {
		const current = service.journal.state(root);
		const row = current.members.find((candidate) => candidate.id === member.id);
		if (row === undefined) return;
		await service.journal.appendAndFlush(root, 'team/member', {
			version: 2,
			teamId: TeamId(root.id),
			member: {
				...row,
				phase: REMOVED_PHASE,
			},
		});
	});
	await drainRuntime(ctx, service, root, member.id);
	return {
		name: member.name,
		previousStatus,
		releasedTasks,
		discardedMessages,
	};
}

// ---------------------------------------------------------------------------
// Bulk cleanup
// ---------------------------------------------------------------------------

/**
 * Delete every teammate whose turn is not running, as the Team Lead.
 * @param ctx - plugin context.
 * @param caller - exact live Agent used as the authority credential.
 * @param skipped - collector for rows this pass leaves alone.
 * @returns the deleted names and the tasks released with them.
 */
async function cleanupTeammates(ctx, caller, skipped) {
	const service = ctx.agentTeams;
	const state = service.journal.state(service.membership(caller).root);
	const targets = [];
	for (const member of state.members) {
		if (member.phase === 'provisioning') {
			skipped.push({ kind: 'teammate', target: member.name, reason: 'still provisioning' });
			continue;
		}
		if (availability(ctx.agents.get(member.id)) === 'running') {
			skipped.push({ kind: 'teammate', target: member.name, reason: 'running' });
			continue;
		}
		targets.push(member.name);
	}
	const teammates = [];
	const releasedTasks = [];
	for (const target of targets) {
		try {
			const result = await removeTeammate(ctx, caller, target);
			teammates.push(result.name);
			releasedTasks.push(...result.releasedTasks);
		} catch (error) {
			if (error instanceof TeamError && (error.code === 'TEAM_MEMBER_NOT_FOUND' || error.code === 'TEAM_MEMBER_BUSY')) {
				skipped.push({ kind: 'teammate', target, reason: error.message });
				continue;
			}
			throw error;
		}
	}
	return { teammates, releasedTasks };
}

/**
 * Delete every completed shared task, as the Team Lead.
 * @param service - the Agent Teams service.
 * @param caller - exact live Lead Agent.
 * @param skipped - collector for rows this pass leaves alone.
 * @returns the deleted task identities.
 */
async function cleanupTasks(service, caller, skipped) {
	// listTasks reports numeric creation order, so reversing it deletes each
	// dependent before the task it is blocked by.
	const targets = newestFirst(service.listTasks(caller).filter((task) => task.status === 'completed'));
	const tasks = [];
	for (const target of targets) {
		try {
			await service.updateTask(caller, {
				taskId: target.id,
				expectedRevision: target.revision,
				action: 'delete',
			});
			tasks.push(target.id);
		} catch (error) {
			if (error instanceof TeamError) {
				skipped.push({ kind: 'task', target: target.id, reason: error.message });
				continue;
			}
			throw error;
		}
	}
	return tasks;
}

/**
 * Delete settled teammates and completed tasks in bulk as the Team Lead.
 * @param ctx - plugin context.
 * @param caller - exact live Agent used as the authority credential.
 * @param scope - `teammates`, `tasks`, or `all`.
 * @returns the deleted rows, the tasks released with deleted owners, and the
 * rows this call left alone with the reason.
 */
export async function cleanupTeam(ctx, caller, scope) {
	if (!CLEANUP_SCOPES.includes(scope)) throw new TeamError(`cleanup scope must be one of ${CLEANUP_SCOPES.map((value) => `"${value}"`).join(', ')}`, 'TEAM_INVALID_ARGUMENT');
	const service = ctx.agentTeams;
	const membership = service.membership(caller);
	if (membership.role !== 'lead') throw new TeamError('only the Team Lead can clean up the Team', 'TEAM_LEAD_REQUIRED');
	const skipped = [];
	const teammates = scope === 'tasks' ? { teammates: [], releasedTasks: [] } : await cleanupTeammates(ctx, caller, skipped);
	const tasks = scope === 'teammates' ? [] : await cleanupTasks(service, caller, skipped);
	return {
		scope,
		teammates: teammates.teammates,
		tasks,
		releasedTasks: teammates.releasedTasks,
		skipped,
	};
}

// ---------------------------------------------------------------------------
// Plugin wiring
// ---------------------------------------------------------------------------

/**
 * Declare one canonical tool output as compact model-facing JSON.
 * @param schema - canonical value schema for the tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput(schema) {
	return {
		schema,
		render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
	};
}

/**
 * Register both roster tools and the grounding rule in one exact Agent scope.
 * @param ctx - plugin context.
 * @param agent - exact live Team member.
 * @returns the disposer for every registration.
 */
function installAgentScope(ctx, agent) {
	const scoped = agent.ctx;
	const disposers = [];
	const register = (disposer) => {
		disposers.push(disposer);
	};
	try {
		register(scoped.systemPrompt.section({
			name: 'team:grounding',
			order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
			text: POLICY,
		}));
		register(scoped.tools.register(defineTool({
			name: 'rename_teammate',
			description: 'Rename one settled teammate without recreating it: its history, session, tasks, and pending mail are kept, and the new name becomes its address. The teammate is not notified; send it a message if it must use the new name. Only the Team Lead may call this tool.',
			parameters: {
				target: {
					type: 'string',
					required: true,
					description: 'Current teammate target returned by spawn_teammate or list_agents.',
				},
				new_name: {
					type: 'string',
					required: true,
					description: 'New lower-kebab-case name, at most 64 characters, not "lead", and not already used by another member.',
				},
			},
			output: jsonOutput(RENAME_VALUE_SCHEMA),
			async execute(args, exec) {
				if (exec.agent === undefined) throw new Error('rename_teammate requires a calling Agent');
				return await renameTeammate(ctx, exec.agent, args.target, args.new_name);
			},
		})));
		register(scoped.tools.register(defineTool({
			name: 'delete_teammate',
			description: 'Delete one settled teammate: stop its current turn, release its runtime, release its unfinished shared tasks, drop its undelivered inbox, and free its name. Durable history and its session log are kept. inactive members and failed creations can be deleted too. Only the Team Lead may call this tool.',
			parameters: {
				target: {
					type: 'string',
					required: true,
					description: 'Teammate target returned by spawn_teammate or list_agents.',
				},
			},
			output: jsonOutput(DELETE_VALUE_SCHEMA),
			async execute(args, exec) {
				if (exec.agent === undefined) throw new Error('delete_teammate requires a calling Agent');
				return await removeTeammate(ctx, exec.agent, args.target);
			},
		})));
		register(scoped.tools.register(defineTool({
			name: 'cleanup_team',
			description: 'Clean up the Team in bulk: delete every teammate whose turn is not running exactly as delete_teammate deletes one, and delete every completed shared task exactly as team_task_update deletes one. Running teammates, teammates still provisioning, unfinished tasks, and tasks that still block another task are left alone and reported. Only the Team Lead may call this tool.',
			parameters: {
				scope: {
					type: 'string',
					required: true,
					enum: CLEANUP_SCOPES,
					description: '"teammates" deletes every teammate whose turn is not running, "tasks" deletes every completed shared task, and "all" does both. For one exact target use delete_teammate or team_task_update instead.',
				},
			},
			output: jsonOutput(CLEANUP_VALUE_SCHEMA),
			async execute(args, exec) {
				if (exec.agent === undefined) throw new Error('cleanup_team requires a calling Agent');
				return await cleanupTeam(ctx, exec.agent, args.scope);
			},
		})));
	} catch (error) {
		// A half-installed scope would leak a section or tool that blocks the next
		// activation of this name, so undo what succeeded before rethrowing.
		for (const dispose of disposers.reverse()) dispose();
		throw error;
	}
	return () => {
		for (const dispose of disposers.reverse()) dispose();
	};
}

/**
 * Install the plugin.
 * @param ctx - plugin context carrying every injected service.
 */
export function apply(ctx) {
	let uninstallFold;
	let uninstallOrder;
	const installed = new Map();
	const disposeInstalled = () => {
		for (const dispose of installed.values()) dispose();
		installed.clear();
	};
	const maybeInstall = (agent) => {
		if (installed.has(agent)) return;
		if (ctx.agentTeams.tryMembership(agent) === undefined) return;
		installed.set(agent, installAgentScope(ctx, agent));
	};
	try {
		uninstallFold = installRosterFold(ctx.sessionProjections);
		uninstallOrder = installDisplayOrder(ctx.sessionProjections, ctx);
		ctx.effect(() => uninstallFold, 'agent-team-roster.fold()');
		ctx.effect(() => uninstallOrder, 'agent-team-roster.order()');
		for (const agent of ctx.agents.list()) maybeInstall(agent);
		ctx.on('agent/created', ({ agent }) => maybeInstall(agent));
		ctx.on('agent/disposed', ({ agent }) => {
			installed.get(agent)?.();
			installed.delete(agent);
		});
		ctx.effect(() => disposeInstalled, 'agent-team-roster.tools()');
	} catch (error) {
		// Leave no wrapped view, wrapped fold, or half-installed scope behind for the retry.
		uninstallOrder?.();
		uninstallFold?.();
		disposeInstalled();
		throw error;
	}
}
