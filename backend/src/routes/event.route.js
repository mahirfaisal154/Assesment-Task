import express from "express"
import { postSensorEvent, postDeviceEvent, postControllerEvent } from "../controllers/event.controller.js"

// mounted at /api  ->  /api/sensor-events, /api/device-events, /api/controller-events
const router = express.Router()

router.post("/sensor-events", postSensorEvent)
router.post("/device-events", postDeviceEvent)
router.post("/controller-events", postControllerEvent)

export default router;
