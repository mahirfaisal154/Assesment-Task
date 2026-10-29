import { AlertTriangle, Info, OctagonAlert, CheckCircle2 } from "lucide-react"

const STYLE={
  CRITICAL:{cls:"text-error", Icon:OctagonAlert},
  WARNING:{cls:"text-warning", Icon:AlertTriangle},
  INFO:{cls:"text-info", Icon:Info},
}

const AlertsPanel = ({alerts}) => {
  const list=Array.isArray(alerts) ? alerts : []
  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body p-4">
        <h3 className="font-semibold">Active alerts</h3>
        {list.length===0 ? (
          <p className="text-sm text-success flex items-center gap-2"><CheckCircle2 className="size-4"/> All devices healthy</p>
        ) : (
          <ul className="space-y-1">
            {list.map((a,i)=>{
              const {cls, Icon}=STYLE[a.level] || STYLE.INFO
              return (
                <li key={`${a.code}-${i}`} className={`text-sm flex items-start gap-2 ${cls}`}>
                  <Icon className="size-4 mt-0.5 shrink-0"/>
                  <span><b>{a.code}</b> - {a.message}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

export default AlertsPanel
