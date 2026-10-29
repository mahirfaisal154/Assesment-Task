import Junction from "../models/junction.model.js"
import AuditLog from "../models/auditLog.model.js"
import ProcessedEvent from "../models/processedEvent.model.js"
import ControllerCommand from "../models/controllerCommand.model.js"
import { httpError } from "../lib/utils.js"

// Persistence port implemented with Mongoose. The service only knows these method names,
// so swapping to Postgres/SQLite means writing another file with the same functions.

const STATE_FIELDS = [
    "junctionId", "name", "config", "mode", "stage", "phase", "targetPhase", "lastGreenPhase",
    "stageStartedAt", "stageConfirmedAt", "desiredSignals", "actualSignals", "controllerStatus", "devices",
    "queues", "lastSequence", "clearedVehicles", "phaseLastServedAt", "emergency", "manual", "failure",
    "pendingCommand", "lastCommandResult", "recentCommandIds", "commandSeq", "version", "createdAt",
]

const toState = (doc) => Object.fromEntries(STATE_FIELDS.map(k => [k, doc[k] ?? null]))

export const createMongoRepository = () => ({
    loadAllJunctions: async () => {
        const docs = await Junction.find().sort({ junctionId: 1 }).lean()
        return docs.map(toState)
    },

    createJunction: async (state) => {
        try {
            await Junction.create(toState(state))
        } catch (error) {
            if (error.code === 11000) throw httpError(409, `Junction ${state.junctionId} already exists`)
            throw error
        }
    },

    // optimistic concurrency: only write if nobody else wrote since we loaded
    saveJunctionState: async (state, expectedVersion) => {
        const { junctionId, ...rest } = toState(state)
        const updated = await Junction.findOneAndUpdate(
            { junctionId, version: expectedVersion },
            { $set: rest },
            { new: true, projection: { _id: 1 } }
        )
        if (!updated) throw new Error(`Concurrent modification of junction ${junctionId} (expected version ${expectedVersion})`)
    },

    findProcessedEvent: async (eventId) => ProcessedEvent.findOne({ eventId }).lean(),

    markEventProcessed: async (record) => {
        try {
            await ProcessedEvent.create(record)
        } catch (error) {
            if (error.code !== 11000) throw error // already recorded = fine
        }
    },

    addAuditEntries: async (entries) => {
        if (entries.length) await AuditLog.insertMany(entries, { ordered: true })
    },

    getHistory: async (junctionId, { limit = 100, eventType, before } = {}) => {
        const query = { junctionId }
        if (eventType) query.eventType = { $in: eventType.split(",") }
        if (before) query.timestamp = { $lt: new Date(before) }
        return AuditLog.find(query).sort({ timestamp: -1, _id: -1 }).limit(limit).lean()
    },

    saveCommand: async (command) => {
        await ControllerCommand.findOneAndUpdate(
            { commandId: command.commandId },
            {
                $set: { attempts: command.attempt, lastSentAt: new Date() },
                $setOnInsert: { junctionId: command.junctionId, signals: command.signals, purpose: command.purpose, status: "PENDING" },
            },
            { upsert: true }
        )
    },

    updateCommandStatus: async (commandId, status) => {
        await ControllerCommand.updateOne({ commandId }, { $set: { status, resolvedAt: new Date() } })
    },

    getRecentCommands: async (junctionId, limit = 20) =>
        ControllerCommand.find({ junctionId }).sort({ createdAt: -1 }).limit(limit).lean(),
})
