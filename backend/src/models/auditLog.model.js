import mongoose from "mongoose";

// append-only history. never updated after insert
const auditLogSchema = new mongoose.Schema({
    junctionId: {
        type: String,
        required: true,
    },
    eventType: {
        type: String,
        required: true,
    },
    direction: { type: String },
    vehicleId: { type: String },
    eventId: { type: String },        // sensor / device event id that caused it
    commandId: { type: String },      // controller command it relates to
    previousState: { type: String },
    newState: { type: String },
    message: { type: String },
    details: { type: mongoose.Schema.Types.Mixed },
    timestamp: {
        type: Date,
        required: true,
    },
},
    { versionKey: false }
);

auditLogSchema.index({ junctionId: 1, timestamp: -1 })

const AuditLog = mongoose.model("AuditLog", auditLogSchema);
export default AuditLog;
