import mongoose from "mongoose";

// One document per junction = configuration + the full traffic-control state.
// Times are stored as epoch milliseconds (Number) because the domain works in ms.
const junctionSchema = new mongoose.Schema({
    junctionId: {
        type: String,
        required: true,
        unique: true,
    },
    name: {
        type: String,
        required: true,
    },
    // directions, phases, timings, priorities, scoring
    config: {
        type: mongoose.Schema.Types.Mixed,
        required: true,
    },
    mode: {
        type: String,
        enum: ["AUTOMATIC", "MANUAL", "EMERGENCY", "FAILURE"],
        default: "AUTOMATIC",
    },
    stage: {
        type: String,
        enum: ["GREEN", "YELLOW", "ALL_RED"],
        default: "ALL_RED",
    },
    phase: { type: String, default: null },
    targetPhase: { type: String, default: null },
    lastGreenPhase: { type: String, default: null },
    stageStartedAt: { type: Number },
    stageConfirmedAt: { type: Number, default: null },

    desiredSignals: { type: mongoose.Schema.Types.Mixed },   // what the backend wants
    actualSignals: { type: mongoose.Schema.Types.Mixed },    // what the controller confirmed
    controllerStatus: { type: String, default: "UNKNOWN" },
    devices: { type: mongoose.Schema.Types.Mixed },          // signal heads + sensors health

    queues: { type: mongoose.Schema.Types.Mixed },           // {NORTH:[{vehicleId,vehicleType,arrivedAt,...}]}
    lastSequence: { type: mongoose.Schema.Types.Mixed },
    clearedVehicles: { type: [mongoose.Schema.Types.Mixed], default: [] },
    phaseLastServedAt: { type: mongoose.Schema.Types.Mixed },

    emergency: { type: mongoose.Schema.Types.Mixed },        // {requests:[...]}
    manual: { type: mongoose.Schema.Types.Mixed, default: null },
    failure: { type: mongoose.Schema.Types.Mixed, default: null },
    pendingCommand: { type: mongoose.Schema.Types.Mixed, default: null },
    lastCommandResult: { type: mongoose.Schema.Types.Mixed, default: null },
    recentCommandIds: { type: [String], default: [] },
    commandSeq: { type: Number, default: 0 },

    // optimistic concurrency guard - every save must match the version it was loaded with
    version: { type: Number, default: 0 },
    createdAt: { type: Number },
},
    { minimize: false, timestamps: { createdAt: "createdOn", updatedAt: "updatedOn" } }
);

const Junction = mongoose.model("Junction", junctionSchema);
export default Junction;
