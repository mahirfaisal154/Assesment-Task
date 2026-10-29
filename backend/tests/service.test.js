import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { createTrafficService } from "../src/services/traffic.service.js"
import { createMemoryRepository } from "../src/repositories/memory.repository.js"
import { findConflict } from "../src/domain/safety.js"

process.env.NODE_ENV = "test"

// fake controller that ACKs on demand, and checks "persist before send"
const createFakeController = (repository) => {
    let listener = () => { }
    const sent = []
    return {
        sent,
        onEvent: (fn) => { listener = fn },
        sendCommand: async (command) => {
            assert.ok(repository._commands.has(command.commandId), "command must be persisted before it is sent")
            sent.push(command)
        },
        ackLast: () => {
            const c = sent[sent.length - 1]
            return listener({ command_id: c.commandId, junction_id: c.junctionId, status: "ACK" })
        },
    }
}

const setup = async (repository = createMemoryRepository()) => {
    let now = Date.parse("2026-10-05T10:00:00Z")
    const clock = () => now
    const controller = createFakeController(repository)
    const service = createTrafficService({ repository, controllerPort: controller, clock })
    await service.init({ tickMs: 0 })
    const advance = async (ms, ackEach = true) => {
        const end = now + ms
        while (now < end) {
            now += 100
            await service.tickAll()
            const st = service.getStatus("A")
            if (ackEach && st.pending_command) await service.handleControllerEvent({ command_id: st.pending_command.command_id, junction_id: "A", status: "ACK" })
        }
    }
    return { service, repository, controller, clock, advance, iso: () => new Date(now).toISOString() }
}

const sensor = (iso, over = {}) => ({
    event_id: "evt-10001", junction_id: "A", direction: "NORTH", event_type: "VEHICLE_ARRIVED",
    vehicle_id: "VH-501", vehicle_type: "TRUCK", sequence_no: 1501, timestamp: iso, ...over,
})

describe("traffic service", () => {
    test("default junction A is created and synced", async () => {
        const { service, advance } = await setup()
        await advance(3000)
        const st = service.getStatus("A")
        assert.equal(st.stage, "GREEN")
        assert.equal(st.controller_status, "ONLINE")
        assert.ok(st.signals_match)
    })

    test("duplicate event_id is applied once", async () => {
        const { service, iso } = await setup()
        const first = await service.handleSensorEvent(sensor(iso()))
        const second = await service.handleSensorEvent(sensor(iso()))
        assert.equal(first.status, "APPLIED")
        assert.equal(second.status, "DUPLICATE")
        assert.equal(service.getStatus("A").queues.NORTH, 1)
    })

    test("same event_id with different payload -> 409", async () => {
        const { service, iso } = await setup()
        await service.handleSensorEvent(sensor(iso()))
        await assert.rejects(service.handleSensorEvent(sensor(iso(), { direction: "EAST" })), e => e.status === 409)
    })

    test("validation: malformed, unknown vehicle type, unknown junction, future timestamp", async () => {
        const { service, iso } = await setup()
        await assert.rejects(service.handleSensorEvent({ junction_id: "A" }), e => e.status === 400)
        await assert.rejects(service.handleSensorEvent(sensor(iso(), { vehicle_type: "BICYCLE" })), e => e.status === 400)
        await assert.rejects(service.handleSensorEvent(sensor(iso(), { junction_id: "Z" })), e => e.status === 404)
        await assert.rejects(service.handleSensorEvent(sensor("2030-01-01T00:00:00Z")), e => e.status === 400)
        await assert.rejects(service.handleSensorEvent(sensor(iso(), { direction: "UP", event_id: "x" })), e => e.status === 400)
        await assert.rejects(service.executeCommand("A", { command: "SET_SIGNAL", direction: "EAST" }), e => e.status === 400)
        await assert.rejects(service.executeCommand("Z", { command: "RETURN_TO_AUTOMATIC" }), e => e.status === 404)
    })

    test("concurrent burst (spec scenario 9) stays consistent", async () => {
        const { service, advance, iso } = await setup()
        await advance(3000)
        const st0 = service.getStatus("A")
        const results = await Promise.allSettled([
            service.handleSensorEvent(sensor(iso(), { event_id: "c1", direction: "NORTH", vehicle_id: "TR-1", vehicle_type: "TRUCK" })),
            service.handleSensorEvent(sensor(iso(), { event_id: "c2", direction: "EAST", vehicle_id: "AMB-1", vehicle_type: "EMERGENCY", sequence_no: 1 })),
            service.executeCommand("A", { command: "MANUAL_GREEN_REQUEST", direction: "WEST" }),
            service.handleSensorEvent(sensor(iso(), { event_id: "c2", direction: "EAST", vehicle_id: "AMB-1", vehicle_type: "EMERGENCY", sequence_no: 1 })),
            service.handleControllerEvent({ command_id: st0.pending_command?.command_id || "cmd-none", junction_id: "A", status: "ACK" }),
        ])
        assert.equal(results[0].value.status, "APPLIED")
        assert.equal(results[1].value.status, "APPLIED")
        // emergency was processed first (serialized order), so the manual request is refused
        assert.equal(results[2].status, "rejected")
        assert.equal(results[2].reason.status, 409)
        assert.equal(results[3].value.status, "DUPLICATE")
        const st = service.getStatus("A")
        assert.equal(st.mode, "EMERGENCY")
        assert.deepEqual(st.queues, { NORTH: 1, SOUTH: 0, EAST: 1, WEST: 0 })
        assert.equal(findConflict({ directions: ["NORTH", "SOUTH", "EAST", "WEST"], phases: st.config.phases }, st.desired_signals), null)
        await advance(10000)
        assert.equal(service.getStatus("A").phase, "EAST_WEST")
    })

    test("restart: state + history survive, pending command abandoned, physical state not trusted", async () => {
        const repository = createMemoryRepository()
        const first = await setup(repository)
        await first.advance(3000)
        await first.service.handleSensorEvent(sensor(first.iso(), { event_id: "r1", direction: "EAST", vehicle_id: "F-1", vehicle_type: "FORKLIFT" }))
        await first.service.executeCommand("A", { command: "MANUAL_GREEN_REQUEST", direction: "EAST", operator: "bob" })
        first.service.stop()

        const second = await setup(repository)
        const st = second.service.getStatus("A")
        assert.equal(st.mode, "MANUAL")
        assert.equal(st.queues.EAST, 1)
        assert.equal(st.controller_status, "UNKNOWN")
        assert.ok(Object.values(st.actual_signals).every(v => v === "UNKNOWN"))
        const history = await second.service.getHistory("A", { limit: 500 })
        assert.ok(history.some(h => h.event_type === "SYSTEM_RECOVERY"))
        assert.ok(history.some(h => h.event_type === "MANUAL_OVERRIDE"))
        const abandoned = [...repository._commands.values()].filter(c => c.status === "ABANDONED")
        assert.equal(abandoned.length, 1)
        // duplicate detection also survives the restart
        const dup = await second.service.handleSensorEvent(sensor(first.iso(), { event_id: "r1", direction: "EAST", vehicle_id: "F-1", vehicle_type: "FORKLIFT" }))
        assert.equal(dup.status, "DUPLICATE")
    })

    test("POST junction: second junction runs on the same engine, bad config rejected", async () => {
        const { service } = await setup()
        const b = await service.createJunction({ junction_id: "B", name: "Junction B" })
        assert.equal(b.junction_id, "B")
        await assert.rejects(service.createJunction({ junction_id: "B" }), e => e.status === 409)
        await assert.rejects(service.createJunction({ junction_id: "C", phases: [{ name: "ALL", directions: ["NORTH", "SOUTH", "EAST", "WEST"] }] }), e => e.status === 400)
        assert.equal(service.listJunctions().length, 2)
    })
})
