import { SIGNAL } from "./constants.js"

// Two directions conflict when they belong to different phases.
// A signal set is safe when every non-RED (GREEN or YELLOW) direction is inside ONE phase.

export const phaseOf = (config, direction) => {
    const phase = config.phases.find(p => p.directions.includes(direction))
    return phase ? phase.name : null
}

export const mapDirections = (config, fn) =>
    Object.fromEntries(config.directions.map(d => [d, fn(d)]))

export const allRed = (config) => mapDirections(config, () => SIGNAL.RED)

export const allUnknown = (config) => mapDirections(config, () => SIGNAL.UNKNOWN)

// GREEN/YELLOW for directions of the phase, RED for everyone else
export const signalsForPhase = (config, phaseName, color) => {
    const phase = config.phases.find(p => p.name === phaseName)
    return mapDirections(config, d => (phase && phase.directions.includes(d) ? color : SIGNAL.RED))
}

// returns null when safe, otherwise the list of permissive directions from different phases
export const findConflict = (config, signals) => {
    const permissive = config.directions.filter(d => signals[d] === SIGNAL.GREEN || signals[d] === SIGNAL.YELLOW)
    const phases = new Set(permissive.map(d => phaseOf(config, d)))
    return phases.size > 1 ? permissive : null
}

// guard used before ANY command leaves the engine. if this throws it's a bug, not a runtime condition
export const assertSafeSignals = (config, signals) => {
    config.directions.forEach(d => {
        if (![SIGNAL.RED, SIGNAL.YELLOW, SIGNAL.GREEN].includes(signals[d])) {
            throw new Error(`SAFETY VIOLATION: invalid commanded state ${signals[d]} for ${d}`)
        }
    })
    const conflict = findConflict(config, signals)
    if (conflict) {
        throw new Error(`SAFETY VIOLATION: conflicting permissive signals ${conflict.join(",")}`)
    }
}

// a phase may only get GREEN when every direction outside it is CONFIRMED red by the controller
export const conflictingDirectionsConfirmedRed = (config, actualSignals, targetPhase) => {
    const phase = config.phases.find(p => p.name === targetPhase)
    if (!phase) return false
    return config.directions
        .filter(d => !phase.directions.includes(d))
        .every(d => actualSignals[d] === SIGNAL.RED)
}

export const signalsEqual = (config, a, b) => config.directions.every(d => a?.[d] === b?.[d])
