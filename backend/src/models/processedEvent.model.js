import mongoose from "mongoose";

// idempotency table: one row per event_id that already changed state
const processedEventSchema = new mongoose.Schema({
    eventId: {
        type: String,
        required: true,
        unique: true,
    },
    junctionId: { type: String, required: true },
    kind: { type: String, enum: ["SENSOR", "DEVICE"], required: true },
    payloadHash: { type: String, required: true },   // same id + different payload -> 409
    result: { type: String },
    processedAt: { type: Date, default: Date.now },
},
    { versionKey: false }
);

// keep 7 days of ids - long enough for any sensor retry window
processedEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 })

const ProcessedEvent = mongoose.model("ProcessedEvent", processedEventSchema);
export default ProcessedEvent;
