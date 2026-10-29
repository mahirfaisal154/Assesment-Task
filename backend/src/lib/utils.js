import crypto from "crypto"

// small error helper so services can say "this is a 404" without knowing about express
export const httpError = (status, message, details) => {
    const error = new Error(message)
    error.status = status
    if (details) error.details = details
    return error
}

// every controller catch block ends up here
export const handleError = (res, error, label) => {
    if (error.status) {
        return res.status(error.status).json({ message: error.message, details: error.details })
    }
    console.error(`Error in ${label}:`, error)
    res.status(500).json({ message: "Internal server error" })
}

// tiny logger - prefix + timestamp so the terminal is readable during the demo
export const log = (level, message, meta) => {
    if (process.env.NODE_ENV === "test" && level === "INFO") return
    const line = `[${new Date().toISOString()}] [${level}] ${message}`
    if (level === "ERROR") console.error(line, meta ?? "")
    else if (level === "WARN") console.warn(line, meta ?? "")
    else console.log(line, meta ? JSON.stringify(meta) : "")
}

// used to detect "same event_id but different payload"
export const hashPayload = (obj) => crypto.createHash("sha1").update(JSON.stringify(obj)).digest("hex")
