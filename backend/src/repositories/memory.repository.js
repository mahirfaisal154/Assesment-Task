import { httpError } from "../lib/utils.js"

// Same interface as mongo.repository.js but in memory. Used by tests (no database needed)
// and handy for running the engine without Mongo.

export const createMemoryRepository = () => {
    const junctions = new Map()
    const processed = new Map()
    const audit = []
    const commands = new Map()

    return {
        // test helpers
        _audit: audit,
        _commands: commands,
        _junctions: junctions,

        loadAllJunctions: async () => [...junctions.values()].map(s => structuredClone(s)),

        createJunction: async (state) => {
            if (junctions.has(state.junctionId)) throw httpError(409, `Junction ${state.junctionId} already exists`)
            junctions.set(state.junctionId, structuredClone(state))
        },

        saveJunctionState: async (state, expectedVersion) => {
            const current = junctions.get(state.junctionId)
            if (!current || current.version !== expectedVersion) {
                throw new Error(`Concurrent modification of junction ${state.junctionId}`)
            }
            junctions.set(state.junctionId, structuredClone(state))
        },

        findProcessedEvent: async (eventId) => processed.get(eventId) || null,

        markEventProcessed: async (record) => {
            if (!processed.has(record.eventId)) processed.set(record.eventId, { ...record })
        },

        addAuditEntries: async (entries) => {
            audit.push(...entries)
        },

        getHistory: async (junctionId, { limit = 100, eventType } = {}) => {
            const types = eventType ? eventType.split(",") : null
            return audit
                .filter(e => e.junctionId === junctionId && (!types || types.includes(e.eventType)))
                .slice(-limit)
                .reverse()
        },

        saveCommand: async (command) => {
            const existing = commands.get(command.commandId)
            commands.set(command.commandId, { ...(existing || { ...command, status: "PENDING" }), attempts: command.attempt })
        },

        updateCommandStatus: async (commandId, status) => {
            const c = commands.get(commandId)
            if (c) c.status = status
        },

        getRecentCommands: async (junctionId, limit = 20) =>
            [...commands.values()].filter(c => c.junctionId === junctionId).slice(-limit).reverse(),
    }
}
