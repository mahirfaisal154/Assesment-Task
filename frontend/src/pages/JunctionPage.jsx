import { useEffect } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, Loader } from "lucide-react"
import { useJunctionStore } from "../store/useJunctionStore"
import { useNow, formatDuration, modeBadgeClass, statusBadgeClass } from "../lib/utils"
import Intersection from "../components/Intersection"
import StatusBanners from "../components/StatusBanners"
import SignalTable from "../components/SignalTable"
import AlertsPanel from "../components/AlertsPanel"
import QueuePanel from "../components/QueuePanel"
import ManualControl from "../components/ManualControl"
import ControllerPanel from "../components/ControllerPanel"
import SimulationForm from "../components/SimulationForm"
import DeviceStatusForm from "../components/DeviceStatusForm"
import ActivityList from "../components/ActivityList"

const JunctionPage = () => {
  const {id:junctionId} = useParams()
  const {
    status, statusError, statusReceivedAt, history, isStatusLoading, backendOnline, socketConnected,
    getStatus, getHistory, getSimulator, sendCommand, isSendingCommand, resetJunction,
  } = useJunctionStore()
  const now=useNow(500)

  useEffect(()=>{
    resetJunction()
    getStatus(junctionId, {showLoader:true})
    getHistory(junctionId)
    getSimulator()
    // polling fallback. status every 3s, history only when socket is down (socket pushes entries live)
    const statusTimer=setInterval(()=>getStatus(junctionId), 3000)
    const historyTimer=setInterval(()=>{
      if(!useJunctionStore.getState().socketConnected) getHistory(junctionId)
      getSimulator()
    }, 5000)
    return ()=>{
      clearInterval(statusTimer)
      clearInterval(historyTimer)
    }
  },[junctionId, getStatus, getHistory, getSimulator, resetJunction])

  if(statusError==="NOT_FOUND"){
    return (
      <div className="min-h-screen bg-base-200 pt-20 flex flex-col items-center justify-center gap-4">
        <h2 className="text-2xl font-bold">Junction “{junctionId}” does not exist</h2>
        <Link to="/" className="btn btn-primary">Back to overview</Link>
      </div>
    )
  }

  if(!status){
    return (
      <div className="min-h-screen bg-base-200 pt-20 flex flex-col items-center justify-center gap-3">
        {isStatusLoading || backendOnline ? <Loader className="animate-spin"/> : null}
        {!backendOnline && <p className="text-error">Backend unreachable - retrying…</p>}
        {statusError && statusError!=="NOT_FOUND" && <p className="text-error">{statusError}</p>}
      </div>
    )
  }

  const stageElapsed=status.stage_confirmed_at ? status.stage_elapsed_ms + (now - statusReceivedAt) : null

  return (
    <div className="min-h-screen bg-base-200 pt-20 pb-10">
      <div className="max-w-7xl mx-auto px-4 space-y-4">
        {/*header*/}
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/" className="btn btn-ghost btn-sm"><ArrowLeft className="size-4"/></Link>
          <h2 className="text-2xl font-bold">{status.name}</h2>
          <span className={`badge badge-lg ${modeBadgeClass(status.mode)}`}>{status.mode}</span>
          <span className="badge badge-lg badge-outline">phase {status.phase ?? "-"}</span>
          <span className={`badge badge-lg ${statusBadgeClass(status.controller_status)}`}>controller {status.controller_status}</span>
          <span className="text-xs opacity-60 ml-auto">v{status.version} · {socketConnected ? "live" : "polling"}</span>
        </div>

        <StatusBanners
          status={status}
          backendOnline={backendOnline}
          isSendingCommand={isSendingCommand}
          onReturnToAutomatic={()=>sendCommand(status.junction_id, {command:"RETURN_TO_AUTOMATIC"})}
        />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/*left: visual*/}
          <div className="space-y-4">
            <div className="card bg-base-100 shadow">
              <div className="card-body p-4">
                <h3 className="font-semibold">Intersection (confirmed state)</h3>
                <Intersection status={status}/>
                <div className="text-sm text-center mt-2">
                  {status.stage==="ALL_RED" ? "ALL RED clearance" : `${status.phase} ${status.stage}`}
                  {stageElapsed!=null ? ` · ${formatDuration(stageElapsed)}` : " · waiting for controller confirmation"}
                  {status.target_phase && <> · next <b>{status.target_phase}</b></>}
                </div>
              </div>
            </div>
            <AlertsPanel alerts={status.alerts}/>
          </div>

          {/*middle: state*/}
          <div className="space-y-4">
            <SignalTable status={status}/>
            <QueuePanel status={status} now={now}/>
          </div>

          {/*right: control*/}
          <div className="space-y-4">
            <ManualControl status={status}/>
            <ControllerPanel status={status} now={now}/>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SimulationForm status={status}/>
          <DeviceStatusForm status={status}/>
        </div>

        <ActivityList history={history}/>
      </div>
    </div>
  )
}

export default JunctionPage
