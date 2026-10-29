# Factory Traffic Management System

Backend Developer Intern Assessment V2 (CSI Smart Tech).

This is a small event-driven control system for internal factory roads. It receives vehicle-detection events, keeps per-direction queues, and runs a safe signal state machine for Junction A (and any other junction created through the API). It handles emergencies, manual override and device failures. It separates the signal state the backend **wants** from the state the physical controller has **confirmed**, survives restarts, and comes with a React dashboard for demonstrations.

| Part | Tech |
|---|---|
| Backend | Node.js 20+ (tested on 24), Express 5, Mongoose 9 / MongoDB, Socket.IO |
| Frontend | React 19 + Vite, Zustand, Tailwind 3 + daisyUI, axios, socket.io-client |
| Tests | Node built-in test runner (`node --test`), no database needed |
| IoT | REST simulator (in-process), with an MQTT adapter sketch behind the same port |

A detailed walkthrough of the internals (event flows, state machine, scheduler and traces) is in [docs/PROJECT_GUIDE.md](docs/PROJECT_GUIDE.md).

---

## 1. Setup and run

**Prerequisites:** Node.js 20 or newer and a running MongoDB (local `mongodb://127.0.0.1:27017` is fine; a replica set is not needed).

```bash
# backend
cd backend
cp .env.example .env          # PORT=3010, MONGODB_URI=..., TICK_MS=500
npm install
npm run dev                   # or: npm start

# frontend (second terminal)
cd frontend
npm install
npm run dev                   # http://localhost:5173

# tests
cd backend && npm test
```

On the first start the backend creates **Junction A** (N/S and E/W phases) and syncs it with the simulated controller (ALL RED, then the first GREEN).

Production style (single server): `npm run build` at the root, then `NODE_ENV=production npm start`. Express serves `frontend/dist`.

To reset all data, drop the `factory-traffic` database.

---

## 2. Project structure

```
backend/
  src/
    index.js                      express app, routes, startup (connectDB -> trafficService.init)
    domain/                       PURE traffic logic - no express / mongo / socket imports
      constants.js                signal states, stages, modes, audit event names
      junctionConfig.js           directions, phases, timings, priorities (+ validation)
      safety.js                   conflict rules, "confirmed RED" guard, assertSafeSignals
      scheduler.js                scoring + automatic phase decisions
      junctionEngine.js           the state machine: (state, input, now) -> {state, effects, result}
    services/
      traffic.service.js          application layer: lock, idempotency, persist, run effects, ticker, recovery
      runtime.js                  wiring: which repository / controller adapter is used
    repositories/
      mongo.repository.js         persistence port implemented with Mongoose
      memory.repository.js        same interface, in memory (tests)
    adapters/
      controllerPort.js           contract every controller adapter implements
      simulatedController.adapter.js   REST simulator (default)
      mqttController.adapter.js   MQTT version of the same contract (not wired)
    models/                       Mongoose schemas = database schema
      junction.model.js  auditLog.model.js  processedEvent.model.js  controllerCommand.model.js
    controllers/  routes/  middleware/  lib/   (HTTP layer, validators, mutex, socket, db)
  tests/
    engine.test.js                state machine + scheduler + randomized safety test
    service.test.js               idempotency, validation, concurrency, restart, multi-junction
frontend/
  constants/index.js
  src/ App.jsx main.jsx  lib/  store/useJunctionStore.js  pages/  components/
docs/
  API.md                          API documentation
  postman_collection.json
```

---

## 3. Architecture and major decisions

```
 REST controllers ─┐        Socket.IO (push only)
 Simulator ACKs  ──┼──>  traffic.service (application layer)
 (MQTT later)    ──┘        │ per-junction lock, validation, idempotency,
                            │ persist-then-send, effects, timer ticks, restart recovery
                            ▼
                     junctionEngine (pure domain)  ── scheduler, safety
                            │ returns effects: AUDIT / SEND_COMMAND / COMMAND_STATUS
                            ▼
              repository port          controller port
              (Mongo / memory)         (REST simulator / MQTT adapter)
```

1. **A pure, deterministic domain engine.** Every input is a function `(state, input, now) -> { state, effects, result }`. The engine never touches HTTP, Mongo, MQTT, timers or `Date.now()`. That is why the whole state machine can be tested with a fake clock, including a 4,000-step randomized safety test.
2. **Effects instead of side effects.** The engine *describes* what should happen (write audit, send command X). The service performs it **after** the new state has been persisted. A command therefore never leaves the system unless the state that caused it is stored. If the database write fails, nothing is sent and the caller gets a 500.
3. **Ports and adapters.** The service only knows `repository.*` and `controllerPort.sendCommand/onEvent`. Switching to MQTT means replacing one line in `services/runtime.js` (see `mqttController.adapter.js`). Switching to Postgres means writing another repository with the same methods.
4. **Junction configuration is data.** Directions, phases, timings and priority weights live in the junction document. Junction B, C or D (or a 3-phase junction) is created with `POST /api/junctions` and runs on the same engine.
5. **The timer is a tick, not a sleep.** A 500 ms ticker calls `tick()` for each junction under its lock. Nothing in a request handler sleeps. Stage deadlines are computed from timestamps, so a late tick never shortens a YELLOW or ALL RED.
6. **Junction-level commands.** One command carries the full signal map for all directions (for example N=GREEN, S=GREEN, E=RED, W=RED) instead of one command per direction. With per-direction commands, a partially executed set (EAST GREEN acknowledged, NORTH RED lost) could create a conflict. See the issues section.

---

## 4. Traffic-state transitions

### Signal stages (per junction)

```
            ┌──────────── ACK ───────────┐
            ▼                            │
   ALL_RED (sync) ──allRed 2s + target──> GREEN(phase P)
      ▲                                     │ scheduler / emergency / manual chooses Q ≠ P
      │                                     ▼
      └────── yellow 5s after ACK ─── YELLOW(phase P)
```

* Each stage is entered by **issuing a command**. The stage timer only starts when the controller **ACKs** it (`stageConfirmedAt`). Without an ACK the engine does not move on.
* GREEN for phase Q is only commanded if every direction **outside** Q is *confirmed* RED by the controller (`conflictingDirectionsConfirmedRed`). Otherwise it holds (`SAFETY_HOLD`) and re-sends ALL RED.
* Every outgoing command passes `assertSafeSignals`: all non-RED directions must belong to one phase. YELLOW counts as permissive.
* GREEN never goes directly to another GREEN. Emergency and manual requests only change the **target**: YELLOW and ALL RED always run in full.

### Operating modes (explicit priority)

```
FAILURE  >  EMERGENCY  >  MANUAL  >  AUTOMATIC
```
The mode is derived after every input: `failure ? FAILURE : emergencyRequests ? EMERGENCY : manual ? MANUAL : AUTOMATIC`. Every change is written to history as `MODE_CHANGED`. Manual state is kept while an emergency runs, so the junction goes back to MANUAL afterwards if the override has not expired.

| Mode | What GREEN serves | Notes |
|---|---|---|
| AUTOMATIC | scheduler decision | min/normal/max green, starvation protection |
| MANUAL | phase containing the requested direction | holds until expiry or `RETURN_TO_AUTOMATIC` |
| EMERGENCY | phase of the oldest active emergency request | preempts immediately (min green ignored); yellow and all-red are kept |
| FAILURE | nothing: ALL RED is commanded and re-sent every 5 s until confirmed | manual commands refused; leaving requires operator `RESET_FAILURE` |

---

## 5. Traffic-control (scheduling) algorithm

**Phase score:**

```
score(phase) = Σ over vehicles queued in the phase's directions:
                   priorityWeight(type) + min(waitSeconds / 15, 20)
             + 3 for each direction whose sensor is not ONLINE (fixed-time fallback)

priorityWeight: EMERGENCY 10, TRUCK 4, FORKLIFT 3, EMPLOYEE_VEHICLE 1   (configurable per junction)
```

So more vehicles score higher, heavier or more important vehicles score higher, and every vehicle gains one point per 15 s of waiting (capped at 20).

**While a phase is GREEN (AUTOMATIC):**

1. No other phase has demand → **keep green**. No unnecessary switching; the junction rests on the current phase.
2. Green has run for less than **10 s** (min green) → keep.
3. A vehicle in another phase has waited **90 s or more** → switch (**starvation protection**).
4. The current phase has no demand → switch.
5. Green has run for **60 s** (max green) → switch.
6. Green has run for **30 s** and the best other phase's score ≥ the current score → switch.
7. Otherwise keep green, so a busier phase can extend up to max green.

**At the end of ALL RED:** pick the phase with the highest score. A starving phase wins first, and ties go to the planned target and then round-robin. With no demand anywhere, rotate.

Emergencies bypass the score entirely (see section 7). Waiting time is measured from **server receive time** (see section 6).

---

## 6. Event handling: duplicates, delays, ordering, timestamps

| Concern | Decision |
|---|---|
| **Duplicate / repeated submission** | `event_id` is the idempotency key, stored in `processedevents` (unique index, 7-day TTL). Same id with the same payload → `200 DUPLICATE`, no state change, audited. Same id with a different payload → `409`. |
| **Second layer** | Queues are *sets of vehicle_ids*, not counters. Even if an event were applied twice (for example a crash between the state save and recording the event id), `ARRIVED` for an already-queued vehicle is ignored and `CLEARED` for an unknown vehicle is a no-op. Queue length can never be negative. |
| **sequence_no** | Per junction+direction sensor counter. An event with `sequence_no` ≤ the last one seen is flagged `outOfOrder` but still evaluated on its own merits (it is often a legitimately delayed event). Optional. |
| **Out-of-order ARRIVED / CLEARED** | `CLEARED` without an arrival leaves a **tombstone** (vehicle id, seq, sensor time). A later `ARRIVED` for that vehicle with an older seq (or older sensor timestamp) is ignored, so the vehicle does not end up queued forever. |
| **Timestamps** | **Server receive time is authoritative** for scheduling and waiting time (sensor clocks drift; one clock for all decisions). The sensor timestamp is stored for audit and used to (a) reject events more than 60 s in the future, (b) flag events delayed more than 30 s, (c) refuse emergency preemption when the event is more than 30 s old (stale emergency), and (d) order device status events. |
| **Invalid input** | Missing fields, malformed JSON, unknown vehicle type, event type or direction → `400`. Unknown junction → `404`. Rejections are written to the audit log under the junction id given (dead-letter style). |
| **Vehicle seen at another direction** | Moved: removed from the old queue and added to the new one (`VEHICLE_MOVED`). |

---

## 7. Emergency policy

* An `EMERGENCY` vehicle arrival (fresh, not stale) creates an **emergency request** `{vehicle, direction, phase, detectedAt, expiresAt}` and switches the mode to EMERGENCY.
* **Preemption:** if a conflicting phase is GREEN, YELLOW starts **at once**, without waiting for min green. Then ALL RED, then the emergency phase GREEN. EAST never becomes GREEN immediately. If the junction is already in YELLOW or ALL RED, the target is just changed.
* **Hold:** the emergency phase stays green (no max green) until the request ends.
* **Multiple / conflicting emergencies:** first come, first served by server detection time. Requests on the same phase are served together. A conflicting request waits until the first one clears, and the dashboard shows it as queued.
* **Repeated events** for the same vehicle refresh the expiry and do not create a second request.
* **Completion:** a `VEHICLE_CLEARED` for that vehicle, the operator command `CLEAR_EMERGENCY`, or a **2-minute timeout** (`EMERGENCY_TIMEOUT` in history) as protection against a lost clear event.
* **Emergency vs manual:** emergency wins. New manual requests are refused with `409` while it is active, and an existing manual override resumes afterwards.
* **Emergency during FAILURE:** the signals are not trustworthy, so the junction stays ALL RED and raises a critical alert ("direct traffic manually"). The request is kept and served once the failure is reset.

---

## 8. Manual control policy

* `MANUAL_GREEN_REQUEST {direction}` → the junction serves the phase containing that direction through the normal safe sequence. The response includes `plannedSequence`, for example `["NORTH_SOUTH YELLOW","ALL RED","EAST_WEST GREEN"]`.
* **Duration:** default 10 min, configurable per request from 10 s to 60 min, then it **expires automatically** (`MANUAL_EXPIRED`). Because of this, an administrator who disconnects can never leave the junction stuck in manual. No session tracking is needed.
* **Two administrators:** all commands for a junction are serialized. The last accepted command wins, and every command is audited with its `operator` and the override it replaced. Clients that want stricter behaviour can send `expected_version` and get `409` if the junction changed (optimistic concurrency).
* Manual is refused in EMERGENCY and FAILURE (409 with a reason). `RETURN_TO_AUTOMATIC` when not in manual returns `200 NO_OP`.

---

## 9. Controller communication and failure handling

Desired state (`desired_signals`) and confirmed state (`actual_signals`, which can be `UNKNOWN`) are stored separately and both are shown on the dashboard.

| Situation | Behaviour |
|---|---|
| **ACK received** | Actual state updated (ACK without `actual_signals` = "applied as requested"), `SIGNAL_CHANGED` per direction, the stage timer starts. |
| **ACK delayed** | The engine simply waits. Nothing advances on an unconfirmed command. |
| **ACK never received** | After 4 s the **same `command_id`** is re-sent (the controller must treat it idempotently), up to 2 retries. Then `CONTROLLER_TIMEOUT`: actual = UNKNOWN and the junction enters **FAILURE**. |
| **Duplicate ACK** | Ignored (`DUPLICATE_ACK`), using the recent confirmed command ids. |
| **ACK for an unknown or superseded command** | Ignored (`STALE_ACK`). A late ACK cannot be trusted because later commands may already have been executed. |
| **NACK / FAILED** | Actual = UNKNOWN (or what was reported), then FAILURE. |
| **ACK with a different actual state** | `STATE_MISMATCH` → FAILURE. If the reported state itself conflicts → `CONFLICT_DETECTED` → FAILURE. |
| **Controller OFFLINE / UNKNOWN** | FAILURE, actual = UNKNOWN. ALL RED is re-sent every 5 s until confirmed. |
| **Signal head OFFLINE / DEGRADED** | FAILURE: a dark signal head at a junction is unsafe. |
| **Sensor OFFLINE** | *Not* a failure. The direction gets fixed-time fallback demand so it is still served regularly, and a warning is shown. |
| **Controller reconnects (ONLINE)** | The pending command is re-sent at once to resync. The junction **stays in FAILURE until an operator sends `RESET_FAILURE`**, which is refused while the controller is offline or a signal head is unhealthy. After a reset, GREEN is only given once ALL RED is confirmed again. |
| **Backend restarts with a pending command** | See section 10. |
| **Transport error while sending** | Logged. The timeout and retry path handles it, exactly like a lost message. |

FAILURE is "sticky", meaning it needs an operator reset rather than auto-recovering. That is deliberate: a controller that flaps between ONLINE and OFFLINE would otherwise keep switching the junction in and out of normal operation.

---

## 10. Persistence and restart recovery

**Collections**

| Collection | Content |
|---|---|
| `junctions` | config + full control state: mode, stage, phase, target, desired/actual signals, controller and device health, queues (vehicle lists), sequence and tombstones, emergency requests, manual override, failure, pending command, command counter, `version` |
| `auditlogs` | append-only history (≈40 event types), indexed by junction + time |
| `processedevents` | idempotency keys `event_id` → payload hash + result (TTL 7 days) |
| `controllercommands` | every command with attempts and final status (PENDING/ACKED/NACK/TIMEOUT/MISMATCH/SUPERSEDED/ABANDONED) |

All times are stored as absolute epoch milliseconds, so expiries (manual, emergency) keep counting across a restart.

**Persisted vs reconstructed:** everything above is persisted after every state change (optimistic `version` check). What is **not trusted after a restart**: the physical signal state, the controller status and any pending command. Timers are not restored either; the current stage is restarted.

**Recovery on startup** (`recoverAfterRestart`):
1. Audit `SYSTEM_RECOVERY`. The pending command is marked `ABANDONED`, because an ACK for it would no longer be accepted.
2. `actual_signals` = all UNKNOWN, controller = UNKNOWN.
3. If the junction was in **GREEN or YELLOW** (lamps may physically still show GREEN), command **YELLOW for that phase** first, then ALL RED. Otherwise command ALL RED.
4. GREEN only follows after ALL RED is **confirmed**. Queues, mode, manual override and emergency requests continue as they were. FAILURE stays FAILURE.

Example: a restart in the middle of `GREEN -> YELLOW -> ALL RED -> GREEN` (say during ALL RED, waiting for an ACK). The old command is abandoned, a new ALL RED is sent, its ACK is awaited, then the clearance runs and the planned target gets GREEN.

---

## 11. Concurrency strategy

**Serialized per-junction processing** (`lib/keyedMutex.js`): every input for a junction (sensor event, device event, ACK, command, timer tick) is chained on one promise per junction. Each one reads state, runs the pure engine, persists and runs effects before the next input starts. Different junctions run in parallel. Two inputs can therefore never act on the same snapshot, and the result is deterministic for a given arrival order.

The **spec's concurrent scenario** (truck at 0 ms, EAST emergency at 4 ms, WEST manual at 8 ms, duplicate emergency at 12 ms, ACK at 17 ms) has a test (`service.test.js`). The truck is queued, the emergency preempts, the manual request gets `409` (emergency active), the duplicate gets `DUPLICATE`, and the ACK is applied or ignored. There are never conflicting greens.

As defence in depth for a future multi-instance deployment, every save is conditional on the `version` it was loaded with (`findOneAndUpdate({junctionId, version})`). A lost race fails loudly instead of overwriting. Running several instances properly would also need junction ownership (see the next-steps section).

---

## 12. Dashboard

* **Overview** (`/`): totals, plus one card per junction with a mini intersection (confirmed lamps), mode, phase, controller status, queues and emergency/manual/alert badges. Junctions can be created there.
* **Junction detail** (`/junctions/A`): visual intersection (confirmed state, with "wants X" when desired differs), the stage and its running timer and next phase, a desired vs actual table with signal-head and sensor health, active alerts, queues with live wait times and a per-vehicle "clear" button, backend scheduler scores, manual control (direction buttons, duration, operator, return to automatic, clear emergency, reset failure), a controller panel (pending command, attempt, timeout countdown, ACK/NACK/wrong-state buttons, duplicate-ACK button, simulator settings), the traffic simulation form, device status form and recent activity with filters.
* The UI **never decides sequencing**. It sends sensor events and commands, then displays what the backend returns.
* **Refresh:** Socket.IO push (`junctionUpdate`, `auditEntry`) for instant updates, *plus* polling (status every 3 s, overview every 5 s, history when the socket is down). Push makes emergencies and transitions visible immediately. Polling covers missed pushes and socket outages, so the screen is never stale for long. The navbar shows Live, Polling or Backend offline.
* **Errors:** backend unreachable (banner, last known state kept, automatic retry), unknown junction (dedicated page), rejected commands or events (toast with the backend reason), missing data (components tolerate partial objects).

---

## 13. Demonstrating the scenarios

Start the backend and frontend and open http://localhost:5173 → **Open junction** (Junction A). The simulator auto-ACKs by default.

| # | Scenario | Steps (dashboard) | What to look for |
|---|---|---|---|
| 1 | Normal traffic | "6 random vehicles" | queues fill; scheduler scores; after min/normal green the junction switches by score; history shows `TRANSITION_STARTED` with a reason |
| 2 | Priority traffic | NS green. Send 2 × EMPLOYEE_VEHICLE on NORTH, then 2 × TRUCK on EAST | EAST_WEST score is higher → switches at 30 s (`HIGHER_SCORE_AFTER_GREEN`). With nothing elsewhere it would stay green |
| 3 | Emergency preemption | While NS is green: "Emergency EAST" | red banner; NS YELLOW immediately → ALL RED → EW GREEN, held. Clear it with the X in the EAST queue → back to AUTOMATIC |
| 4 | Manual override | "GREEN request WEST" | toast shows planned sequence; blue banner; EW held even with traffic elsewhere; "Return to automatic" |
| 5 | Duplicate event | Send any event → "Re-send last (duplicate)" | toast "Duplicate … ignored", queue unchanged, `SENSOR_EVENT_DUPLICATE` in history |
| 6 | Vehicle clearance | Send arrival, then use the X next to the vehicle (or the form with "Vehicle cleared") | queue −1, `VEHICLE_CLEARED` with wait time. Clearing an unknown vehicle → "Ignored: CLEARED_WITHOUT_ARRIVAL" |
| 7 | Controller failure | Simulator behaviour **NO_ACK**, then add traffic so a change is requested (or "Controller OFFLINE") | attempt 2, 3 (retry), then `CONTROLLER_TIMEOUT` → FAILURE, all desired RED, actual UNKNOWN. Restore: behaviour NORMAL / "Controller ONLINE" → "Reset failure". Try **NACK**, **MISMATCH**, or turn off auto-ACK to ACK by hand (and re-send it for a duplicate ACK) |
| 8 | Restart | Create some state (queue, manual override), stop the backend (Ctrl+C), start it again | dashboard shows Backend offline, then recovers. State and history are intact, `SYSTEM_RECOVERY` and `COMMAND_ABANDONED` appear, and actual goes UNKNOWN → YELLOW/ALL RED clearance → GREEN |
| 9 | Concurrent events | "Concurrent burst (scenario 9)" | toast summary: truck APPLIED, emergency APPLIED, manual 409, duplicate DUPLICATE, ACK applied or ignored. No conflicting greens |

All of these can also be driven with `docs/postman_collection.json`.

---

## 14. Tests

```
cd backend && npm test      # 39 tests, ~0.4 s, no MongoDB needed
```
* **engine.test.js:** cycle order and timing (min green, yellow length), no progress without an ACK, retry with the same command id then FAILURE, duplicate/stale ACK, mismatch, NACK, emergency preemption/hold/clear, conflicting emergencies FIFO, repeated and stale emergencies, emergency timeout, emergency overriding manual, manual sequence/hold/expiry, invalid commands, queue edge cases (duplicate vehicle, clear without arrival, out-of-order), scheduler priority, no unnecessary switching, max-green starvation, sensor fallback, controller offline/reset, signal head failure, out-of-order device status, restart recovery, and a **randomized safety test**: 4,000 random inputs (events, ACKs/NACKs, wrong-state ACKs, commands, device failures, restarts). After every step it asserts no conflicting desired signals and that every new GREEN command was issued only while conflicting directions were confirmed RED.
* **service.test.js** (in-memory repository + fake controller): persist-before-send, event_id idempotency (also across a restart), 409 on a reused id, validation and status codes, the concurrent burst scenario, restart recovery, and multiple junctions with config validation.

---

## Assumptions / Questions / Requirement Issues

| # | Issue (type) | Decision |
|---|---|---|
| 1 | **What is a conflicting movement?** (unclear) | Directions in different phases conflict. YELLOW counts as permissive for conflict checks. Turning movements and pedestrians are out of scope. Phases are configuration data. |
| 2 | **Per-direction controller commands** (spec §9 example) are technically risky (unsafe if partially applied) | One command per junction carries the complete signal map. The ACK accepts both `actual_signals` (map) and the spec's `direction + actual_state`. |
| 3 | **Status event example `device_type: SIGNAL_CONTROLLER` with a `direction`** (contradictory: is it the controller or one signal?) | With a direction it is treated as that direction's signal head; without one, as the whole junction controller. `CONTROLLER`, `SIGNAL` and `SENSOR` are also accepted. Posted to a new endpoint, `POST /api/device-events`, because the spec does not define one. |
| 4 | **Is event_id or sequence_no authoritative?** | `event_id` is the idempotency key. `sequence_no` is only an ordering hint per direction sensor, because it can reset when a sensor reboots. Vehicle-level set semantics are the second safety net. |
| 5 | **Sensor time vs server time** | Server time for decisions and wait time; sensor time for audit, staleness and the future-skew check (section 6). |
| 6 | **Delayed events** | Applied and flagged `delayed`, except emergencies older than 30 s, which do not preempt (the vehicle has probably passed already). |
| 7 | **CLEARED without ARRIVED** | No queue change (never negative). A tombstone defeats a later out-of-order ARRIVED. |
| 8 | **Max waiting time** | Measured per vehicle from server receipt; 90 s triggers starvation protection. Phases are also capped at 60 s of green while others wait. |
| 9 | **"Emergency should immediately begin preemption" vs min green** (safety trade-off) | Min green is skipped for emergencies, but YELLOW (5 s) and ALL RED (2 s) are never skipped. |
| 10 | **Competing emergencies** (business decision) | FIFO by detection time, same-phase emergencies served together, 2 min timeout, operator `CLEAR_EMERGENCY`. A real deployment may want priority classes or radio coordination. |
| 11 | **Does emergency override manual?** | Yes. Manual is suspended, not cancelled, and resumes afterwards if not expired. |
| 12 | **Manual duration, expiry, disconnect, two admins** | 10 min default (10 s–60 min), automatic expiry, last-writer-wins with audit, optional `expected_version`. Authentication is **not implemented**: anyone who can reach the API can take manual control. This must be fixed before real use. |
| 13 | **"Manual control should override normal scheduling"** could starve other directions indefinitely (unsafe or a business decision) | Accepted while manual is active (operator responsibility), but bounded by the expiry. |
| 14 | **ACK timeout / retries** | 4 s timeout, 2 retries with the same `command_id`, then FAILURE. Values are per-junction config. |
| 15 | **What does an ACK without actual state mean?** | "Applied as requested". If the controller reports state, the reported state wins and any difference is a mismatch → FAILURE. |
| 16 | **Desired ≠ actual** | During a pending command this is expected (shown as info). Otherwise it is a critical mismatch → FAILURE (ALL RED). |
| 17 | **Losing communication / failure response** (unsafe area) | Fail-safe = **ALL RED immediately** (no YELLOW first, since the controller is not trustworthy). A real installation must also have a **hardware conflict monitor / local fail-safe (flashing red) in the controller**. A backend over a network must never be the only safety layer. |
| 18 | **Automatic recovery after a failure?** | Not automatic: operator `RESET_FAILURE`, refused while devices are unhealthy (avoids flapping). |
| 19 | **Signal timers after a restart** | Not resumed. The stage restarts with a safe clearance, because elapsed physical time is unknown. Manual and emergency expiries are absolute timestamps and keep counting. |
| 20 | **Sensor offline** | Does not stop the junction. The direction gets fixed-time fallback demand. |
| 21 | **The spec's status example has `"phase": "NORTH_SOUTH"` only** | Also exposes `stage` (GREEN/YELLOW/ALL_RED) and `target_phase`; `phase` is `"ALL_RED"` during clearance. |
| 22 | **Unknown vehicle types** | Rejected (400), not mapped to a default, because priority would otherwise be guessed. |
| 23 | **A queue tells you how many vehicles wait, but nothing removes vehicles except CLEARED events** | Queues only change through sensor events (as required: no arbitrary frontend values). A lost CLEARED event leaves a "ghost" vehicle; max green and starvation protection prevent this from blocking other phases. The X button in the UI sends a real CLEARED event. |
| 24 | **Retention** | Processed event ids are kept for 7 days. The audit log is unbounded; production would need archiving or a TTL. |
| 25 | **"Survive restarts" + MongoDB without a replica set** | No multi-document transactions are used. Safety comes from ordering (state saved before commands are sent, then the event id recorded) plus idempotent vehicle semantics. |

---

## Incomplete / what I would do next

* **Authentication and authorization** for manual control and the controller endpoints (JWT + roles; the controller authenticated with mTLS when on MQTT).
* **MQTT wiring**: the adapter exists (`mqttController.adapter.js`) but is not connected or tested against a broker. Next would be a Mosquitto docker-compose service and a Last-Will message mapped to controller OFFLINE.
* **Multi-instance deployment**: junction ownership / leader election, or a per-junction queue (for example Redis streams). Right now there is one process per deployment (the version check detects but does not resolve races).
* Configurable fail-safe sequence (YELLOW before ALL RED when the controller is still trusted, for example a single signal-head failure).
* Event replay from the audit log, metrics (Prometheus), HTTP-level tests with supertest, frontend tests, Docker Compose.
* Audit log retention and pagination in the UI.

---

## AI / Tool Usage

* **Claude Code (Anthropic)** was used as a coding assistant to scaffold the backend and frontend following my existing project structure (Express + Mongoose `controllers/models/routes/lib`, React + Zustand + daisyUI), to draft the domain state machine, tests and this README, and to work through the edge cases listed above.
* I reviewed the generated code, ran the tests and the demo scenarios, and adjusted decisions where needed. I am responsible for the solution and can explain, debug and modify any part of it.
* Other tools: VS Code, Node.js test runner, MongoDB, Postman.
