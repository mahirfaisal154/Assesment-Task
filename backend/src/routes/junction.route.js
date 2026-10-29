import express from "express"
import {
    getJunctions, getJunction, createJunction, getJunctionStatus,
    sendCommand, getJunctionHistory, getJunctionCommands,
} from "../controllers/junction.controller.js"

const router = express.Router()

router.get("/", getJunctions)
router.post("/", createJunction)
router.get("/:id", getJunction)
router.get("/:id/status", getJunctionStatus)
router.post("/:id/commands", sendCommand)
router.get("/:id/history", getJunctionHistory)
router.get("/:id/commands", getJunctionCommands)

export default router;
