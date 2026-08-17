import "server-only";
import { WebSocket } from "ws";

// @supabase/supabase-js (and @supabase/ssr, which wraps it) unconditionally
// constructs a Realtime client inside `createClient`/`createServerClient`,
// which throws immediately if `globalThis.WebSocket` doesn't exist -- even
// though this app never uses realtime subscriptions (.channel() is never
// called anywhere here). Node's native WebSocket global only became stable
// in Node 22; on Node 20 (this project's local dev machine, and still a
// common Vercel Node runtime version as of writing) every single Supabase
// client construction -- the webhook handler's service-role client AND the
// session-bound client behind every Checkout/Portal server action -- would
// otherwise hard-crash on its first request. Importing this module before
// any createClient/createServerClient call polyfills the global so
// construction succeeds; nothing in this app actually opens a WebSocket.
// See: https://github.com/orgs/supabase/discussions/45715
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
}
