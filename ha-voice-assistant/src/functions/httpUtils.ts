import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

export const BASE_URL =
  process.env.REACT_APP_API_BASE_URL || "http://localhost:3005/api";

export async function httpGet<T = any>(
  urlPath: string,
  config?: AxiosRequestConfig
): Promise<AxiosResponse<T>> {
  urlPath = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
  return axios.get<T>(`${BASE_URL}${urlPath}`, config);
}

export async function httpPost<T = any>(
  urlPath: string,
  data?: any,
  config?: AxiosRequestConfig
): Promise<AxiosResponse<T>> {
  urlPath = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
  return axios.post<T>(`${BASE_URL}${urlPath}`, data, config);
}

export async function httpPut<T = any>(
  urlPath: string,
  data?: any,
  config?: AxiosRequestConfig
): Promise<AxiosResponse<T>> {
  urlPath = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
  return axios.put<T>(`${BASE_URL}${urlPath}`, data, config);
}

export async function httpDelete<T = any>(
  urlPath: string,
  config?: AxiosRequestConfig
): Promise<AxiosResponse<T>> {
  urlPath = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
  return axios.delete<T>(`${BASE_URL}${urlPath}`, config);
}
