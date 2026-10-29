import { trafficService } from "../services/runtime.js"
import { handleError } from "../lib/utils.js"

// controllers only translate HTTP <-> service calls. no traffic rules in here

export const getJunctions = async (req, res) => {
    try {
        res.status(200).json(trafficService.listJunctions())
    } catch (error) {
        handleError(res, error, "getJunctions")
    }
}

export const getJunction = async (req, res) => {
    try {
        const { id: junctionId } = req.params
        res.status(200).json(trafficService.getJunction(junctionId))
    } catch (error) {
        handleError(res, error, "getJunction")
    }
}

export const createJunction = async (req, res) => {
    try {
        const status = await trafficService.createJunction(req.body)
        res.status(201).json(status)
    } catch (error) {
        handleError(res, error, "createJunction")
    }
}

export const getJunctionStatus = async (req, res) => {
    try {
        const { id: junctionId } = req.params
        res.status(200).json(trafficService.getStatus(junctionId))
    } catch (error) {
        handleError(res, error, "getJunctionStatus")
    }
}

export const sendCommand = async (req, res) => {
    try {
        const { id: junctionId } = req.params
        const result = await trafficService.executeCommand(junctionId, req.body)
        // 202: accepted, the safe transition is carried out over the next seconds
        res.status(result.status === "NO_OP" ? 200 : 202).json(result)
    } catch (error) {
        handleError(res, error, "sendCommand")
    }
}

export const getJunctionHistory = async (req, res) => {
    try {
        const { id: junctionId } = req.params
        const history = await trafficService.getHistory(junctionId, req.query)
        res.status(200).json(history)
    } catch (error) {
        handleError(res, error, "getJunctionHistory")
    }
}

export const getJunctionCommands = async (req, res) => {
    try {
        const { id: junctionId } = req.params
        const commands = await trafficService.getCommands(junctionId)
        res.status(200).json(commands)
    } catch (error) {
        handleError(res, error, "getJunctionCommands")
    }
}
