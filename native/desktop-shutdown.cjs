/* Native launcher owns stdin. Emit the same signal Next handles on Unix so
 * Windows can request graceful HTTP draining without terminating the process.
 * This hook is loaded only for a native desktop launch via --require. */
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
let requested = false;
function shutdown() {
  if (requested) return;
  requested = true;
  // EOF can arrive while Next is still registering its graceful signal handler.
  // Queue the request until the owner can drain it rather than losing it.
  function deliver() {
    if (process.listenerCount("SIGTERM") > 0) process.emit("SIGTERM", "SIGTERM");
    else setTimeout(deliver, 25);
  }
  deliver();
}
input.on("line", (line) => { if (line === "shutdown") shutdown(); });
input.on("close", shutdown);
