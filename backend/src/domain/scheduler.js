// Automatic scheduling strategy (pure functions).
//
// score(phase) = sum over waiting vehicles of:
//                   priorityWeight(vehicle_type) + min(waitSeconds / waitSecondsPerPoint, maxWaitPoints)
//              + sensorFallbackPoints for every direction whose sensor is not ONLINE
//
// While a phase is GREEN (automatic mode):
//   1. no other phase has demand            -> keep green (no unnecessary switching)
//   2. green < minGreen                     -> keep green
//   3. another phase starving (> maxWait)   -> switch
//   4. current phase has no demand          -> switch
//   5. green >= maxGreen                    -> switch
//   6. green >= green && other score >= own -> switch
//   otherwise keep green

const ONLINE = "ONLINE"

export const vehicleWeight = (config, vehicleType) => config.priorities[vehicleType] ?? 1

export const phaseScore = (state, phaseName, now) => {
    const { config } = state
    const phase = config.phases.find(p => p.name === phaseName)
    let score = 0
    let count = 0
    let oldestWaitMs = 0
    let sensorFallback = false
    const byType = {}

    phase.directions.forEach(dir => {
        ; (state.queues[dir] || []).forEach(v => {
            const waitMs = Math.max(0, now - v.arrivedAt)
            const waitPoints = Math.min(waitMs / 1000 / config.scoring.waitSecondsPerPoint, config.scoring.maxWaitPoints)
            score += vehicleWeight(config, v.vehicleType) + waitPoints
            count += 1
            oldestWaitMs = Math.max(oldestWaitMs, waitMs)
            byType[v.vehicleType] = (byType[v.vehicleType] || 0) + 1
        })
        //sensor down -> we can't see vehicles, so assume somebody is waiting (fixed-time fallback)
        if (state.devices.sensors[dir] !== ONLINE) {
            sensorFallback = true
            score += config.scoring.sensorFallbackPoints
            const since = state.phaseLastServedAt[phaseName] ?? now
            oldestWaitMs = Math.max(oldestWaitMs, now - since)
        }
    })

    return {
        phase: phaseName,
        score: Math.round(score * 100) / 100,
        count,
        oldestWaitMs,
        hasDemand: count > 0 || sensorFallback,
        sensorFallback,
        byType,
    }
}

export const allPhaseScores = (state, now) => state.config.phases.map(p => phaseScore(state, p.name, now))

// next phase in configured order after `phaseName`
export const nextInRotation = (config, phaseName) => {
    const idx = config.phases.findIndex(p => p.name === phaseName)
    return config.phases[(idx + 1) % config.phases.length].name
}

const byScoreThenWait = (a, b) => b.score - a.score || b.oldestWaitMs - a.oldestWaitMs

// decision while current phase is GREEN in AUTOMATIC mode. returns {target, reason}; target null = stay
export const decideWhileGreen = (state, now, greenElapsedMs) => {
    const { timings } = state.config
    const current = phaseScore(state, state.phase, now)
    const others = state.config.phases
        .filter(p => p.name !== state.phase)
        .map(p => phaseScore(state, p.name, now))
        .filter(s => s.hasDemand)
        .sort(byScoreThenWait)

    if (!others.length) return { target: null, reason: "NO_COMPETING_DEMAND" }
    if (greenElapsedMs < timings.minGreenMs) return { target: null, reason: "MIN_GREEN" }

    const starving = [...others].sort((a, b) => b.oldestWaitMs - a.oldestWaitMs)[0]
    if (starving.oldestWaitMs >= timings.maxWaitMs) return { target: starving.phase, reason: "STARVATION_PROTECTION" }

    const best = others[0]
    if (!current.hasDemand) return { target: best.phase, reason: "CURRENT_PHASE_EMPTY" }
    if (greenElapsedMs >= timings.maxGreenMs) return { target: best.phase, reason: "MAX_GREEN_REACHED" }
    if (greenElapsedMs >= timings.greenMs && best.score >= current.score) {
        return { target: best.phase, reason: "HIGHER_SCORE_AFTER_GREEN" }
    }
    return { target: null, reason: "KEEP_GREEN" }
}

// decision at the end of ALL_RED (automatic mode): pick the best phase to make GREEN
export const pickBestPhase = (state, now, preferred) => {
    const scores = allPhaseScores(state, now)
    const withDemand = scores.filter(s => s.hasDemand)
    const fallback = preferred ?? (state.lastGreenPhase ? nextInRotation(state.config, state.lastGreenPhase) : state.config.phases[0].name)
    if (!withDemand.length) return { target: fallback, reason: "NO_DEMAND_DEFAULT" }

    const starving = withDemand
        .filter(s => s.oldestWaitMs >= state.config.timings.maxWaitMs)
        .sort((a, b) => b.oldestWaitMs - a.oldestWaitMs)
    if (starving.length) return { target: starving[0].phase, reason: "STARVATION_PROTECTION" }

    const sorted = [...withDemand].sort(byScoreThenWait)
    const top = sorted.filter(s => s.score === sorted[0].score)
    const preferredTop = top.find(s => s.phase === fallback)
    return { target: (preferredTop || top[0]).phase, reason: "HIGHEST_SCORE" }
}
