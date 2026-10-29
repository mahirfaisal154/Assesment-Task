// Junction configuration: directions, phases, timings and scheduling weights.
// Junction specific stuff lives here (data), not inside the engine logic.

export const DEFAULT_DIRECTIONS = ["NORTH", "SOUTH", "EAST", "WEST"]

export const DEFAULT_PHASES = [
    { name: "NORTH_SOUTH", directions: ["NORTH", "SOUTH"] },
    { name: "EAST_WEST", directions: ["EAST", "WEST"] },
]

// all times in milliseconds
export const DEFAULT_TIMINGS = {
    minGreenMs: 10000,          // never switch away before this (avoid flapping) - except emergency
    greenMs: 30000,             // normal green duration
    maxGreenMs: 60000,          // hard cap when other phase has demand
    yellowMs: 5000,
    allRedMs: 2000,             // clearance between conflicting phases
    ackTimeoutMs: 4000,         // wait this long for controller ACK
    maxCommandRetries: 2,       // resend same command_id this many times before FAILURE
    failsafeRetryMs: 5000,      // in FAILURE keep re-sending ALL RED at this interval
    manualDefaultMs: 10 * 60 * 1000,
    manualMaxMs: 60 * 60 * 1000,
    emergencyTimeoutMs: 2 * 60 * 1000,  // emergency auto-expires if never cleared
    emergencyStaleMs: 30000,    // emergency events older than this do not preempt
    delayedEventMs: 30000,      // sensor events older than this are flagged as delayed
    futureToleranceMs: 60000,   // sensor clock may be ahead by this much
    maxWaitMs: 90000,           // starvation protection threshold
}

// vehicle priority: EMERGENCY > TRUCK > FORKLIFT > EMPLOYEE_VEHICLE
export const DEFAULT_PRIORITIES = {
    EMERGENCY: 10,
    TRUCK: 4,
    FORKLIFT: 3,
    EMPLOYEE_VEHICLE: 1,
}

export const DEFAULT_SCORING = {
    waitSecondsPerPoint: 15,    // every vehicle gains +1 point per 15s waiting
    maxWaitPoints: 20,          // cap per vehicle so one old vehicle doesn't dominate forever
    sensorFallbackPoints: 3,    // virtual demand for a direction whose sensor is offline
}

const isPositiveNumber = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0

// builds + validates a junction config. returns {errors, config}
export const buildJunctionConfig = (input = {}) => {
    const errors = []
    const directions = (input.directions ?? DEFAULT_DIRECTIONS).map(d => String(d).trim().toUpperCase())
    const phases = (input.phases ?? DEFAULT_PHASES).map(p => ({
        name: String(p?.name ?? "").trim().toUpperCase(),
        directions: (Array.isArray(p?.directions) ? p.directions : []).map(d => String(d).trim().toUpperCase()),
    }))

    if (directions.length < 2) errors.push("at least 2 directions are required")
    if (new Set(directions).size !== directions.length) errors.push("directions must be unique")
    if (phases.length < 2) errors.push("at least 2 phases are required")
    if (new Set(phases.map(p => p.name)).size !== phases.length) errors.push("phase names must be unique")
    phases.forEach(p => {
        if (!p.name) errors.push("every phase needs a name")
        if (!p.directions.length) errors.push(`phase ${p.name} has no directions`)
    })
    // every direction must belong to exactly one phase, otherwise "conflict" is undefined
    directions.forEach(d => {
        const count = phases.filter(p => p.directions.includes(d)).length
        if (count !== 1) errors.push(`direction ${d} must belong to exactly one phase (found ${count})`)
    })
    phases.forEach(p => p.directions.forEach(d => {
        if (!directions.includes(d)) errors.push(`phase ${p.name} references unknown direction ${d}`)
    }))

    const timings = { ...DEFAULT_TIMINGS, ...(input.timings || {}) }
    Object.entries(timings).forEach(([k, v]) => {
        if (!isPositiveNumber(v)) errors.push(`timings.${k} must be a non-negative number`)
    })
    if (timings.minGreenMs > timings.greenMs || timings.greenMs > timings.maxGreenMs) {
        errors.push("timings must satisfy minGreenMs <= greenMs <= maxGreenMs")
    }
    if (timings.yellowMs < 1000) errors.push("timings.yellowMs must be at least 1000ms")
    if (timings.ackTimeoutMs < 100) errors.push("timings.ackTimeoutMs must be at least 100ms")

    const priorities = { ...DEFAULT_PRIORITIES, ...(input.priorities || {}) }
    Object.entries(priorities).forEach(([k, v]) => {
        if (!isPositiveNumber(v)) errors.push(`priorities.${k} must be a non-negative number`)
    })
    const scoring = { ...DEFAULT_SCORING, ...(input.scoring || {}) }
    if (!(scoring.waitSecondsPerPoint > 0)) errors.push("scoring.waitSecondsPerPoint must be > 0")

    return { errors, config: { directions, phases, timings, priorities, scoring } }
}
