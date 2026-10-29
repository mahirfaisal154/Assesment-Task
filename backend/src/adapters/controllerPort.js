// Controller Port - the ONLY thing the application layer knows about physical controllers.
//
// An adapter must provide:
//   name                      string
//   sendCommand(command)      async; command = {commandId, junctionId, signals:{DIR:STATE}, purpose, attempt}
//                             resolving means "handed to transport", NOT "executed".
//                             execution is only known when an ACK comes back.
//   onEvent(handler)          register handler(rawAck) for controller responses
//                             rawAck = {command_id, junction_id, status:"ACK"|"NACK"|"FAILED", actual_signals?}
//
// Implementations:
//   simulatedController.adapter.js  - in-process REST simulator (used by default)
//   mqttController.adapter.js       - sketch of the MQTT version (same contract)

export const assertControllerPort = (port) => {
    ["sendCommand", "onEvent"].forEach(fn => {
        if (typeof port?.[fn] !== "function") throw new Error(`Controller adapter is missing ${fn}()`)
    })
    return port
}
