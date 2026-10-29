// logs every API request with status + duration (useful during the demo)
export const requestLogger = (req, res, next) => {
    const start = Date.now()
    res.on("finish", () => {
        if (req.method === "GET" && res.statusCode < 400) return //polling is noisy
        console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`)
    })
    next()
}

// malformed JSON body -> 400 instead of express' default html error
export const jsonErrorHandler = (error, req, res, next) => {
    if (error.type === "entity.parse.failed") {
        return res.status(400).json({ message: "Malformed JSON body" })
    }
    if (error.type === "entity.too.large") {
        return res.status(413).json({ message: "Request body too large" })
    }
    console.error("Unhandled error:", error)
    res.status(500).json({ message: "Internal server error" })
}

export const notFound = (req, res) => {
    res.status(404).json({ message: `Route ${req.method} ${req.originalUrl} not found` })
}
