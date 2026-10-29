import {
    createJunctionState, recoverAfterRestart, tick, applySensorEvent, applyCommand,
    applyControllerEvent, applyDeviceStatus, toStatusView,
} from "../domain/junctionEngine.js"
import { buildJunctionConfig } from "../domain/junctionConfig.js"
import { AUDIT } from "../domain/constants.js"
import { createKeyedMutex } from "../lib/keyedMutex.js"
import { httpError, hashPayload, log } from "../lib/utils.js"
import {
    validateSensorEvent, validateDeviceEvent, validateControllerEvent, validateCommand, validateNewJunction,
} from "../lib/validators.js"

// Application layer. Glue between the outside world (REST / MQTT / timers) and the pure domain engine.
//
// For every input:
//   1. validate shape
//   2. take the per-junction lock (serialized processing)
//   3. run the pure domain function -> {state, effects, result}
//   4. persist new state (optimistic version check)        <- persist BEFORE sending anything
//   5. run effects: write audit, update command records, send commands through the controller port
//   6. push the new status to dashboards

export const toAuditView = (e) => ({
    junction_id: e.junctionId,
    event_type: e.eventType,
    direction: e.direction ?? null,
    vehicle_id: e.vehicleId ?? null,
    event_id: e.eventId ?? null,
    command_id: e.commandId ?? null,
    previous_state: e.previousState ?? null,
    new_state: e.newState ?? null,
    message: e.message ?? null,
    details: e.details ?? null,
    timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : e.timestamp,
})

export const createTrafficService = ({
    repository,
    controllerPort,
    clock = () => Date.now(),
    onStatusChange = () => { },
    onAudit = () => { },
    defaultJunctions = [{ junctionId: "A", name: "Junction A" }],
}) => {
    const states = new Map() // junctionId -> current state (cache of what is persisted)
    const mutex = createKeyedMutex()
    let ticker = null

    const getStateOrThrow = (junctionId) => {
        const state = states.get(junctionId)
        if (!state) throw httpError(404, `Junction ${junctionId} not found`)
        return state
    }

    const writeAudit = async (junctionId, entries) => {
        if (!entries.length) return
        const rows = entries.map(entry => ({ junctionId, timestamp: new Date(clock()), ...entry }))
        await repository.addAuditEntries(rows)
        rows.forEach(row => {
            log("INFO", `[${junctionId}] ${row.eventType}${row.direction ? " " + row.direction : ""}${row.message ? " - " + row.message : ""}`)
            onAudit(toAuditView(row))
        })
    }

    const runEffects = async (junctionId, effects) => {
        await writeAudit(junctionId, effects.filter(e => e.type === "AUDIT").map(e => e.entry))
        for (const e of effects) {
            if (e.type === "COMMAND_STATUS") await repository.updateCommandStatus(e.commandId, e.status)
        }
        for (const e of effects) {
            if (e.type !== "SEND_COMMAND") continue
            await repository.saveCommand(e.command)
            try {
                await controllerPort.sendCommand(e.command)
            } catch (error) {
                // transport failure: we simply never get an ACK -> the engine's timeout/retry handles it
                log("ERROR", `Could not deliver ${e.command.commandId}`, error.message)
            }
        }
    }

    // persist + effects + notify. MUST be called while holding the junction lock
    const commit = async (junctionId, prev, out) => {
        const { state, effects } = out
        let current = prev
        if (JSON.stringify(state) !== JSON.stringify(prev)) {
            state.version = prev.version + 1
            await repository.saveJunctionState(state, prev.version)
            states.set(junctionId, state)
            current = state
        }
        await runEffects(junctionId, effects)
        if (current !== prev) onStatusChange(junctionId, toStatusView(current, clock()))
        return current
    }

    const withJunction = (junctionId, fn) =>
        mutex.runExclusive(junctionId, async () => fn(getStateOrThrow(junctionId), clock()))

    const recordRejection = async (junctionId, entry) => {
        const id = typeof junctionId === "string" && junctionId.trim() ? junctionId.trim().slice(0, 64) : "UNKNOWN"
        await writeAudit(id, [entry])
    }

    // ---------------------------------------------------------------- lifecycle

    const tickAll = () => Promise.all([...states.keys()].map(id => {
        if (mutex.isBusy(id)) return null // something is already running for this junction, it will step anyway
        return withJunction(id, async (prev, now) => commit(id, prev, tick(prev, now)))
            .catch(error => log("ERROR", `Tick failed for junction ${id}`, error.message))
    }))

    const init = async ({ tickMs = 500 } = {}) => {
        controllerPort.onEvent(raw => {
            handleControllerEvent(raw).catch(error => log("WARN", "Controller event rejected", error.message))
        })
        const saved = await repository.loadAllJunctions()
        for (const state of saved) {
            states.set(state.junctionId, state)
            await withJunction(state.junctionId, async (prev, now) => commit(state.junctionId, prev, recoverAfterRestart(prev, now)))
            log("INFO", `Recovered junction ${state.junctionId} (mode ${state.mode}, stage ${state.stage}, version ${state.version})`)
        }
        if (!saved.length) {
            for (const j of defaultJunctions) await createJunction({ junction_id: j.junctionId, name: j.name })
        }
        if (tickMs > 0) ticker = setInterval(tickAll, tickMs)
    }

    const stop = () => {
        if (ticker) clearInterval(ticker)
        ticker = null
    }

    // ---------------------------------------------------------------- junctions

    const createJunction = async (body) => {
        const { errors, value } = validateNewJunction(body)
        if (errors.length) throw httpError(400, "Invalid junction", errors)
        const built = buildJunctionConfig(value.configInput)
        if (built.errors.length) throw httpError(400, "Invalid junction configuration", built.errors)
        if (states.has(value.junctionId)) throw httpError(409, `Junction ${value.junctionId} already exists`)

        const state = createJunctionState(value.junctionId, value.name, built.config, clock())
        await repository.createJunction(state)
        states.set(value.junctionId, state)
        await writeAudit(value.junctionId, [{ eventType: AUDIT.JUNCTION_CREATED, message: value.name, details: { phases: built.config.phases } }])
        // first tick sends the initial ALL RED sync command
        await withJunction(value.junctionId, async (prev, now) => commit(value.junctionId, prev, tick(prev, now)))
        return toStatusView(states.get(value.junctionId), clock())
    }

    const listJunctions = () => [...states.values()].map(s => toStatusView(s, clock()))

    const getStatus = (junctionId) => toStatusView(getStateOrThrow(junctionId), clock())

    const getJunction = (junctionId) => {
        const s = getStateOrThrow(junctionId)
        return { junction_id: s.junctionId, name: s.name, config: s.config, status: toStatusView(s, clock()) }
    }

    const getHistory = async (junctionId, query = {}) => {
        getStateOrThrow(junctionId)
        const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 500)
        const rows = await repository.getHistory(junctionId, { limit, eventType: query.type, before: query.before })
        return rows.map(toAuditView)
    }

    const getCommands = async (junctionId) => {
        getStateOrThrow(junctionId)
        return repository.getRecentCommands(junctionId, 20)
    }

    // ---------------------------------------------------------------- inputs

    // idempotent event handling shared by sensor + device events
    const processDeduplicated = async (kind, value, applyFn) => {
        const hash = hashPayload(value)
        return withJunction(value.junctionId, async (prev, now) => {
            const existing = await repository.findProcessedEvent(value.eventId)
            if (existing) {
                if (existing.payloadHash !== hash) {
                    await writeAudit(value.junctionId, [{ eventType: AUDIT.SENSOR_EVENT_REJECTED, eventId: value.eventId, message: "event_id reused with a different payload" }])
                    throw httpError(409, `event_id ${value.eventId} was already used for a different event`)
                }
                await writeAudit(value.junctionId, [{ eventType: AUDIT.SENSOR_EVENT_DUPLICATE, eventId: value.eventId, direction: value.direction, vehicleId: value.vehicleId, message: `Duplicate ${kind.toLowerCase()} event ignored` }])
                return { status: "DUPLICATE", event_id: value.eventId, original_result: existing.result }
            }
            const out = applyFn(prev, value, now)
            await commit(value.junctionId, prev, out)
            if (out.result.status === "REJECTED") throw httpError(out.result.code, out.result.message)
            await repository.markEventProcessed({ eventId: value.eventId, junctionId: value.junctionId, kind, payloadHash: hash, result: out.result.status })
            return { ...out.result, event_id: value.eventId }
        })
    }

    const handleSensorEvent = async (body) => {
        const { errors, value } = validateSensorEvent(body, clock())
        if (errors.length) {
            await recordRejection(body?.junction_id, { eventType: AUDIT.SENSOR_EVENT_REJECTED, eventId: typeof body?.event_id === "string" ? body.event_id : undefined, message: errors.join("; ") })
            throw httpError(400, "Invalid sensor event", errors)
        }
        if (!states.has(value.junctionId)) {
            await recordRejection(value.junctionId, { eventType: AUDIT.SENSOR_EVENT_REJECTED, eventId: value.eventId, message: "Unknown junction" })
            throw httpError(404, `Junction ${value.junctionId} not found`)
        }
        const result = await processDeduplicated("SENSOR", value, applySensorEvent)
        return { ...result, queues: getStatus(value.junctionId).queues }
    }

    const handleDeviceEvent = async (body) => {
        const { errors, value } = validateDeviceEvent(body, clock())
        if (errors.length) throw httpError(400, "Invalid device status event", errors)
        if (!states.has(value.junctionId)) throw httpError(404, `Junction ${value.junctionId} not found`)
        return processDeduplicated("DEVICE", value, applyDeviceStatus)
    }

    const handleControllerEvent = async (body) => {
        const { errors, value } = validateControllerEvent(body)
        if (errors.length) throw httpError(400, "Invalid controller event", errors)
        getStateOrThrow(value.junctionId)
        return withJunction(value.junctionId, async (prev, now) => {
            const out = applyControllerEvent(prev, value, now)
            await commit(value.junctionId, prev, out)
            return { ...out.result, command_id: value.commandId }
        })
    }

    const executeCommand = async (junctionId, body) => {
        getStateOrThrow(junctionId)
        const { errors, value } = validateCommand(body)
        if (errors.length) {
            await writeAudit(junctionId, [{ eventType: AUDIT.COMMAND_REJECTED, message: errors.join("; ") }])
            throw httpError(400, "Invalid command", errors)
        }
        return withJunction(junctionId, async (prev, now) => {
            const out = applyCommand(prev, value, now)
            await commit(junctionId, prev, out)
            if (out.result.status === "REJECTED") throw httpError(out.result.code, out.result.message)
            return { ...out.result, junction: toStatusView(states.get(junctionId), clock()) }
        })
    }

    return {
        init, stop, tickAll,
        createJunction, listJunctions, getJunction, getStatus, getHistory, getCommands,
        handleSensorEvent, handleDeviceEvent, handleControllerEvent, executeCommand,
    }
}
