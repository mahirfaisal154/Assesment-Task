import {
    VEHICLE_TYPES, SENSOR_EVENT_TYPES, DEVICE_TYPES, DEVICE_STATUS, CONTROL_COMMANDS, ACK_STATUS, SIGNAL,
} from "../domain/constants.js"

// Each validator returns {errors: [...], value: normalized}. Only shape/format checks here -
// anything that depends on junction state (unknown direction for that junction etc.) is checked in the domain.

const isNonEmptyString = (x) => typeof x === "string" && x.trim().length > 0
const upper = (x) => (typeof x === "string" ? x.trim().toUpperCase() : x)
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/

const parseTimestamp = (raw, errors, required = true) => {
    if (raw == null) {
        if (required) errors.push("timestamp is required (ISO-8601)")
        return null
    }
    if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
        errors.push("timestamp must be an ISO-8601 string")
        return null
    }
    return Date.parse(raw)
}

const checkId = (value, field, errors) => {
    if (!isNonEmptyString(value)) errors.push(`${field} is required`)
    else if (!ID_PATTERN.test(value.trim())) errors.push(`${field} has invalid characters or is too long`)
}

export const validateSensorEvent = (body, now, futureToleranceMs = 60000) => {
    const errors = []
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: ["body must be a JSON object"], value: null }

    checkId(body.event_id, "event_id", errors)
    checkId(body.junction_id, "junction_id", errors)
    checkId(body.vehicle_id, "vehicle_id", errors)
    if (!isNonEmptyString(body.direction)) errors.push("direction is required")

    const eventType = upper(body.event_type)
    if (!SENSOR_EVENT_TYPES.includes(eventType)) errors.push(`event_type must be one of ${SENSOR_EVENT_TYPES.join(", ")}`)

    const vehicleType = body.vehicle_type == null ? null : upper(body.vehicle_type)
    if (eventType === "VEHICLE_ARRIVED" && vehicleType == null) errors.push("vehicle_type is required for VEHICLE_ARRIVED")
    if (vehicleType != null && !VEHICLE_TYPES.includes(vehicleType)) errors.push(`unknown vehicle_type ${body.vehicle_type}; expected ${VEHICLE_TYPES.join(", ")}`)

    let sequenceNo = null
    if (body.sequence_no != null) {
        if (!Number.isInteger(body.sequence_no) || body.sequence_no < 0) errors.push("sequence_no must be a non-negative integer")
        else sequenceNo = body.sequence_no
    }
    const sensorTime = parseTimestamp(body.timestamp, errors)
    if (sensorTime != null && sensorTime - now > futureToleranceMs) {
        errors.push("timestamp is too far in the future (sensor clock skew?)")
    }

    return {
        errors,
        value: errors.length ? null : {
            eventId: body.event_id.trim(),
            junctionId: body.junction_id.trim(),
            direction: upper(body.direction),
            eventType,
            vehicleId: body.vehicle_id.trim(),
            vehicleType,
            sequenceNo,
            sensorTime,
        },
    }
}

export const validateDeviceEvent = (body, now, futureToleranceMs = 60000) => {
    const errors = []
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: ["body must be a JSON object"], value: null }
    checkId(body.event_id, "event_id", errors)
    checkId(body.junction_id, "junction_id", errors)
    const deviceType = upper(body.device_type)
    if (!DEVICE_TYPES.includes(deviceType)) errors.push(`device_type must be one of ${DEVICE_TYPES.join(", ")}`)
    const status = upper(body.status)
    if (!DEVICE_STATUS.includes(status)) errors.push(`status must be one of ${DEVICE_STATUS.join(", ")}`)
    const direction = body.direction == null || body.direction === "" ? null : upper(body.direction)
    if ((deviceType === "SENSOR" || deviceType === "SIGNAL") && !direction) errors.push(`direction is required for ${deviceType}`)
    // timestamp optional for device events - server time used if missing
    const sensorTime = body.timestamp == null ? now : parseTimestamp(body.timestamp, errors)
    if (sensorTime != null && sensorTime - now > futureToleranceMs) errors.push("timestamp is too far in the future")

    return {
        errors,
        value: errors.length ? null : { eventId: body.event_id.trim(), junctionId: body.junction_id.trim(), deviceType, direction, status, sensorTime },
    }
}

export const validateControllerEvent = (body) => {
    const errors = []
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: ["body must be a JSON object"], value: null }
    checkId(body.command_id, "command_id", errors)
    checkId(body.junction_id, "junction_id", errors)
    const status = upper(body.status)
    if (!ACK_STATUS.includes(status)) errors.push(`status must be one of ${ACK_STATUS.join(", ")}`)

    const allowed = [SIGNAL.RED, SIGNAL.YELLOW, SIGNAL.GREEN, SIGNAL.UNKNOWN]
    let actualSignals = null
    if (body.actual_signals != null) {
        if (typeof body.actual_signals !== "object" || Array.isArray(body.actual_signals)) errors.push("actual_signals must be an object {DIRECTION: STATE}")
        else {
            actualSignals = {}
            Object.entries(body.actual_signals).forEach(([d, st]) => {
                if (!allowed.includes(upper(st))) errors.push(`actual_signals.${d} must be one of ${allowed.join(", ")}`)
                actualSignals[upper(d)] = upper(st)
            })
        }
    }
    // spec style single-direction ACK: {direction, actual_state}
    if (body.actual_state != null) {
        if (!allowed.includes(upper(body.actual_state))) errors.push(`actual_state must be one of ${allowed.join(", ")}`)
        else if (!isNonEmptyString(body.direction)) errors.push("direction is required together with actual_state")
        else actualSignals = { ...(actualSignals || {}), [upper(body.direction)]: upper(body.actual_state) }
    }
    return {
        errors,
        value: errors.length ? null : {
            commandId: body.command_id.trim(), junctionId: body.junction_id.trim(), status, actualSignals,
            reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : null,
        },
    }
}

export const validateCommand = (body) => {
    const errors = []
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: ["body must be a JSON object"], value: null }
    const command = upper(body.command)
    if (!CONTROL_COMMANDS.includes(command)) errors.push(`command must be one of ${CONTROL_COMMANDS.join(", ")}`)
    const direction = body.direction == null ? null : upper(body.direction)
    if (command === "MANUAL_GREEN_REQUEST" && !direction) errors.push("direction is required for MANUAL_GREEN_REQUEST")
    if (body.duration_sec != null && (!Number.isFinite(body.duration_sec) || body.duration_sec <= 0)) errors.push("duration_sec must be a positive number")
    if (body.expected_version != null && !Number.isInteger(body.expected_version)) errors.push("expected_version must be an integer")
    const operator = isNonEmptyString(body.operator) ? body.operator.trim().slice(0, 50) : "admin"
    return {
        errors,
        value: errors.length ? null : {
            command, direction, operator,
            durationSec: body.duration_sec ?? null,
            vehicleId: isNonEmptyString(body.vehicle_id) ? body.vehicle_id.trim() : null,
            expectedVersion: body.expected_version ?? null,
        },
    }
}

export const validateNewJunction = (body) => {
    const errors = []
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: ["body must be a JSON object"], value: null }
    checkId(body.junction_id, "junction_id", errors)
    if (body.name != null && typeof body.name !== "string") errors.push("name must be a string")
    return {
        errors,
        value: errors.length ? null : {
            junctionId: body.junction_id.trim(),
            name: body.name?.trim() || `Junction ${body.junction_id.trim()}`,
            configInput: { directions: body.directions, phases: body.phases, timings: body.timings, priorities: body.priorities, scoring: body.scoring },
        },
    }
}
