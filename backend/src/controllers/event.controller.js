import { trafficService } from "../services/runtime.js"
import { handleError } from "../lib/utils.js"

// sensor events: 201 when state changed, 200 for duplicates / ignored (idempotent replay)
export const postSensorEvent = async (req, res) => {
    try {
        const result = await trafficService.handleSensorEvent(req.body)
        res.status(result.status === "APPLIED" ? 201 : 200).json(result)
    } catch (error) {
        handleError(res, error, "postSensorEvent")
    }
}

// device status (controller / signal head / sensor health)
export const postDeviceEvent = async (req, res) => {
    try {
        const result = await trafficService.handleDeviceEvent(req.body)
        res.status(result.status === "APPLIED" ? 201 : 200).json(result)
    } catch (error) {
        handleError(res, error, "postDeviceEvent")
    }
}

// controller acknowledgements (simulated physical controller responses)
export const postControllerEvent = async (req, res) => {
    try {
        const result = await trafficService.handleControllerEvent(req.body)
        res.status(200).json(result)
    } catch (error) {
        handleError(res, error, "postControllerEvent")
    }
}
