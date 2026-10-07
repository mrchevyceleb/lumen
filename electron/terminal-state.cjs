const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");
class TerminalState {
  constructor(cols = 100, rows = 30, respond = () => {}) {
    this.terminal = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
    this.serialize = new SerializeAddon();
    this.terminal.loadAddon(this.serialize);
    this.offset = 0;
    this.terminal.onData(respond);
  }
  write(data, emit) { this.terminal.write(data, () => { this.offset++; emit({ data, offset: this.offset }); }); }
  resize(cols, rows) { this.terminal.resize(cols, rows); }
  snapshot() { return new Promise((resolve) => this.terminal.write("", () => resolve({ data: this.serialize.serialize(), offset: this.offset }))); }
  dispose() { this.terminal.dispose(); }
}
module.exports = { TerminalState };
