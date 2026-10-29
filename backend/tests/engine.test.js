import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
    tick, applySensorEvent, applyCommand, applyControllerEvent, applyDeviceStatus, recoverAfterRestart, toStatusView,
} from "../src/domain/junctionEngine.js"
import { findConflict } from "../src/domain/safety.js"
import { makeState, ack, runFor, runUntil, startedJunction, arrival, cleared } from "./helpers.js"

const stagesOf = (effects) => effects.filter(e => e.type === "AUDIT" && e.entry.eventType === "STAGE_CHANGED").map(e => e.entry.newState)

describe("signal cycle", () => {
    test("fresh junction syncs ALL RED with controller before first GREEN", () => {
        let s = makeState(0)
        const out = tick(s, 0)
        assert.equal(out.state.stage, "ALL_RED")
        const send = out.effects.find(e => e.type === "SEND_COMMAND")
        assert.deepEqual(send.command.signals, { NORTH: "RED", SOUTH: "RED", EAST: "RED", WEST: "RED" })
        s = runFor(out.state, 0, 3000)
        assert.equal(s.stage, "GREEN")
        assert.equal(s.phase, "NORTH_SOUTH")
        assert.deepEqual(s.actualSignals, { NORTH: "GREEN", SOUTH: "GREEN", EAST: "RED", WEST: "RED" })
    })

    test("GREEN -> YELLOW -> ALL_RED -> GREEN, never green to green", () => {
        let s = startedJunction(0)
        s = applySensorEvent(s, arrival("e1", "EAST", "V1", "TRUCK", 1000), 1000).state
        const stages = []
        s = runFor(s, 1000, 60000, { onStep: (st, now, out) => stages.push(...stagesOf(out.effects)) })
        assert.equal(s.phase, "EAST_WEST")
        assert.deepEqual(stages.slice(0, 3), ["YELLOW(NORTH_SOUTH)", "ALL_RED", "GREEN(EAST_WEST)"])
    })

    test("min green respected and yellow lasts ~5s after confirmation", () => {
        let s = startedJunction(0)
        const greenAt = s.stageConfirmedAt
        s = applySensorEvent(s, arrival("e1", "EAST", "V1", "FORKLIFT", 500), 500).state
        let yellowAt = null, allRedAt = null
        s = runFor(s, 600, 40000, {
            onStep: (st, now) => {
                if (st.stage === "YELLOW" && yellowAt == null) yellowAt = now
                if (st.stage === "ALL_RED" && allRedAt == null && yellowAt != null) allRedAt = now
            },
        })
        assert.ok(yellowAt - greenAt >= s.config.timings.minGreenMs, "switched before min green")
        assert.ok(allRedAt - yellowAt >= s.config.timings.yellowMs, "yellow too short")
    })

    test("engine does not advance without controller ACK", () => {
        let s = makeState(0)
        s = runFor(s, 0, 3000, { autoAck: false })
        assert.equal(s.stage, "ALL_RED")
        assert.equal(s.mode, "AUTOMATIC")
        assert.ok(s.pendingCommand, "still waiting")
        s = runFor(s, 3000, 20000, { autoAck: false })
        assert.equal(s.stage, "ALL_RED")
        assert.ok(Object.values(s.desiredSignals).every(v => v === "RED"))
        assert.equal(s.mode, "FAILURE") // timed out after retries
    })
})

describe("controller acknowledgement", () => {
    test("ACK timeout retries same command_id then enters FAILURE with ALL RED", () => {
        let s = startedJunction(0)
        s = applySensorEvent(s, arrival("e1", "EAST", "V1", "TRUCK", 0), 0).state
        // run until yellow is requested but never ack it
        const r = runUntil(s, 3000, st => st.stage === "YELLOW" && !!st.pendingCommand)
        s = r.s
        const cmdId = s.pendingCommand.commandId
        const sent = []
        for (let now = r.now + 500; now < r.now + 20000; now += 500) {
            const out = tick(s, now)
            s = out.state
            out.effects.filter(e => e.type === "SEND_COMMAND").forEach(e => sent.push(e.command))
        }
        const retries = sent.filter(c => c.commandId === cmdId)
        assert.equal(retries.length, 2, "two retries with the same command id")
        assert.equal(s.mode, "FAILURE")
        assert.equal(s.failure.reason, "CONTROLLER_ACK_TIMEOUT")
        assert.deepEqual(s.desiredSignals, { NORTH: "RED", SOUTH: "RED", EAST: "RED", WEST: "RED" })
        assert.ok(Object.values(s.actualSignals).every(v => v === "UNKNOWN"))
    })

    test("duplicate ACK and unknown ACK are ignored", () => {
        let s = makeState(0)
        s = tick(s, 0).state
        const id = s.pendingCommand.commandId
        const first = applyControllerEvent(s, { commandId: id, status: "ACK" }, 100)
        assert.equal(first.result.status, "APPLIED")
        const dup = applyControllerEvent(first.state, { commandId: id, status: "ACK" }, 200)
        assert.equal(dup.result.status, "DUPLICATE")
        assert.equal(dup.state, first.state)
        const unknown = applyControllerEvent(first.state, { commandId: "cmd-x", status: "ACK" }, 200)
        assert.equal(unknown.result.status, "IGNORED")
    })

    test("ACK with different actual state -> mismatch -> FAILURE", () => {
        let s = makeState(0)
        s = tick(s, 0).state
        const out = applyControllerEvent(s, { commandId: s.pendingCommand.commandId, status: "ACK", actualSignals: { NORTH: "GREEN" } }, 100)
        assert.equal(out.state.mode, "FAILURE")
        assert.equal(out.state.failure.reason, "DESIRED_ACTUAL_MISMATCH")
    })

    test("NACK -> FAILURE, actual becomes UNKNOWN", () => {
        let s = startedJunction(0)
        s = applySensorEvent(s, arrival("e1", "EAST", "V1", "TRUCK", 0), 0).state
        const r = runUntil(s, 3000, st => st.stage === "YELLOW" && !!st.pendingCommand)
        s = r.s
        const out = applyControllerEvent(s, { commandId: s.pendingCommand.commandId, status: "NACK" }, r.now + 100)
        assert.equal(out.state.mode, "FAILURE")
        assert.equal(out.state.actualSignals.NORTH, "UNKNOWN")
    })
})

describe("emergency", () => {
    test("emergency from EAST during NORTH_SOUTH green preempts safely and immediately", () => {
        let s = startedJunction(0)
        const t0 = s.stageConfirmedAt + 1000 // well inside min green
        let out = applySensorEvent(s, arrival("em1", "EAST", "AMB-1", "EMERGENCY", t0), t0)
        s = out.state
        assert.equal(s.mode, "EMERGENCY")
        assert.equal(s.stage, "YELLOW", "yellow must start immediately")
        assert.equal(s.phase, "NORTH_SOUTH")
        assert.equal(s.desiredSignals.EAST, "RED", "EAST is NOT green immediately")
        const stages = []
        s = runFor(ack(s, t0), t0, t0 + 10000, { onStep: (st, n, o) => stages.push(...stagesOf(o.effects)) })
        assert.deepEqual(stages, ["ALL_RED", "GREEN(EAST_WEST)"])
        // holds green past max green while emergency active
        s = applySensorEvent(s, arrival("n1", "NORTH", "T1", "TRUCK", t0 + 10000), t0 + 10000).state
        s = runFor(s, t0 + 10000, t0 + 100000, { stepMs: 500 })
        assert.equal(s.phase, "EAST_WEST")
        // clear -> back to automatic
        s = applySensorEvent(s, cleared("em1c", "EAST", "AMB-1", t0 + 100000), t0 + 100000).state
        assert.equal(s.mode, "AUTOMATIC")
    })

    test("conflicting emergencies are served first-come-first-served", () => {
        let s = startedJunction(0)
        s = applySensorEvent(s, arrival("a", "EAST", "AMB-1", "EMERGENCY", 5000), 5000).state
        s = applySensorEvent(s, arrival("b", "NORTH", "AMB-2", "EMERGENCY", 5004), 5004).state
        s = runFor(s, 5004, 20000)
        assert.equal(s.phase, "EAST_WEST")
        s = applySensorEvent(s, cleared("c", "EAST", "AMB-1", 20000), 20000).state
        assert.equal(s.mode, "EMERGENCY")
        s = runFor(s, 20000, 35000)
        assert.equal(s.phase, "NORTH_SOUTH")
    })

    test("repeated emergency event refreshes, does not duplicate", () => {
        let s = startedJunction(0)
        s = applySensorEvent(s, arrival("a", "EAST", "AMB-1", "EMERGENCY", 5000), 5000).state
        const out = applySensorEvent(s, arrival("a2", "EAST", "AMB-1", "EMERGENCY", 6000), 6000)
        assert.equal(out.state.emergency.requests.length, 1)
        assert.equal(out.state.queues.EAST.length, 1)
    })

    test("stale emergency event does not preempt", () => {
        let s = startedJunction(0)
        const now = 100000
        const out = applySensorEvent(s, arrival("a", "EAST", "AMB-1", "EMERGENCY", now - 60000), now)
        assert.equal(out.state.mode, "AUTOMATIC")
        assert.equal(out.state.emergency.requests.length, 0)
    })

    test("emergency expires after timeout", () => {
        let s = startedJunction(0)
        s = applySensorEvent(s, arrival("a", "EAST", "AMB-1", "EMERGENCY", 5000), 5000).state
        s = runFor(s, 5000, 5000 + s.config.timings.emergencyTimeoutMs + 1000, { stepMs: 500 })
        assert.equal(s.mode, "AUTOMATIC")
    })

    test("emergency overrides manual and junction returns to MANUAL afterwards", () => {
        let s = startedJunction(0)
        s = applyCommand(s, { command: "MANUAL_GREEN_REQUEST", direction: "NORTH" }, 4000).state
        assert.equal(s.mode, "MANUAL")
        s = applySensorEvent(s, arrival("a", "WEST", "AMB-1", "EMERGENCY", 5000), 5000).state
        assert.equal(s.mode, "EMERGENCY")
        const refused = applyCommand(s, { command: "MANUAL_GREEN_REQUEST", direction: "SOUTH" }, 5100)
        assert.equal(refused.result.code, 409)
        s = runFor(s, 5000, 20000)
        assert.equal(s.phase, "EAST_WEST")
        s = applySensorEvent(s, cleared("c", "WEST", "AMB-1", 20000), 20000).state
        assert.equal(s.mode, "MANUAL")
        s = runFor(s, 20000, 35000)
        assert.equal(s.phase, "NORTH_SOUTH")
    })
})

describe("manual control", () => {
    test("manual WEST uses safe sequence and holds; return to automatic", () => {
        let s = startedJunction(0)
        const out = applyCommand(s, { command: "MANUAL_GREEN_REQUEST", direction: "WEST", operator: "alice" }, 4000)
        assert.equal(out.result.status, "ACCEPTED")
        assert.deepEqual(out.result.plannedSequence, ["NORTH_SOUTH YELLOW", "ALL RED", "EAST_WEST GREEN"])
        s = out.state
        assert.equal(s.stage, "YELLOW")
        s = applySensorEvent(s, arrival("n", "NORTH", "T1", "TRUCK", 4000), 4000).state
        s = runFor(s, 4000, 150000, { stepMs: 500 })
        assert.equal(s.phase, "EAST_WEST", "manual holds even with demand elsewhere")
        s = applyCommand(s, { command: "RETURN_TO_AUTOMATIC" }, 150000).state
        assert.equal(s.mode, "AUTOMATIC")
        s = runFor(s, 150000, 170000)
        assert.equal(s.phase, "NORTH_SOUTH")
    })

    test("manual override expires", () => {
        let s = startedJunction(0)
        s = applyCommand(s, { command: "MANUAL_GREEN_REQUEST", direction: "EAST", durationSec: 30 }, 1000).state
        s = runFor(s, 1000, 40000, { stepMs: 500 })
        assert.equal(s.mode, "AUTOMATIC")
        assert.equal(s.manual, null)
    })

    test("invalid commands are rejected without changing state", () => {
        const s = startedJunction(0)
        assert.equal(applyCommand(s, { command: "FORCE_GREEN" }, 1).result.code, 400)
        assert.equal(applyCommand(s, { command: "MANUAL_GREEN_REQUEST", direction: "UP" }, 1).result.code, 400)
        const stale = applyCommand(s, { command: "MANUAL_GREEN_REQUEST", direction: "EAST", expectedVersion: 999 }, 1)
        assert.equal(stale.result.code, 409)
        assert.equal(stale.state, s)
    })
})

describe("queues and sensor events", () => {
    test("same vehicle arriving twice is not counted twice", () => {
        let s = startedJunction(0)
        s = applySensorEvent(s, arrival("e1", "NORTH", "V1", "TRUCK", 1000, 1), 1000).state
        const out = applySensorEvent(s, arrival("e2", "NORTH", "V1", "TRUCK", 1001, 2), 1001)
        assert.equal(out.result.status, "IGNORED")
        assert.equal(out.state.queues.NORTH.length, 1)
    })

    test("cleared without arrival never makes queue negative", () => {
        let s = startedJunction(0)
        const out = applySensorEvent(s, cleared("c1", "NORTH", "GHOST", 1000), 1000)
        assert.equal(out.result.reason, "CLEARED_WITHOUT_ARRIVAL")
        assert.equal(toStatusView(out.state, 1000).queues.NORTH, 0)
    })

    test("out-of-order: CLEARED (seq 11) before ARRIVED (seq 10) -> arrival ignored", () => {
        let s = startedJunction(0)
        s = applySensorEvent(s, cleared("c1", "NORTH", "V9", 2000, 11), 2000).state
        const out = applySensorEvent(s, arrival("a1", "NORTH", "V9", "FORKLIFT", 1500, 10), 2100)
        assert.equal(out.result.status, "IGNORED")
        assert.equal(out.state.queues.NORTH.length, 0)
    })

    test("arrival then clearance updates queue", () => {
        let s = startedJunction(0)
        s = applySensorEvent(s, arrival("a1", "SOUTH", "V1", "TRUCK", 1000), 1000).state
        assert.equal(s.queues.SOUTH.length, 1)
        s = applySensorEvent(s, cleared("c1", "SOUTH", "V1", 5000), 5000).state
        assert.equal(s.queues.SOUTH.length, 0)
    })

    test("unknown direction rejected", () => {
        const s = startedJunction(0)
        const out = applySensorEvent(s, arrival("x", "UP", "V1", "TRUCK", 1000), 1000)
        assert.equal(out.result.status, "REJECTED")
        assert.equal(out.state, s)
    })
})

describe("scheduler", () => {
    test("truck phase beats employee phase with same vehicle count", () => {
        let s = startedJunction(0)
        // NS green; NS has 2 employee vehicles, EW has 2 trucks
        s = applySensorEvent(s, arrival("1", "NORTH", "E1", "EMPLOYEE_VEHICLE", 1000), 1000).state
        s = applySensorEvent(s, arrival("2", "SOUTH", "E2", "EMPLOYEE_VEHICLE", 1000), 1000).state
        s = applySensorEvent(s, arrival("3", "EAST", "T1", "TRUCK", 1000), 1000).state
        s = applySensorEvent(s, arrival("4", "WEST", "T2", "TRUCK", 1000), 1000).state
        const scores = toStatusView(s, 1000).phase_scores
        const ns = scores.find(p => p.phase === "NORTH_SOUTH").score
        const ew = scores.find(p => p.phase === "EAST_WEST").score
        assert.ok(ew > ns)
        let switchedAt = null
        runFor(s, 1000, 60000, { onStep: (st, now) => { if (st.stage === "YELLOW" && switchedAt == null) switchedAt = now } })
        assert.ok(switchedAt <= 1000 + s.config.timings.greenMs + 1000, "switched at normal green end because EW scores higher")
    })

    test("no unnecessary switching when nobody waits elsewhere", () => {
        let s = startedJunction(0)
        s = applySensorEvent(s, arrival("1", "NORTH", "E1", "EMPLOYEE_VEHICLE", 1000), 1000).state
        s = runFor(s, 1000, 200000, { stepMs: 1000 })
        assert.equal(s.phase, "NORTH_SOUTH")
        assert.equal(s.stage, "GREEN")
    })

    test("starvation: busy phase cannot hold green beyond max green", () => {
        let s = startedJunction(0)
        for (let i = 0; i < 10; i++) s = applySensorEvent(s, arrival(`n${i}`, "NORTH", `T${i}`, "TRUCK", 1000), 1000).state
        s = applySensorEvent(s, arrival("w", "WEST", "E1", "EMPLOYEE_VEHICLE", 1000), 1000).state
        let switchedAt = null
        runFor(s, 1000, 100000, { onStep: (st, now) => { if (st.stage === "YELLOW" && switchedAt == null) switchedAt = now } })
        assert.ok(switchedAt != null && switchedAt - s.stageConfirmedAt <= s.config.timings.maxGreenMs + 500)
    })

    test("sensor offline gives the direction fixed-time demand", () => {
        let s = startedJunction(0)
        s = applyDeviceStatus(s, { eventId: "d1", deviceType: "SENSOR", direction: "EAST", status: "OFFLINE", sensorTime: 1000 }, 1000).state
        assert.equal(s.mode, "AUTOMATIC")
        s = runFor(s, 1000, 70000)
        assert.equal(s.lastGreenPhase, "EAST_WEST")
    })
})

describe("device failure", () => {
    test("controller OFFLINE -> FAILURE, manual refused, reset only when ONLINE", () => {
        let s = startedJunction(0)
        s = applyDeviceStatus(s, { eventId: "d1", deviceType: "CONTROLLER", direction: null, status: "OFFLINE", sensorTime: 5000 }, 5000).state
        assert.equal(s.mode, "FAILURE")
        assert.deepEqual(s.desiredSignals, { NORTH: "RED", SOUTH: "RED", EAST: "RED", WEST: "RED" })
        assert.equal(applyCommand(s, { command: "MANUAL_GREEN_REQUEST", direction: "EAST" }, 5100).result.code, 409)
        assert.equal(applyCommand(s, { command: "RESET_FAILURE" }, 5100).result.code, 409)
        s = applyDeviceStatus(s, { eventId: "d2", deviceType: "CONTROLLER", direction: null, status: "ONLINE", sensorTime: 9000 }, 9000).state
        s = ack(s, 9000)
        assert.equal(s.mode, "FAILURE", "stays in failure until operator reset")
        s = applyCommand(s, { command: "RESET_FAILURE" }, 9500).state
        assert.equal(s.mode, "AUTOMATIC")
        s = runFor(s, 9500, 15000)
        assert.equal(s.stage, "GREEN")
    })

    test("signal head failure (SIGNAL_CONTROLLER with direction) -> FAILURE", () => {
        let s = startedJunction(0)
        s = applyDeviceStatus(s, { eventId: "d1", deviceType: "SIGNAL_CONTROLLER", direction: "SOUTH", status: "OFFLINE", sensorTime: 5000 }, 5000).state
        assert.equal(s.mode, "FAILURE")
        assert.equal(s.devices.signals.SOUTH, "OFFLINE")
    })

    test("older device status event is ignored", () => {
        let s = startedJunction(0)
        s = applyDeviceStatus(s, { eventId: "d1", deviceType: "SENSOR", direction: "EAST", status: "ONLINE", sensorTime: 5000 }, 5000).state
        const out = applyDeviceStatus(s, { eventId: "d0", deviceType: "SENSOR", direction: "EAST", status: "OFFLINE", sensorTime: 4000 }, 5100)
        assert.equal(out.result.status, "IGNORED")
        assert.equal(out.state.devices.sensors.EAST, "ONLINE")
    })
})

describe("restart recovery", () => {
    test("restart during GREEN: pending abandoned, actual UNKNOWN, yellow clearance first", () => {
        let s = startedJunction(0)
        s = applySensorEvent(s, arrival("a", "EAST", "V", "TRUCK", 1000), 1000).state
        const out = recoverAfterRestart(s, 50000)
        assert.ok(Object.values(out.state.actualSignals).every(v => v === "UNKNOWN"))
        assert.equal(out.state.stage, "YELLOW")
        assert.equal(out.state.phase, "NORTH_SOUTH")
        assert.equal(out.state.queues.EAST.length, 1, "queues survive restart")
        const s2 = runFor(out.state, 50000, 60000)
        assert.equal(s2.stage, "GREEN")
    })

    test("restart while waiting for ACK abandons the pending command", () => {
        let s = makeState(0)
        s = tick(s, 0).state
        const pendingId = s.pendingCommand.commandId
        const out = recoverAfterRestart(s, 1000)
        assert.ok(out.effects.some(e => e.type === "COMMAND_STATUS" && e.commandId === pendingId && e.status === "ABANDONED"))
        assert.notEqual(out.state.pendingCommand.commandId, pendingId)
    })
})

describe("safety invariant (randomized)", () => {
    test("no conflicting GREEN is ever commanded or granted under random inputs", () => {
        let seed = 42
        const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
        const pick = (arr) => arr[Math.floor(rand() * arr.length)]
        const dirs = ["NORTH", "SOUTH", "EAST", "WEST"]
        const types = ["EMERGENCY", "TRUCK", "FORKLIFT", "EMPLOYEE_VEHICLE"]
        let s = makeState(0)
        let now = 0
        const check = (out) => {
            const st = out.state
            assert.equal(findConflict(st.config, st.desiredSignals), null, "conflicting desired signals")
            out.effects.filter(e => e.type === "SEND_COMMAND").forEach(e => {
                assert.equal(findConflict(st.config, e.command.signals), null)
                const green = dirs.filter(d => e.command.signals[d] === "GREEN")
                if (green.length && e.command.attempt === 1) {
                    dirs.filter(d => !green.includes(d)).forEach(d =>
                        assert.equal(st.actualSignals[d], "RED", `GREEN commanded while ${d} not confirmed RED`))
                }
            })
            s = st
        }
        for (let i = 0; i < 4000; i++) {
            now += Math.floor(rand() * 1500)
            const r = rand()
            if (r < 0.3) check(tick(s, now))
            else if (r < 0.5) check(applySensorEvent(s, arrival(`e${i}`, pick(dirs), `V${Math.floor(rand() * 30)}`, pick(types), now - Math.floor(rand() * 40000)), now))
            else if (r < 0.6) check(applySensorEvent(s, cleared(`c${i}`, pick(dirs), `V${Math.floor(rand() * 30)}`, now), now))
            else if (r < 0.85 && s.pendingCommand) {
                const status = rand() < 0.95 ? "ACK" : "NACK"
                const actual = rand() < 0.03 ? { [pick(dirs)]: pick(["GREEN", "RED", "YELLOW"]) } : null
                check(applyControllerEvent(s, { commandId: s.pendingCommand.commandId, status, actualSignals: actual }, now))
            } else if (r < 0.9) check(applyCommand(s, { command: pick(["MANUAL_GREEN_REQUEST", "RETURN_TO_AUTOMATIC", "RESET_FAILURE", "CLEAR_EMERGENCY"]), direction: pick(dirs) }, now))
            else if (r < 0.93) check(applyDeviceStatus(s, { eventId: `d${i}`, deviceType: pick(["CONTROLLER", "SENSOR", "SIGNAL"]), direction: pick(dirs), status: pick(["ONLINE", "ONLINE", "OFFLINE"]), sensorTime: now }, now))
            else if (r < 0.95) check(recoverAfterRestart(s, now))
            else check(tick(s, now))
        }
    })
})
