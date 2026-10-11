export type User = { id: number; name: string; email: string };
export type Contact = { id: number; name: string; phone: string; verified: boolean };
export type Alert = {
  id: number;
  createdAt: string;
  message: string;
  latitude: number | null;
  longitude: number | null;
  recipients: { name: string; phone: string; status: string; error: string | null }[];
};

export class ApiError extends Error {
  constructor(message: string, public status: number, public contact?: Contact) { super(message); }
}

export async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({ error: 'The server returned an unexpected response.' }));
  if (!response.ok) throw new ApiError(data.error || 'Request failed. Please try again.', response.status, data.contact);
  return data as T;
}
