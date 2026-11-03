import type { Condition, ItemStatus } from "@/lib/catalog/types";

/**
 * Demo cart, persisted in localStorage. Each line keeps a snapshot of what
 * the shopper saw when adding it, including the stock limit at that time.
 * A real checkout must re-check stock and prices on the server.
 */
export type CartLine = {
  sku: string;
  productId: string;
  slug: string;
  name: string;
  brand: string;
  size: number;
  price: number;
  status: ItemStatus;
  condition: Condition;
  image: { src: string; alt: string };
  /** Units available when the line was last updated. */
  maxQuantity: number;
  quantity: number;
};

export type AddResult = "added" | "limit" | "unavailable";

const STORAGE_KEY = "kharchnsave:cart:v1";
const EMPTY: CartLine[] = [];

let lines: CartLine[] = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function isCartLine(value: unknown): value is CartLine {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sku === "string" &&
    typeof v.slug === "string" &&
    typeof v.name === "string" &&
    typeof v.price === "number" &&
    typeof v.quantity === "number" &&
    typeof v.maxQuantity === "number" &&
    typeof v.size === "number" &&
    !!v.image &&
    typeof (v.image as Record<string, unknown>).src === "string"
  );
}

function read(): CartLine[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return EMPTY;
    return parsed
      .filter(isCartLine)
      .map((line) => ({
        ...line,
        quantity: Math.min(Math.max(1, Math.floor(line.quantity)), line.maxQuantity),
      }))
      .filter((line) => line.maxQuantity > 0);
  } catch {
    return EMPTY;
  }
}

function emit() {
  listeners.forEach((listener) => listener());
}

function commit(next: CartLine[]) {
  lines = next.length ? next : EMPTY;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
  } catch {
    // Storage can be unavailable (private mode, quota). Keep the in-memory cart.
  }
  emit();
}

function onStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY) return;
  lines = read();
  emit();
}

export const cartStore = {
  subscribe(listener: () => void) {
    if (listeners.size === 0) window.addEventListener("storage", onStorage);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) window.removeEventListener("storage", onStorage);
    };
  },

  getSnapshot() {
    if (!loaded) {
      loaded = true;
      lines = read();
    }
    return lines;
  },

  getServerSnapshot() {
    return EMPTY;
  },

  add(item: Omit<CartLine, "quantity">, quantity = 1): AddResult {
    const current = cartStore.getSnapshot();
    if (item.maxQuantity < 1) return "unavailable";
    const existing = current.find((line) => line.sku === item.sku);
    if (existing) {
      if (existing.quantity >= item.maxQuantity) return "limit";
      commit(
        current.map((line) =>
          line.sku === item.sku
            ? {
                ...line,
                ...item,
                quantity: Math.min(line.quantity + quantity, item.maxQuantity),
              }
            : line,
        ),
      );
      return "added";
    }
    commit([...current, { ...item, quantity: Math.min(quantity, item.maxQuantity) }]);
    return "added";
  },

  setQuantity(sku: string, quantity: number) {
    const current = cartStore.getSnapshot();
    commit(
      current
        .map((line) =>
          line.sku === sku
            ? { ...line, quantity: Math.min(Math.max(0, quantity), line.maxQuantity) }
            : line,
        )
        .filter((line) => line.quantity > 0),
    );
  },

  remove(sku: string) {
    commit(cartStore.getSnapshot().filter((line) => line.sku !== sku));
  },

  /** Removes several lines at once (e.g. after an order is placed). */
  removeMany(skus: string[]) {
    const gone = new Set(skus);
    commit(cartStore.getSnapshot().filter((line) => !gone.has(line.sku)));
  },

  /**
   * Applies the live prices and quantities the customer accepted at checkout:
   * lines not listed in `updates` are left alone; a quantity of 0 removes the line.
   */
  applyQuote(updates: { sku: string; quantity: number; price: number; maxQuantity: number }[]) {
    const bySku = new Map(updates.map((u) => [u.sku, u]));
    commit(
      cartStore
        .getSnapshot()
        .map((line) => {
          const update = bySku.get(line.sku);
          if (!update) return line;
          return {
            ...line,
            price: update.price,
            maxQuantity: update.maxQuantity,
            quantity: Math.min(update.quantity, update.maxQuantity),
          };
        })
        .filter((line) => line.quantity > 0 && line.maxQuantity > 0),
    );
  },
};
