// Traffic domain engine for ONE junction.
//
// Every public function is pure:   (state, input, now) -> { state, effects, result }
//   - state   : new junction state (input state is never mutated)
//   - effects : things the application layer must do afterwards
//               { type: "AUDIT", entry }                    -> write history
//               { type: "SEND_COMMAND", command }           -> send to physical controller (via port)
//               { type: "COMMAND_STATUS", commandId, status } -> update command record
//   - result  : answer for the caller (accepted / ignored / rejected + reason)
//
// No HTTP, no database, no MQTT, no timers in here. Time is passed in as `now` (ms) so it is testable.
//
// Signal cycle:   GREEN(phase) -> YELLOW(phase) -> ALL_RED -> GREEN(next phase)
// The engine never moves to the next stage until the controller has ACKed the current one,
// and never commands GREEN unless every conflicting direction is CONFIRMED red.

import { SIGNAL, STAGE, MODE, AUDIT } from "./constants.js"
import {
    phaseOf, allRed, allUnknown, signalsForPhase, assertSafeSignals,
    conflictingDirectionsConfirmedRed, findConflict, mapDirections, signalsEqual,
} from "./safety.js"
import { decideWhileGreen, pickBestPhase, allPhaseScores } from "./scheduler.js"

const MAX_TOMBSTONES = 200
const MAX_RECENT_COMMANDS = 20

const clone = (s) => structuredClone(s)

const audit = (fx, eventType, data = {}) => fx.push({ type: "AUDIT", entry: { eventType, ...data } })

const ok = (state, effects, result = { status: "APPLIED" }) => ({ state, effects, result })

const reject = (state, effects, code, message) => ({ state, effects, result: { status: "REJECTED", code, message } })

// ---------------------------------------------------------------------------
// state creation / recovery
// ---------------------------------------------------------------------------

export const createJunctionState = (junctionId, name, config, now) => ({
    junctionId,
    name: name || `Junction ${junctionId}`,
    config,
    mode: MODE.AUTOMATIC,
    stage: STAGE.ALL_RED,
    phase: null,                 // phase shown GREEN/YELLOW (null during ALL_RED)
    targetPhase: null,           // phase we are moving to
    lastGreenPhase: null,
    stageStartedAt: now,
    stageConfirmedAt: null,      // when controller confirmed the current stage (stage timers count from here)
    desiredSignals: allRed(config),
    actualSignals: allUnknown(config),
    controllerStatus: "UNKNOWN",
    devices: {
        signals: mapDirections(config, () => "ONLINE"),
        sensors: mapDirections(config, () => "ONLINE"),
        lastStatusAt: {},
    },
    queues: mapDirections(config, () => []),
    lastSequence: mapDirections(config, () => null),
    clearedVehicles: [],         // tombstones for out-of-order ARRIVED-after-CLEARED detection
    phaseLastServedAt: Object.fromEntries(config.phases.map(p => [p.name, now])),
    emergency: { requests: [] },
    manual: null,
    failure: null,
    pendingCommand: null,
    lastCommandResult: null,
    recentCommandIds: [],
    commandSeq: 0,
    version: 0,
    createdAt: now,
})

// Called once after the backend restarts with persisted state.
// We NEVER trust the previously requested physical state: actual becomes UNKNOWN,
// any pending command is abandoned, and the junction is walked through a safe clearance.
export const recoverAfterRestart = (prevState, now) => {
    const s = clone(prevState)
    const fx = []
    const p = s.pendingCommand

    audit(fx, AUDIT.SYSTEM_RECOVERY, {
        details: { stage: s.stage, phase: s.phase, mode: s.mode, pendingCommandId: p?.commandId ?? null },
        message: "Backend restarted: physical state treated as UNKNOWN, re-running safe clearance",
    })
    if (p) {
        fx.push({ type: "COMMAND_STATUS", commandId: p.commandId, status: "ABANDONED" })
        audit(fx, AUDIT.COMMAND_ABANDONED, { commandId: p.commandId, message: "Pending at restart, ACK no longer expected" })
    }
    s.pendingCommand = null
    s.actualSignals = allUnknown(s.config)
    s.controllerStatus = "UNKNOWN"

    expireRequests(s, now, fx)
    syncMode(s, fx)

    if (s.mode === MODE.FAILURE) {
        s.failure.nextAttemptAt = now
        ensureFailSafe(s, now, fx)
    } else if ((s.stage === STAGE.GREEN || s.stage === STAGE.YELLOW) && s.phase) {
        // directions may physically still be GREEN -> give them a YELLOW before ALL RED
        beginStage(s, STAGE.YELLOW, s.phase, s.targetPhase, now, fx, "RESTART_RECOVERY")
    } else {
        beginStage(s, STAGE.ALL_RED, null, s.targetPhase, now, fx, "RESTART_RECOVERY")
    }
    return ok(s, fx)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const activeEmergency = (s) =>
    [...s.emergency.requests].sort((a, b) => a.detectedAt - b.detectedAt)[0] || null

const findQueuedVehicle = (s, vehicleId) => {
    for (const dir of s.config.directions) {
        const idx = s.queues[dir].findIndex(v => v.vehicleId === vehicleId)
        if (idx !== -1) return { dir, idx, vehicle: s.queues[dir][idx] }
    }
    return null
}

const issueCommand = (s, signals, purpose, now, fx, timeoutMs) => {
    assertSafeSignals(s.config, signals)
    s.commandSeq += 1
    const commandId = `cmd-${s.junctionId}-${String(s.commandSeq).padStart(6, "0")}`
    s.pendingCommand = {
        commandId,
        signals,
        purpose,
        stage: s.stage,
        phase: s.phase,
        attempt: 1,
        sentAt: now,
        deadline: now + (timeoutMs ?? s.config.timings.ackTimeoutMs),
    }
    s.desiredSignals = signals
    fx.push({ type: "SEND_COMMAND", command: { commandId, junctionId: s.junctionId, signals, purpose, attempt: 1 } })
    audit(fx, AUDIT.SIGNAL_REQUESTED, { commandId, details: { signals, purpose } })
}

const beginStage = (s, stage, phase, targetPhase, now, fx, reason) => {
    const previous = { stage: s.stage, phase: s.phase }
    s.stage = stage
    s.phase = stage === STAGE.ALL_RED ? null : phase
    s.targetPhase = targetPhase ?? null
    s.stageStartedAt = now
    s.stageConfirmedAt = null

    let signals
    if (stage === STAGE.GREEN) {
        signals = signalsForPhase(s.config, phase, SIGNAL.GREEN)
        s.lastGreenPhase = phase
        s.phaseLastServedAt[phase] = now
    } else if (stage === STAGE.YELLOW) {
        signals = signalsForPhase(s.config, phase, SIGNAL.YELLOW)
        s.phaseLastServedAt[phase] = now
    } else {
        signals = allRed(s.config)
    }
    audit(fx, AUDIT.STAGE_CHANGED, {
        previousState: previous.stage + (previous.phase ? `(${previous.phase})` : ""),
        newState: stage + (s.phase ? `(${s.phase})` : ""),
        details: { reason, targetPhase: s.targetPhase },
    })
    issueCommand(s, signals, `${stage}${s.phase ? ":" + s.phase : ""}`, now, fx)
}

const enterFailure = (s, reason, now, fx, details = {}) => {
    if (!s.failure) {
        s.failure = { reason, since: now, details, nextAttemptAt: now }
        audit(fx, AUDIT.FAILURE_DETECTED, { message: reason, details })
    } else {
        audit(fx, AUDIT.FAILURE_DETECTED, { message: `${reason} (already in FAILURE: ${s.failure.reason})`, details })
    }
    // drop a normal pending command - only the fail-safe command matters now
    const p = s.pendingCommand
    if (p && p.purpose !== "FAILSAFE_ALL_RED") {
        fx.push({ type: "COMMAND_STATUS", commandId: p.commandId, status: "SUPERSEDED" })
        s.pendingCommand = null
    }
}

// in FAILURE the only goal is a confirmed ALL RED
const ensureFailSafe = (s, now, fx) => {
    const red = allRed(s.config)
    const confirmed = s.stage === STAGE.ALL_RED && signalsEqual(s.config, s.actualSignals, red) && signalsEqual(s.config, s.desiredSignals, red)
    if (confirmed) return
    if (now < (s.failure.nextAttemptAt ?? 0)) return
    s.stage = STAGE.ALL_RED
    s.phase = null
    s.targetPhase = null
    s.stageStartedAt = now
    s.stageConfirmedAt = null
    issueCommand(s, red, "FAILSAFE_ALL_RED", now, fx, s.config.timings.failsafeRetryMs)
}

const expireRequests = (s, now, fx) => {
    const expired = s.emergency.requests.filter(r => r.expiresAt <= now)
    if (expired.length) {
        s.emergency.requests = s.emergency.requests.filter(r => r.expiresAt > now)
        expired.forEach(r => audit(fx, AUDIT.EMERGENCY_TIMEOUT, {
            direction: r.direction, vehicleId: r.vehicleId,
            message: "Emergency request expired without a VEHICLE_CLEARED event",
        }))
    }
    if (s.manual && s.manual.expiresAt <= now) {
        audit(fx, AUDIT.MANUAL_EXPIRED, { direction: s.manual.direction, details: { operator: s.manual.operator } })
        s.manual = null
    }
}

// explicit priority: FAILURE > EMERGENCY > MANUAL > AUTOMATIC
const syncMode = (s, fx) => {
    const next = s.failure ? MODE.FAILURE
        : s.emergency.requests.length ? MODE.EMERGENCY
            : s.manual ? MODE.MANUAL
                : MODE.AUTOMATIC
    if (next !== s.mode) {
        audit(fx, AUDIT.MODE_CHANGED, { previousState: s.mode, newState: next })
        s.mode = next
    }
}

const handlePendingTimeout = (s, now, fx) => {
    const p = s.pendingCommand
    if (!p || now < p.deadline) return
    // fail-safe ALL RED is retried forever while in FAILURE (it is the only safe thing left to do)
    const isFailsafe = p.purpose === "FAILSAFE_ALL_RED" && !!s.failure
    const { maxCommandRetries, ackTimeoutMs, failsafeRetryMs } = s.config.timings

    if (isFailsafe || p.attempt <= maxCommandRetries) {
        p.attempt += 1
        p.sentAt = now
        p.deadline = now + (isFailsafe ? failsafeRetryMs : ackTimeoutMs)
        fx.push({ type: "SEND_COMMAND", command: { commandId: p.commandId, junctionId: s.junctionId, signals: p.signals, purpose: p.purpose, attempt: p.attempt } })
        audit(fx, AUDIT.COMMAND_RETRY, { commandId: p.commandId, details: { attempt: p.attempt } })
        return
    }
    audit(fx, AUDIT.CONTROLLER_TIMEOUT, { commandId: p.commandId, message: `No ACK after ${p.attempt} attempts` })
    fx.push({ type: "COMMAND_STATUS", commandId: p.commandId, status: "TIMEOUT" })
    s.lastCommandResult = { commandId: p.commandId, status: "TIMEOUT", at: now }
    s.pendingCommand = null
    s.actualSignals = allUnknown(s.config)
    if (s.controllerStatus === "ONLINE") s.controllerStatus = "UNKNOWN"
    enterFailure(s, "CONTROLLER_ACK_TIMEOUT", now, fx, { commandId: p.commandId })
}

const chooseWhileGreen = (s, now, elapsed) => {
    if (s.mode === MODE.EMERGENCY) return { target: activeEmergency(s).phase, reason: "EMERGENCY_PREEMPTION" }
    if (s.mode === MODE.MANUAL) return { target: s.manual.phase, reason: "MANUAL_OVERRIDE" }
    return decideWhileGreen(s, now, elapsed)
}

const chooseFromAllRed = (s, now) => {
    if (s.mode === MODE.EMERGENCY) return { target: activeEmergency(s).phase, reason: "EMERGENCY_PREEMPTION" }
    if (s.mode === MODE.MANUAL) return { target: s.manual.phase, reason: "MANUAL_OVERRIDE" }
    return pickBestPhase(s, now, s.targetPhase)
}

// The heart of the state machine. Called after every input and on every tick.
const step = (s, now, fx) => {
    expireRequests(s, now, fx)
    handlePendingTimeout(s, now, fx)
    syncMode(s, fx)

    // wait for controller confirmation before ANY further progression
    if (s.pendingCommand) return
    if (s.mode === MODE.FAILURE) return ensureFailSafe(s, now, fx)

    // stage never confirmed (e.g. after failure reset) -> resync with a confirmed ALL RED first
    if (s.stageConfirmedAt == null) {
        return beginStage(s, STAGE.ALL_RED, null, s.targetPhase, now, fx, "RESYNC")
    }
    const elapsed = now - s.stageConfirmedAt
    const { yellowMs, allRedMs } = s.config.timings

    if (s.stage === STAGE.GREEN) {
        const decision = chooseWhileGreen(s, now, elapsed)
        if (decision.target && decision.target !== s.phase) {
            audit(fx, AUDIT.TRANSITION_STARTED, {
                previousState: s.phase, newState: decision.target,
                message: `${s.phase} -> ${decision.target}`, details: { reason: decision.reason, greenElapsedMs: elapsed },
            })
            beginStage(s, STAGE.YELLOW, s.phase, decision.target, now, fx, decision.reason)
        }
        return
    }
    if (s.stage === STAGE.YELLOW) {
        if (elapsed >= yellowMs) beginStage(s, STAGE.ALL_RED, null, s.targetPhase, now, fx, "YELLOW_DONE")
        return
    }
    // ALL_RED
    if (elapsed < allRedMs) return
    const { target, reason } = chooseFromAllRed(s, now)
    if (!target) return
    if (!conflictingDirectionsConfirmedRed(s.config, s.actualSignals, target)) {
        audit(fx, AUDIT.SAFETY_HOLD, { message: `GREEN for ${target} withheld: conflicting directions not confirmed RED` })
        return beginStage(s, STAGE.ALL_RED, null, target, now, fx, "SAFETY_HOLD")
    }
    beginStage(s, STAGE.GREEN, target, null, now, fx, reason)
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

export const tick = (prevState, now) => {
    const s = clone(prevState)
    const fx = []
    step(s, now, fx)
    return ok(s, fx, { status: "TICK" })
}

const handleEmergencyArrival = (s, ev, now, fx) => {
    const { timings } = s.config
    if (now - ev.sensorTime > timings.emergencyStaleMs) {
        audit(fx, AUDIT.EMERGENCY_STALE_IGNORED, {
            direction: ev.direction, vehicleId: ev.vehicleId, eventId: ev.eventId,
            message: `Emergency event is ${Math.round((now - ev.sensorTime) / 1000)}s old - no preemption`,
        })
        return "STALE"
    }
    const existing = s.emergency.requests.find(r => r.vehicleId === ev.vehicleId)
    if (existing) {
        existing.expiresAt = now + timings.emergencyTimeoutMs
        audit(fx, AUDIT.EMERGENCY_REFRESHED, { direction: existing.direction, vehicleId: ev.vehicleId, eventId: ev.eventId })
        return "REFRESHED"
    }
    const phase = phaseOf(s.config, ev.direction)
    const current = activeEmergency(s)
    s.emergency.requests.push({
        vehicleId: ev.vehicleId, direction: ev.direction, phase, eventId: ev.eventId,
        detectedAt: now, expiresAt: now + timings.emergencyTimeoutMs,
    })
    audit(fx, AUDIT.EMERGENCY_DETECTED, {
        direction: ev.direction, vehicleId: ev.vehicleId, eventId: ev.eventId,
        message: current && current.phase !== phase
            ? `Queued behind active emergency on ${current.phase} (first come, first served)`
            : `Preempting for ${phase}`,
        details: { phase, queuePosition: s.emergency.requests.length },
    })
    if (s.failure) {
        audit(fx, AUDIT.EMERGENCY_DETECTED, {
            direction: ev.direction, vehicleId: ev.vehicleId,
            message: "Junction in FAILURE: cannot preempt safely, signals stay ALL RED - direct traffic manually",
        })
    }
    return "DETECTED"
}

// ev = normalized sensor event {eventId, direction, eventType, vehicleId, vehicleType, sequenceNo, sensorTime}
export const applySensorEvent = (prevState, ev, now) => {
    const s = clone(prevState)
    const fx = []
    const base = { direction: ev.direction, vehicleId: ev.vehicleId, eventId: ev.eventId }

    if (!s.config.directions.includes(ev.direction)) {
        audit(fx, AUDIT.SENSOR_EVENT_REJECTED, { ...base, message: `Unknown direction ${ev.direction} for this junction` })
        return reject(prevState, fx, 400, `Unknown direction ${ev.direction} for junction ${s.junctionId}`)
    }

    const flags = {
        delayed: now - ev.sensorTime > s.config.timings.delayedEventMs,
        outOfOrder: false,
    }
    const last = s.lastSequence[ev.direction]
    if (ev.sequenceNo != null) {
        if (last != null && ev.sequenceNo <= last) flags.outOfOrder = true
        else s.lastSequence[ev.direction] = ev.sequenceNo
    }

    let result = { status: "APPLIED", flags }

    if (ev.eventType === "VEHICLE_ARRIVED") {
        const tombIdx = s.clearedVehicles.findIndex(c => c.vehicleId === ev.vehicleId)
        const tomb = tombIdx === -1 ? null : s.clearedVehicles[tombIdx]
        const arrivedBeforeClear = tomb && (
            (ev.sequenceNo != null && tomb.sequenceNo != null && tomb.direction === ev.direction)
                ? ev.sequenceNo < tomb.sequenceNo
                : ev.sensorTime < tomb.sensorTime
        )
        if (arrivedBeforeClear) {
            audit(fx, AUDIT.SENSOR_EVENT_IGNORED, { ...base, message: "Out-of-order ARRIVED: vehicle was already cleared", details: flags })
            step(s, now, fx)
            return ok(s, fx, { status: "IGNORED", reason: "ARRIVAL_OLDER_THAN_CLEARANCE", flags })
        }
        if (tomb) s.clearedVehicles.splice(tombIdx, 1) // a real new arrival of the same vehicle

        const found = findQueuedVehicle(s, ev.vehicleId)
        if (found && found.dir === ev.direction) {
            // same vehicle already waiting here -> queue must not grow
            const em = found.vehicle.vehicleType === "EMERGENCY" ? handleEmergencyArrival(s, ev, now, fx) : null
            if (!em) audit(fx, AUDIT.SENSOR_EVENT_IGNORED, { ...base, message: "Vehicle already queued in this direction" })
            step(s, now, fx)
            return ok(s, fx, { status: em === "REFRESHED" ? "APPLIED" : "IGNORED", reason: "VEHICLE_ALREADY_QUEUED", flags })
        }
        if (found) {
            s.queues[found.dir].splice(found.idx, 1)
            audit(fx, AUDIT.VEHICLE_MOVED, { ...base, message: `Vehicle moved from ${found.dir} to ${ev.direction}` })
        }
        s.queues[ev.direction].push({
            vehicleId: ev.vehicleId,
            vehicleType: ev.vehicleType,
            eventId: ev.eventId,
            sequenceNo: ev.sequenceNo,
            arrivedAt: now,               // server time is authoritative for waiting time
            sensorTime: ev.sensorTime,
        })
        audit(fx, AUDIT.VEHICLE_DETECTED, {
            ...base, details: { vehicleType: ev.vehicleType, queueLength: s.queues[ev.direction].length, ...flags },
        })
        if (ev.vehicleType === "EMERGENCY") result.emergency = handleEmergencyArrival(s, ev, now, fx)
    } else {
        // VEHICLE_CLEARED
        let found = findQueuedVehicle(s, ev.vehicleId)
        if (found) {
            s.queues[found.dir].splice(found.idx, 1)
            audit(fx, AUDIT.VEHICLE_CLEARED, {
                ...base, direction: found.dir,
                details: { waitedMs: now - found.vehicle.arrivedAt, queueLength: s.queues[found.dir].length, ...flags },
            })
        } else {
            audit(fx, AUDIT.SENSOR_EVENT_IGNORED, { ...base, message: "VEHICLE_CLEARED without a matching arrival (kept as tombstone)", details: flags })
            result = { status: "IGNORED", reason: "CLEARED_WITHOUT_ARRIVAL", flags }
        }
        const emIdx = s.emergency.requests.findIndex(r => r.vehicleId === ev.vehicleId)
        if (emIdx !== -1) {
            const [r] = s.emergency.requests.splice(emIdx, 1)
            audit(fx, AUDIT.EMERGENCY_CLEARED, { direction: r.direction, vehicleId: r.vehicleId, message: "Emergency vehicle cleared the junction" })
            result = { status: "APPLIED", flags }
        }
        s.clearedVehicles.push({ vehicleId: ev.vehicleId, direction: ev.direction, sequenceNo: ev.sequenceNo, sensorTime: ev.sensorTime, at: now })
        if (s.clearedVehicles.length > MAX_TOMBSTONES) s.clearedVehicles.shift()
    }

    step(s, now, fx)
    return ok(s, fx, result)
}

// cmd = {command, direction, operator, durationSec, vehicleId, expectedVersion}
export const applyCommand = (prevState, cmd, now) => {
    const s = clone(prevState)
    const fx = []
    const operator = cmd.operator || "admin"
    const refuse = (code, message) => {
        audit(fx, AUDIT.COMMAND_REJECTED, { direction: cmd.direction, message, details: { command: cmd.command, operator } })
        return reject(prevState, fx, code, message)
    }

    if (cmd.expectedVersion != null && cmd.expectedVersion !== s.version) {
        return refuse(409, `Junction state changed (version ${s.version}, you sent ${cmd.expectedVersion}). Refresh and retry.`)
    }

    let result
    switch (cmd.command) {
        case "MANUAL_GREEN_REQUEST": {
            if (!s.config.directions.includes(cmd.direction)) return refuse(400, `Unknown direction ${cmd.direction}`)
            if (s.failure) return refuse(409, `Junction is in FAILURE (${s.failure.reason}); reset the failure first`)
            if (s.emergency.requests.length) return refuse(409, "Emergency preemption is active; manual control is not available until it clears")
            const { manualDefaultMs, manualMaxMs } = s.config.timings
            const durationMs = Math.min(Math.max(cmd.durationSec ? cmd.durationSec * 1000 : manualDefaultMs, 10000), manualMaxMs)
            const phase = phaseOf(s.config, cmd.direction)
            const replaced = s.manual
            s.manual = { phase, direction: cmd.direction, operator, startedAt: now, expiresAt: now + durationMs }
            audit(fx, AUDIT.MANUAL_OVERRIDE, {
                direction: cmd.direction,
                message: `${operator} requested GREEN for ${cmd.direction} (${phase})`,
                details: { phase, operator, expiresAt: new Date(now + durationMs).toISOString(), replaced: replaced ? `${replaced.operator}:${replaced.phase}` : null },
            })
            result = { status: "ACCEPTED", plannedSequence: describePlan(s, phase), manual: s.manual }
            break
        }
        case "RETURN_TO_AUTOMATIC": {
            if (!s.manual) {
                result = { status: "NO_OP", message: "Junction is not under manual control" }
                break
            }
            audit(fx, AUDIT.RETURN_TO_AUTOMATIC, { details: { operator, previousManual: s.manual } })
            s.manual = null
            result = { status: "ACCEPTED" }
            break
        }
        case "CLEAR_EMERGENCY": {
            const before = s.emergency.requests.length
            s.emergency.requests = cmd.vehicleId ? s.emergency.requests.filter(r => r.vehicleId !== cmd.vehicleId) : []
            if (before === s.emergency.requests.length) {
                result = { status: "NO_OP", message: "No matching emergency request" }
                break
            }
            audit(fx, AUDIT.EMERGENCY_CLEARED, { vehicleId: cmd.vehicleId, message: `Cleared by operator ${operator}` })
            result = { status: "ACCEPTED" }
            break
        }
        case "RESET_FAILURE": {
            if (!s.failure) {
                result = { status: "NO_OP", message: "Junction is not in FAILURE" }
                break
            }
            if (s.controllerStatus === "OFFLINE") return refuse(409, "Controller is still OFFLINE")
            const badSignals = Object.entries(s.devices.signals).filter(([, st]) => st !== "ONLINE" && st !== "WARNING")
            if (badSignals.length) return refuse(409, `Signal heads not healthy: ${badSignals.map(([d, st]) => `${d}=${st}`).join(", ")}`)
            audit(fx, AUDIT.FAILURE_RESET, { message: `Failure (${s.failure.reason}) reset by ${operator}` })
            s.failure = null
            // stage will be re-confirmed as ALL RED before any GREEN (see step -> RESYNC / SAFETY_HOLD)
            if (s.pendingCommand?.purpose === "FAILSAFE_ALL_RED") {
                // keep waiting for that ACK, it is exactly the resync we need
            } else if (!signalsEqual(s.config, s.actualSignals, allRed(s.config))) {
                s.stageConfirmedAt = null
            }
            result = { status: "ACCEPTED" }
            break
        }
        default:
            return refuse(400, `Unknown command ${cmd.command}`)
    }

    step(s, now, fx)
    return ok(s, fx, result)
}

const describePlan = (s, targetPhase) => {
    if (s.stage === STAGE.GREEN && s.phase === targetPhase) return [`${targetPhase} GREEN (already green - holding)`]
    const plan = []
    if (s.stage === STAGE.GREEN) plan.push(`${s.phase} YELLOW`)
    plan.push("ALL RED") //always - even from YELLOW/ALL_RED we finish the clearance first
    plan.push(`${targetPhase} GREEN`)
    return plan
}

// ev = {commandId, status, actualSignals (partial map or null), reason}
export const applyControllerEvent = (prevState, ev, now) => {
    const s = clone(prevState)
    const fx = []
    const p = s.pendingCommand

    if (!p || p.commandId !== ev.commandId) {
        const known = s.recentCommandIds.includes(ev.commandId)
        audit(fx, known ? AUDIT.DUPLICATE_ACK : AUDIT.STALE_ACK, {
            commandId: ev.commandId,
            message: known ? "ACK for an already confirmed command - ignored" : "ACK for unknown / superseded command - ignored",
        })
        return ok(prevState, fx, { status: known ? "DUPLICATE" : "IGNORED" })
    }

    if (s.controllerStatus !== "ONLINE") {
        audit(fx, AUDIT.DEVICE_STATUS_CHANGED, { previousState: s.controllerStatus, newState: "ONLINE", message: "Controller responded - marked ONLINE" })
        s.controllerStatus = "ONLINE"
    }
    s.pendingCommand = null
    s.recentCommandIds = [...s.recentCommandIds, p.commandId].slice(-MAX_RECENT_COMMANDS)
    let result = { status: "APPLIED" }

    if (ev.status === "ACK") {
        // ACK without actual_signals means "applied as requested"; given values override per direction
        const actual = { ...p.signals, ...(ev.actualSignals || {}) }
        const previous = s.actualSignals
        s.actualSignals = actual
        audit(fx, AUDIT.CONTROLLER_ACK, { commandId: p.commandId, details: { attempt: p.attempt, actualSignals: actual } })
        s.config.directions.forEach(d => {
            if (previous[d] !== actual[d]) {
                audit(fx, AUDIT.SIGNAL_CHANGED, { direction: d, previousState: previous[d], newState: actual[d], commandId: p.commandId })
            }
        })
        const conflict = findConflict(s.config, actual)
        const mismatched = s.config.directions.filter(d => actual[d] !== p.signals[d])
        if (conflict) {
            audit(fx, AUDIT.CONFLICT_DETECTED, { commandId: p.commandId, message: `Controller reports conflicting signals: ${conflict.join(",")}` })
            fx.push({ type: "COMMAND_STATUS", commandId: p.commandId, status: "MISMATCH" })
            enterFailure(s, "CONFLICTING_SIGNALS_REPORTED", now, fx, { commandId: p.commandId })
            result = { status: "APPLIED", warning: "CONFLICT_DETECTED" }
        } else if (mismatched.length) {
            audit(fx, AUDIT.STATE_MISMATCH, { commandId: p.commandId, message: `Desired != actual for ${mismatched.join(",")}`, details: { desired: p.signals, actual } })
            fx.push({ type: "COMMAND_STATUS", commandId: p.commandId, status: "MISMATCH" })
            s.lastCommandResult = { commandId: p.commandId, status: "MISMATCH", at: now }
            enterFailure(s, "DESIRED_ACTUAL_MISMATCH", now, fx, { commandId: p.commandId, mismatched })
            result = { status: "APPLIED", warning: "STATE_MISMATCH" }
        } else {
            s.stageConfirmedAt = now
            s.lastCommandResult = { commandId: p.commandId, status: "ACKED", at: now }
            fx.push({ type: "COMMAND_STATUS", commandId: p.commandId, status: "ACKED" })
            audit(fx, AUDIT.SIGNAL_CONFIRMED, { commandId: p.commandId, message: `${p.purpose} confirmed by controller` })
        }
    } else {
        // NACK / FAILED -> controller could not execute. Never assume it did.
        s.actualSignals = { ...allUnknown(s.config), ...(ev.actualSignals || {}) }
        audit(fx, AUDIT.COMMAND_FAILED, { commandId: p.commandId, message: `Controller reported ${ev.status}${ev.reason ? ": " + ev.reason : ""}` })
        fx.push({ type: "COMMAND_STATUS", commandId: p.commandId, status: ev.status })
        s.lastCommandResult = { commandId: p.commandId, status: ev.status, at: now }
        if (p.purpose === "FAILSAFE_ALL_RED" && s.failure) {
            s.failure.nextAttemptAt = now + s.config.timings.failsafeRetryMs // back off, don't hammer it
        }
        enterFailure(s, "CONTROLLER_COMMAND_FAILED", now, fx, { commandId: p.commandId })
    }

    step(s, now, fx)
    return ok(s, fx, result)
}

// ev = {eventId, deviceType, direction, status, sensorTime}
export const applyDeviceStatus = (prevState, ev, now) => {
    const s = clone(prevState)
    const fx = []
    const key = `${ev.deviceType}:${ev.direction || "*"}`
    const lastAt = s.devices.lastStatusAt[key]
    if (lastAt != null && ev.sensorTime < lastAt) {
        audit(fx, AUDIT.DEVICE_EVENT_IGNORED, { direction: ev.direction, eventId: ev.eventId, message: `Out-of-order status for ${key} ignored` })
        return ok(prevState, fx, { status: "IGNORED", reason: "OLDER_THAN_LAST_STATUS" })
    }
    if (ev.direction && !s.config.directions.includes(ev.direction)) {
        audit(fx, AUDIT.DEVICE_EVENT_IGNORED, { direction: ev.direction, eventId: ev.eventId, message: `Unknown direction ${ev.direction}` })
        return reject(prevState, fx, 400, `Unknown direction ${ev.direction} for junction ${s.junctionId}`)
    }
    s.devices.lastStatusAt[key] = ev.sensorTime

    const isController = ev.deviceType === "CONTROLLER" || (ev.deviceType === "SIGNAL_CONTROLLER" && !ev.direction)
    const isSignal = ev.deviceType === "SIGNAL" || (ev.deviceType === "SIGNAL_CONTROLLER" && ev.direction)

    if (isController) {
        const previous = s.controllerStatus
        s.controllerStatus = ev.status
        audit(fx, AUDIT.DEVICE_STATUS_CHANGED, { eventId: ev.eventId, previousState: previous, newState: ev.status, message: "Junction controller status" })
        if (ev.status === "OFFLINE" || ev.status === "UNKNOWN") {
            s.actualSignals = allUnknown(s.config)
            enterFailure(s, `CONTROLLER_${ev.status}`, now, fx)
        } else if (ev.status === "ONLINE" && previous !== "ONLINE") {
            audit(fx, AUDIT.CONTROLLER_RECONNECTED, { message: "Controller reconnected - re-sending pending command to resync" })
            const p = s.pendingCommand
            if (p) {
                p.sentAt = now
                p.deadline = now + (p.purpose === "FAILSAFE_ALL_RED" ? s.config.timings.failsafeRetryMs : s.config.timings.ackTimeoutMs)
                fx.push({ type: "SEND_COMMAND", command: { commandId: p.commandId, junctionId: s.junctionId, signals: p.signals, purpose: p.purpose, attempt: p.attempt } })
            } else if (s.failure) {
                s.failure.nextAttemptAt = now
            }
        }
    } else if (isSignal) {
        const previous = s.devices.signals[ev.direction]
        s.devices.signals[ev.direction] = ev.status
        audit(fx, AUDIT.DEVICE_STATUS_CHANGED, { eventId: ev.eventId, direction: ev.direction, previousState: previous, newState: ev.status, message: "Signal head status" })
        if (ev.status !== "ONLINE" && ev.status !== "WARNING") {
            s.actualSignals = { ...s.actualSignals, [ev.direction]: SIGNAL.UNKNOWN }
            enterFailure(s, `SIGNAL_${ev.status}_${ev.direction}`, now, fx)
        }
    } else {
        // SENSOR: no failure mode, scheduler uses fixed-time fallback for that direction
        const previous = s.devices.sensors[ev.direction]
        s.devices.sensors[ev.direction] = ev.status
        audit(fx, AUDIT.DEVICE_STATUS_CHANGED, {
            eventId: ev.eventId, direction: ev.direction, previousState: previous, newState: ev.status,
            message: ev.status === "ONLINE" ? "Sensor back online" : "Sensor not reliable - direction gets fixed-time fallback demand",
        })
    }

    step(s, now, fx)
    return ok(s, fx, { status: "APPLIED" })
}

// ---------------------------------------------------------------------------
// read model
// ---------------------------------------------------------------------------

const buildAlerts = (s, now) => {
    const alerts = []
    const add = (level, code, message) => alerts.push({ level, code, message })
    if (s.failure) add("CRITICAL", "FAILURE_MODE", `FAILURE: ${s.failure.reason} - junction held ALL RED`)
    if (s.controllerStatus === "OFFLINE") add("CRITICAL", "CONTROLLER_OFFLINE", "Junction controller is OFFLINE")
    else if (s.controllerStatus === "UNKNOWN") add("WARNING", "CONTROLLER_UNKNOWN", "Controller state UNKNOWN (no confirmation yet)")
    else if (s.controllerStatus !== "ONLINE") add("WARNING", "CONTROLLER_" + s.controllerStatus, `Controller reports ${s.controllerStatus}`)
    Object.entries(s.devices.signals).forEach(([d, st]) => {
        if (st !== "ONLINE") add(st === "WARNING" ? "WARNING" : "CRITICAL", "SIGNAL_FAILURE", `Signal ${d} is ${st}`)
    })
    Object.entries(s.devices.sensors).forEach(([d, st]) => {
        if (st !== "ONLINE") add("WARNING", "SENSOR_FAILURE", `Sensor ${d} is ${st} - fixed-time fallback used`)
    })
    const unknown = s.config.directions.filter(d => s.actualSignals[d] === SIGNAL.UNKNOWN)
    if (unknown.length) add("WARNING", "UNKNOWN_DEVICE_STATE", `Physical state unknown for ${unknown.join(", ")}`)
    const mismatch = s.config.directions.filter(d => s.actualSignals[d] !== s.desiredSignals[d])
    if (mismatch.length && !s.pendingCommand) add("CRITICAL", "STATE_MISMATCH", `Desired/actual mismatch on ${mismatch.join(", ")}`)
    if (s.pendingCommand) {
        const p = s.pendingCommand
        add(p.attempt > 1 ? "WARNING" : "INFO", "AWAITING_ACK", `Waiting for controller ACK of ${p.commandId} (attempt ${p.attempt})`)
    }
    if (s.lastCommandResult?.status === "TIMEOUT") add("CRITICAL", "COMMAND_TIMEOUT", `Command ${s.lastCommandResult.commandId} timed out`)
    if (s.failure && s.emergency.requests.length) add("CRITICAL", "EMERGENCY_IN_FAILURE", "Emergency vehicle waiting while junction is in FAILURE - direct traffic manually")
    const active = activeEmergency(s)
    if (active) add("CRITICAL", "EMERGENCY_ACTIVE", `Emergency ${active.vehicleId} from ${active.direction}`)
    if (s.manual) add("INFO", "MANUAL_OVERRIDE", `Manual override by ${s.manual.operator} until ${new Date(s.manual.expiresAt).toISOString()}`)
    return alerts
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString())

export const toStatusView = (s, now) => {
    const active = activeEmergency(s)
    const p = s.pendingCommand
    return {
        junction_id: s.junctionId,
        name: s.name,
        mode: s.mode,
        phase: s.stage === STAGE.ALL_RED ? "ALL_RED" : s.phase,
        stage: s.stage,
        target_phase: s.targetPhase,
        stage_started_at: iso(s.stageStartedAt),
        stage_confirmed_at: iso(s.stageConfirmedAt),
        stage_elapsed_ms: s.stageConfirmedAt == null ? 0 : now - s.stageConfirmedAt,
        controller_status: s.controllerStatus,
        desired_signals: s.desiredSignals,
        actual_signals: s.actualSignals,
        signals_match: signalsEqual(s.config, s.desiredSignals, s.actualSignals),
        queues: mapDirections(s.config, d => s.queues[d].length),
        queue_details: mapDirections(s.config, d => s.queues[d].map(v => ({
            vehicle_id: v.vehicleId, vehicle_type: v.vehicleType, arrived_at: iso(v.arrivedAt), waiting_ms: now - v.arrivedAt,
        }))),
        phase_scores: allPhaseScores(s, now),
        emergency: {
            active: !!active,
            direction: active?.direction ?? null,
            vehicle_id: active?.vehicleId ?? null,
            phase: active?.phase ?? null,
            requests: s.emergency.requests.map(r => ({
                vehicle_id: r.vehicleId, direction: r.direction, phase: r.phase, detected_at: iso(r.detectedAt), expires_at: iso(r.expiresAt),
            })),
        },
        manual: s.manual ? { ...s.manual, startedAt: iso(s.manual.startedAt), expiresAt: iso(s.manual.expiresAt) } : null,
        failure: s.failure ? { reason: s.failure.reason, since: iso(s.failure.since), details: s.failure.details } : null,
        devices: { controller: s.controllerStatus, signals: s.devices.signals, sensors: s.devices.sensors },
        pending_command: p ? {
            command_id: p.commandId, requested_signals: p.signals, purpose: p.purpose, attempt: p.attempt,
            sent_at: iso(p.sentAt), deadline: iso(p.deadline),
        } : null,
        last_command_result: s.lastCommandResult ? { ...s.lastCommandResult, at: iso(s.lastCommandResult.at) } : null,
        alerts: buildAlerts(s, now),
        config: { directions: s.config.directions, phases: s.config.phases, timings: s.config.timings, priorities: s.config.priorities },
        version: s.version,
        server_time: iso(now),
    }
}
