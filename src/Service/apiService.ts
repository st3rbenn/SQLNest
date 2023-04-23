import axios, { AxiosResponse } from 'axios';
import { notifications } from '@mantine/notifications';

interface IResponse {
  message: string;
  error: string;
  result: any;
}

const apiClient = axios.create({
  baseURL: 'http://localhost:3000/api/v/0.1.0/',
  headers: {
    'Content-Type': 'application/json',
  },
});

export async function get<T extends IResponse>(endpoint: string): Promise<T> {
  const response: AxiosResponse<T> = await apiClient.get(endpoint);
  console.log('TESTIONS');
  if (response.status !== 200) {
    console.log('error');
    notifications.show({
      title: response.data.message,
      message: response.data.error,
    });
  }
  return response.data;
}

export async function post<T>(endpoint: string, data: any): Promise<T> {
  const response: AxiosResponse<T> = await apiClient.post(endpoint, data);
  return response.data;
}

export async function put<T>(endpoint: string, data: any): Promise<T> {
  const response: AxiosResponse<T> = await apiClient.put(endpoint, data);
  return response.data;
}

export async function del<T>(endpoint: string): Promise<T> {
  const response: AxiosResponse<T> = await apiClient.delete(endpoint);
  return response.data;
}