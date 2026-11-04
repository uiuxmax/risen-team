// jsdom does not implement the browser's native modal top layer. Keep this
// shim limited to opening/closing; keyboard trapping is verified in the browser.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
}
