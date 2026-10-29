import { createJunctionState, tick, applyControllerEvent } from "../src/domain/junctionEngine.js"
import { buildJunctionConfig } from "../src/domain/junctionConfig.js"

export const makeState = (now = 0, configInput = {}) => {
    const { errors, config } = buildJunctionConfig(configInput)
    if (errors.length) throw new Error(errors.join(", "))
    return createJunctionState("A", "Junction A", config, now)
}

// controller confirms whatever is pending
export const ack = (s, now, actualSignals = null) =>
    applyControllerEvent(s, { commandId: s.pendingCommand.commandId, status: "ACK", actualSignals }, now).state

// advance the clock with an auto-ACKing controller; collects stage history
export const runFor = (s, from, to, { stepMs = 100, autoAck = true, onStep } = {}) => {
    let now = from
    while (now <= to) {
        const out = tick(s, now)
        s = out.state
        if (onStep) onStep(s, now, out)
        if (autoAck && s.pendingCommand) s = ack(s, now)
        now += stepMs
    }
    return s
}

// auto-ACK until pred(state) is true right after a tick (before acking) -> {s, now}
export const runUntil = (s, from, pred, { stepMs = 100, limit = 300000 } = {}) => {
    let now = from
    while (now < from + limit) {
        s = tick(s, now).state
        if (pred(s)) return { s, now }
        if (s.pendingCommand) s = ack(s, now)
        now += stepMs
    }
    throw new Error("runUntil: condition never reached")
}

// bring a fresh junction to NORTH_SOUTH GREEN confirmed
export const startedJunction = (now = 0) => {
    let s = makeState(now)
    s = runFor(s, now, now + 3000)
    return s
}

export const arrival = (eventId, direction, vehicleId, vehicleType, sensorTime, sequenceNo = null) => ({
    eventId, direction, eventType: "VEHICLE_ARRIVED", vehicleId, vehicleType, sequenceNo, sensorTime,
})

export const cleared = (eventId, direction, vehicleId, sensorTime, sequenceNo = null) => ({
    eventId, direction, eventType: "VEHICLE_CLEARED", vehicleId, vehicleType: null, sequenceNo, sensorTime,
})
