import { Server } from "socket.io"
import http from "http"
import express from "express"

const app = express()
const server = http.createServer(app)

const io = new Server(server, {
    cors: {
        origin: ["http://localhost:5173", "http://localhost:5174"],
    },
});

// dashboard is read-only over the socket: it only receives pushes.
// all actions still go through the REST API (commands / events)
io.on("connection", (socket) => {
    console.log("Dashboard connected", socket.id);

    socket.on("disconnect", () => {
        console.log("Dashboard disconnected", socket.id);
    });
});

export const emitJunctionUpdate = (status) => {
    io.emit("junctionUpdate", status)
}

export const emitAuditEntry = (entry) => {
    io.emit("auditEntry", entry)
}

export { io, app, server }
