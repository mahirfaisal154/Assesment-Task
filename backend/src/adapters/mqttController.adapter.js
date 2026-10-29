// MQTT controller adapter - NOT wired by default (REST simulator is used for the assessment).
// It shows that MQTT only replaces this file: same contract as the simulator, the engine is untouched.
//
// Usage idea (in services/runtime.js):
//   import mqtt from "mqtt"
//   const client = mqtt.connect(process.env.MQTT_URL)
//   const controllerPort = createMqttController({ client })
//
// Topics:
//   factory/junctions/{junctionId}/commands   backend -> controller   (QoS 1)
//   factory/junctions/{junctionId}/acks       controller -> backend   (QoS 1)
//   factory/junctions/{junctionId}/status     controller -> backend   (device status, LWT = OFFLINE)

export const createMqttController = ({ client, topicPrefix = "factory/junctions", onDeviceStatus }) => {
    let listener = () => { }

    client.subscribe(`${topicPrefix}/+/acks`, { qos: 1 })
    client.subscribe(`${topicPrefix}/+/status`, { qos: 1 })

    client.on("message", (topic, payload) => {
        let body
        try {
            body = JSON.parse(payload.toString())
        } catch (error) {
            console.error("Invalid MQTT payload on", topic)
            return
        }
        if (topic.endsWith("/acks")) listener(body)
        else if (topic.endsWith("/status") && onDeviceStatus) onDeviceStatus(body)
    })

    return {
        name: "mqtt",
        onEvent: (handler) => {
            listener = handler
        },
        sendCommand: async (command) => {
            // QoS 1 = at-least-once, so controller must treat command_id idempotently (same as our retries)
            client.publish(`${topicPrefix}/${command.junctionId}/commands`, JSON.stringify({
                command_id: command.commandId,
                junction_id: command.junctionId,
                requested_signals: command.signals,
                attempt: command.attempt,
            }), { qos: 1 })
        },
    }
}
