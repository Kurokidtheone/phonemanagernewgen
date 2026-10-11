// What the oldest supported macOS WebView (Safari 14 on 10.15 Catalina) lacks. Imported first by main.tsx.

if (!Object.hasOwn) {
  Object.hasOwn = (o: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(o, key);
}

if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
  crypto.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` as ReturnType<Crypto['randomUUID']>;
  };
}

if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (<T,>(value: T): T => {
    if (value instanceof Error) {
      const copy = new (value.constructor as ErrorConstructor)(value.message);
      copy.name = value.name;
      copy.stack = value.stack;
      return copy as T;
    }
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  }) as typeof structuredClone;
}

export {};
