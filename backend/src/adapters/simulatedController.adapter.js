import { log } from "../lib/utils.js"

// Simulated physical controller (no hardware needed).
// behavior:
//   NORMAL   - ACK with the requested signals after ackDelayMs
//   NO_ACK   - swallow commands (controller dead / network down) -> backend timeout + retry + FAILURE
//   NACK     - reject every command
//   MISMATCH - ACK but report a different actual state for one direction
// autoAck=false -> nothing is answered automatically, the evaluator ACKs from the dashboard
// (POST /api/controller-events)

const BEHAVIORS = ["NORMAL", "NO_ACK", "NACK", "MISMATCH"]

export const createSimulatedController = (initial = {}) => {
    let listener = () => { }
    const settings = { autoAck: true, ackDelayMs: 400, behavior: "NORMAL", ...initial }
    const inbox = [] // last commands received, newest first

    const buildResponse = (command) => {
        const base = { command_id: command.commandId, junction_id: command.junctionId }
        if (settings.behavior === "NACK") return { ...base, status: "NACK", reason: "simulated controller rejected command" }
        if (settings.behavior === "MISMATCH") {
            const actual = { ...command.signals }
            const [dir] = Object.keys(actual)
            actual[dir] = actual[dir] === "RED" ? "YELLOW" : "RED" // stuck lamp
            return { ...base, status: "ACK", actual_signals: actual }
        }
        return { ...base, status: "ACK", actual_signals: command.signals }
    }

    return {
        name: "rest-simulator",

        onEvent: (handler) => {
            listener = handler
        },

        sendCommand: async (command) => {
            inbox.unshift({ ...command, receivedAt: new Date().toISOString() })
            if (inbox.length > 50) inbox.pop()
            log("INFO", `[simulator] received ${command.commandId} attempt ${command.attempt}`, command.signals)
            if (!settings.autoAck || settings.behavior === "NO_ACK") return
            setTimeout(() => listener(buildResponse(command)), settings.ackDelayMs)
        },

        getSettings: () => ({ ...settings, behaviors: BEHAVIORS }),

        updateSettings: (patch = {}) => {
            const errors = []
            if (patch.autoAck != null && typeof patch.autoAck !== "boolean") errors.push("autoAck must be boolean")
            if (patch.ackDelayMs != null && !(Number.isFinite(patch.ackDelayMs) && patch.ackDelayMs >= 0 && patch.ackDelayMs <= 60000)) errors.push("ackDelayMs must be 0-60000")
            if (patch.behavior != null && !BEHAVIORS.includes(patch.behavior)) errors.push(`behavior must be one of ${BEHAVIORS.join(", ")}`)
            if (errors.length) return { errors }
            if (patch.autoAck != null) settings.autoAck = patch.autoAck
            if (patch.ackDelayMs != null) settings.ackDelayMs = patch.ackDelayMs
            if (patch.behavior != null) settings.behavior = patch.behavior
            return { errors, settings: { ...settings, behaviors: BEHAVIORS } }
        },

        getInbox: () => [...inbox],
    }
}
