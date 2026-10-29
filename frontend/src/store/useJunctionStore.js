import {create} from "zustand";
import toast from "react-hot-toast"
import {io} from "socket.io-client"
import { axiosInstance } from "../lib/axios";

const BASE_URL = import.meta.env.MODE==="development" ? "http://localhost:3010" : "/";

// turn any axios error into a readable message (backend down / validation details / generic)
const errorMessage = (error, fallback) => {
  if(!error.response) return "Backend unreachable - is the server running?"
  const {message, details}=error.response.data || {}
  if(Array.isArray(details) && details.length) return `${message}: ${details.join(", ")}`
  return message || fallback
}

export const useJunctionStore= create((set, get) => ({
   junctions:[],
   status:null,
   statusError:null,          // "NOT_FOUND" | message
   statusReceivedAt:0,
   history:[],
   simulator:null,
   backendOnline:true,
   socket:null,
   socketConnected:false,
   isJunctionsLoading:false,
   isStatusLoading:false,
   isSendingCommand:false,
   isSendingEvent:false,

   getJunctions:async () => {
     set({ isJunctionsLoading: true });
     try {
       const res = await axiosInstance.get("/junctions");
       set({ junctions: Array.isArray(res.data) ? res.data : [], backendOnline:true });
     } catch (error) {
       console.log("error in getJunctions:", error);
       if(!error.response) set({backendOnline:false})
     }
     finally{
       set({ isJunctionsLoading: false });
     }
   },

   getStatus:async (junctionId, {showLoader=false}={}) => {
     if(showLoader) set({isStatusLoading:true})
     try {
       const res=await axiosInstance.get(`/junctions/${junctionId}/status`)
       set({ status: res.data, statusError:null, statusReceivedAt:Date.now(), backendOnline:true })
     } catch (error) {
       if(!error.response) set({backendOnline:false})
       else if(error.response.status===404) set({status:null, statusError:"NOT_FOUND"})
       else set({statusError: errorMessage(error,"Failed to load junction")})
     }
     finally{
       set({isStatusLoading:false})
     }
   },

   getHistory:async (junctionId) => {
     try {
       const res=await axiosInstance.get(`/junctions/${junctionId}/history`, {params:{limit:150}})
       set({history: Array.isArray(res.data) ? res.data : []})
     } catch (error) {
       console.log("error in getHistory:", error);
     }
   },

   createJunction:async (data) => {
     try {
       const res=await axiosInstance.post("/junctions", data)
       toast.success(`Junction ${res.data.junction_id} created`)
       get().getJunctions()
       return true
     } catch (error) {
       toast.error(errorMessage(error,"Failed to create junction"))
       return false
     }
   },

   sendCommand:async (junctionId, body) => {
     set({isSendingCommand:true})
     try {
       const res=await axiosInstance.post(`/junctions/${junctionId}/commands`, body)
       if(res.data.status==="NO_OP") toast(res.data.message || "Nothing to do")
       else toast.success(res.data.plannedSequence ? `Accepted: ${res.data.plannedSequence.join(" → ")}` : `${body.command} accepted`)
       if(res.data.junction) set({status:res.data.junction, statusReceivedAt:Date.now()})
       return res.data
     } catch (error) {
       toast.error(errorMessage(error,"Command failed"))
       return null
     }
     finally{
       set({isSendingCommand:false})
     }
   },

   sendSensorEvent:async (body, {silent=false}={}) => {
     set({isSendingEvent:true})
     try {
       const res=await axiosInstance.post("/sensor-events", body)
       if(!silent){
         if(res.data.status==="DUPLICATE") toast(`Duplicate ${body.event_id} ignored (queue unchanged)`, {icon:"♻️"})
         else if(res.data.status==="IGNORED") toast(`Ignored: ${res.data.reason}`, {icon:"⚠️"})
         else toast.success(`${body.event_type} ${body.vehicle_id} @ ${body.direction}`)
       }
       return res.data
     } catch (error) {
       toast.error(errorMessage(error,"Sensor event failed"))
       return null
     }
     finally{
       set({isSendingEvent:false})
     }
   },

   sendDeviceEvent:async (body) => {
     try {
       const res=await axiosInstance.post("/device-events", body)
       toast.success(`${body.device_type}${body.direction ? " "+body.direction : ""} → ${body.status}`)
       return res.data
     } catch (error) {
       toast.error(errorMessage(error,"Device event failed"))
       return null
     }
   },

   sendControllerEvent:async (body) => {
     try {
       const res=await axiosInstance.post("/controller-events", body)
       if(res.data.status==="DUPLICATE") toast("Duplicate ACK ignored", {icon:"♻️"})
       else if(res.data.status==="IGNORED") toast("ACK ignored (unknown / superseded command)", {icon:"⚠️"})
       else toast.success(`${body.status} sent for ${body.command_id}`)
       return res.data
     } catch (error) {
       toast.error(errorMessage(error,"Controller event failed"))
       return null
     }
   },

   getSimulator:async () => {
     try {
       const res=await axiosInstance.get("/simulator")
       set({simulator:res.data})
     } catch (error) {
       console.log("error in getSimulator:", error);
     }
   },

   updateSimulator:async (patch) => {
     try {
       const res=await axiosInstance.put("/simulator", patch)
       set({simulator:{...get().simulator, settings:res.data.settings}})
       toast.success("Simulator updated")
     } catch (error) {
       toast.error(errorMessage(error,"Failed to update simulator"))
     }
   },

   // live updates pushed by backend. polling in the pages is the fallback
   connectSocket:()=>{
     if(get().socket) return;
     const socket=io(BASE_URL)

     socket.on("connect",()=>set({socketConnected:true, backendOnline:true}))
     socket.on("disconnect",()=>set({socketConnected:false}))
     socket.on("connect_error",()=>set({socketConnected:false}))

     socket.on("junctionUpdate",(update)=>{
       const {junctions, status}=get()
       const exists=junctions.some(j=>j.junction_id===update.junction_id)
       set({
         junctions: exists ? junctions.map(j=>j.junction_id===update.junction_id ? update : j) : [...junctions, update],
         ...(status?.junction_id===update.junction_id ? {status:update, statusReceivedAt:Date.now()} : {}),
       })
     })

     socket.on("auditEntry",(entry)=>{
       const {status, history}=get()
       if(status?.junction_id===entry.junction_id){
         set({history:[entry, ...history].slice(0,200)})
       }
     })
     set({socket})
   },

   disconnectSocket:()=>{
     const socket=get().socket
     if(socket) socket.disconnect()
     set({socket:null, socketConnected:false})
   },

   resetJunction:()=>{
     set({status:null, statusError:null, history:[]})
   },
}))
