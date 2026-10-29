import { createTrafficService } from "./traffic.service.js"
import { createMongoRepository } from "../repositories/mongo.repository.js"
import { createSimulatedController } from "../adapters/simulatedController.adapter.js"
import { assertControllerPort } from "../adapters/controllerPort.js"
import { emitJunctionUpdate, emitAuditEntry } from "../lib/socket.js"

// wiring: which adapters are plugged into the application layer.
// to use MQTT later: replace `simulator` with createMqttController({client}) here - nothing else changes
export const simulator = createSimulatedController()

export const trafficService = createTrafficService({
    repository: createMongoRepository(),
    controllerPort: assertControllerPort(simulator),
    onStatusChange: (junctionId, status) => emitJunctionUpdate(status),
    onAudit: (entry) => emitAuditEntry(entry),
})
