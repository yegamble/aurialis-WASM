/* Private Emscripten import: one selected immutable File, bounded by the Worker. */
addToLibrary({
  aurialis_read: function(offset, destination, bytes) {
    try { return Module["readInput"](offset, destination, bytes, HEAPU8); }
    catch (_) { return -1; }
  }
});
