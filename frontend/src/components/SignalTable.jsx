import { statusBadgeClass } from "../lib/utils"

const colorBadge = (s) => ({
  GREEN:"badge-success",
  YELLOW:"badge-warning",
  RED:"badge-error",
}[s] || "badge-ghost")

// desired (backend wants) vs actual (controller confirmed), per direction
const SignalTable = ({status}) => {
  const directions=status?.config?.directions || Object.keys(status?.desired_signals || {})
  const devices=status?.devices || {}

  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body p-4">
        <h3 className="font-semibold">Desired vs confirmed signals</h3>
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Direction</th>
                <th>Desired</th>
                <th>Actual</th>
                <th>Signal head</th>
                <th>Sensor</th>
              </tr>
            </thead>
            <tbody>
              {directions.map((d)=>{
                const desired=status?.desired_signals?.[d]
                const actual=status?.actual_signals?.[d]
                const mismatch=desired!==actual
                return (
                  <tr key={d} className={mismatch ? "bg-warning/10" : ""}>
                    <td className="font-medium">{d}</td>
                    <td><span className={`badge badge-sm ${colorBadge(desired)}`}>{desired ?? "-"}</span></td>
                    <td><span className={`badge badge-sm ${colorBadge(actual)}`}>{actual ?? "-"}</span></td>
                    <td><span className={`badge badge-sm ${statusBadgeClass(devices.signals?.[d])}`}>{devices.signals?.[d] ?? "-"}</span></td>
                    <td><span className={`badge badge-sm ${statusBadgeClass(devices.sensors?.[d])}`}>{devices.sensors?.[d] ?? "-"}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {!status?.signals_match && (
          <p className="text-xs text-warning">
            {status?.pending_command ? "Desired ≠ actual while waiting for controller confirmation." : "Desired ≠ actual and nothing pending → treated as a failure."}
          </p>
        )}
      </div>
    </div>
  )
}

export default SignalTable
