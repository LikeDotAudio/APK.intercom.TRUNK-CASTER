// Operator actions wired to inline onclick= handlers in the server-rendered
// HTML (html.rs connections_table, racks, panels, users, bookings, ...).
// Each prompts, POSTs, alerts the answer and refreshes <main> in place.
import { api } from './api.ts';
import { reload } from './refresh.ts';
import type { ApiError, GpioCommand, GpioEvent, RenameBody, Reply, RequestBody } from './types.ts';

/** Connect a user port to another frame (POST /api/request). */
export function connect(from: string, fromPort: number, who?: string): void {
  const to = prompt('Connect ' + from + ':' + fromPort + ' to which frame? (e.g. london-01)');
  if (!to) return;
  const body: RequestBody = { who: who || 'operator', from, to, from_port: fromPort };
  void api<Reply>('/api/request', body).then((r) => {
    // FIDELITY: the original reads r.status/r.reason without narrowing, so a
    // 400 `{error}` or a text answer alerts "undefined". Kept; see HANDOFF.
    const rr = (typeof r === 'string' ? {} : r) as Partial<Reply>;
    alert(String(rr.status) + (rr.reason ? ': ' + rr.reason : ''));
    reload();
  });
}

/** Rename a user port (POST /api/rename). */
export function rename(frame: string, port: number): void {
  const name = prompt('New name for ' + frame + ':U' + String(port).padStart(2, '0') + ' (emoji welcome; cut to 6, 8 and 16 characters)');
  if (!name) return;
  const body: RenameBody = { frame, port, name };
  void api('/api/rename', body).then(() => reload());
}

/** Cancel a booking (POST /api/bookings/cancel). */
export function cancelBooking(id: string): void {
  if (!confirm('Cancel booking ' + id + '?')) return;
  void api<{ cancelled: string }>('/api/bookings/cancel', { id }).then(() => reload());
}

/** The text alerted after a GPIO key press. */
export function gpioSummary(r: GpioEvent | ApiError | string): string {
  if (typeof r === 'string') return r;
  if ('error' in r && r.error) return r.error;
  const ev = r as GpioEvent;
  return 'pin ' + ev.pin + ' ' + (ev.function || '') + ' via ' + ev.trunks.join(',') + (ev.result ? '\n' + JSON.stringify(ev.result, null, 1) : '');
}

/** Press a GPIO key on a live connection (POST /api/gpio). */
export function gpio(conn: string): void {
  const pin = prompt('GPIO key on ' + conn + ':\n1 blink panel · 2 check lights · 3 set latch · 4 set listen\n5 unset latch · 6 clear · 7 last caller · 8 ping', '1');
  if (!pin) return;
  const body: GpioCommand = { connection: conn, pin: Number(pin), state: true, note: 'from page' };
  void api<GpioEvent | ApiError>('/api/gpio', body).then((r) => {
    alert(gpioSummary(r));
    reload();
  });
}
