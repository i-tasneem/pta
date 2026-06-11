// signals/DecisionGate.js
class DecisionGate {
  constructor(name, number) {
    this.name = name;
    this.number = number;
  }

  async evaluate(context) {
    throw new Error(`evaluate() must be implemented by ${this.name}`);
  }

  createPassResult() {
    return { pass: true, reason: `${this.name} passed` };
  }

  createFailResult(reason) {
    return { pass: false, reason: `${this.name} failed: ${reason}` };
  }
}

module.exports = DecisionGate;
