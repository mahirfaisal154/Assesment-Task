import { simulator } from "../services/runtime.js"
import { handleError } from "../lib/utils.js"

export const getSimulator = async (req, res) => {
    try {
        res.status(200).json({ settings: simulator.getSettings(), inbox: simulator.getInbox().slice(0, 15) })
    } catch (error) {
        handleError(res, error, "getSimulator")
    }
}

export const updateSimulator = async (req, res) => {
    try {
        const { autoAck, ackDelayMs, behavior } = req.body || {}
        const { errors, settings } = simulator.updateSettings({ autoAck, ackDelayMs, behavior })
        if (errors.length) return res.status(400).json({ message: "Invalid simulator settings", details: errors })
        console.log("Simulator settings changed:", settings)
        res.status(200).json({ settings })
    } catch (error) {
        handleError(res, error, "updateSimulator")
    }
}
