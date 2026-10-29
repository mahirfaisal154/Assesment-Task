import express from "express"
import { getSimulator, updateSimulator } from "../controllers/simulator.controller.js"

const router = express.Router()

router.get("/", getSimulator)
router.put("/", updateSimulator)

export default router;
