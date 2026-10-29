import axios from "axios"

export const axiosInstance = axios.create({
  baseURL:import.meta.env.MODE==="development" ? "http://localhost:3010/api" : "/api",
  timeout:8000,  //don't hang forever when backend is down
});
