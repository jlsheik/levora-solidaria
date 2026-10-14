// Registro de limpezas: executa em ordem INVERSA ao registro, continua mesmo se uma falhar, e é idempotente (Ctrl+C + fim normal não duplicam).
export class Cleanups {
  constructor() { this.items = []; this.ran = false; this.errors = []; }
  add(name, fn) { this.items.push({ name, fn }); return () => { this.items = this.items.filter((i) => i.fn !== fn); }; }
  async runAll() {
    if (this.ran) return this.errors;
    this.ran = true;
    for (const { name, fn } of [...this.items].reverse()) {
      try { await fn(); } catch (e) { this.errors.push({ name, message: String(e?.message ?? e).slice(0, 200) }); }
    }
    this.items = [];
    return this.errors;
  }
}
