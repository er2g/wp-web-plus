export class ApiError extends Error {
  status: number;
  data: any;

  constructor(message: string, status: number, data: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export function isUnauthorizedError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err && (err as any).status === 401) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /unauthorized|not authenticated|http 401/i.test(message);
}

