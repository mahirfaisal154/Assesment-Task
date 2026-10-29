import mongoose from "mongoose";

// every command sent to the physical controller + what happened to it
const controllerCommandSchema = new mongoose.Schema({
    commandId: {
        type: String,
        required: true,
        unique: true,
    },
    junctionId: { type: String, required: true },
    signals: { type: mongoose.Schema.Types.Mixed, required: true },  // requested state for every direction
    purpose: { type: String },
    attempts: { type: Number, default: 1 },
    status: {
        type: String,
        enum: ["PENDING", "ACKED", "NACK", "FAILED", "TIMEOUT", "MISMATCH", "SUPERSEDED", "ABANDONED"],
        default: "PENDING",
    },
    lastSentAt: { type: Date },
    resolvedAt: { type: Date },
},
    { timestamps: true }
);

controllerCommandSchema.index({ junctionId: 1, createdAt: -1 })

const ControllerCommand = mongoose.model("ControllerCommand", controllerCommandSchema);
export default ControllerCommand;
