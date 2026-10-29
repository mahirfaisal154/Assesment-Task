import express from "express"
import dotenv from "dotenv"
import cors from "cors"
import path from "path"
import { fileURLToPath } from "url"
import { connectDB } from "./lib/db.js"
import { app, server } from "./lib/socket.js"
import junctionroutes from "./routes/junction.route.js"
import eventroutes from "./routes/event.route.js"
import simulatorroutes from "./routes/simulator.route.js"
import { requestLogger, jsonErrorHandler, notFound } from "./middleware/error.middleware.js"
import { trafficService } from "./services/runtime.js"

dotenv.config()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

app.use(express.json({ limit: "100kb" }))
app.use(cors({
    origin: ["http://localhost:5173", "http://localhost:5174"],
}));
app.use(requestLogger)

app.get("/api/health", (req, res) => res.status(200).json({ status: "ok", time: new Date().toISOString() }))
app.use("/api/junctions", junctionroutes)
app.use("/api/simulator", simulatorroutes)
app.use("/api", eventroutes)
app.use("/api", notFound)

if (process.env.NODE_ENV === "production") {
    app.use(express.static(path.join(__dirname, "../../frontend/dist")))
    app.get("/{*splat}", (req, res) => {
        res.sendFile(path.join(__dirname, "../../frontend/dist", "index.html"))
    })
}
app.use(jsonErrorHandler)

const PORT = process.env.PORT || 3010
server.listen(PORT, async () => {
    await connectDB()
    //load persisted junctions, run restart recovery, start the engine ticker
    await trafficService.init({ tickMs: Number(process.env.TICK_MS) || 500 })

    console.log(`Server is running on port ${PORT}`)
})

const shutdown = () => {
    trafficService.stop()
    server.close(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
