export interface Response<T> {
  success: boolean;
  errorMessage?: string;
  data?: T;
}
