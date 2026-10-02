/**
 * Checkout: idempotent API entry point → orchestrated saga → outbox event.
 * Run: npm run build && node dist/examples/checkout-saga.js
 */
import {
  enqueue,
  fingerprint,
  handleIdempotently,
  InMemoryDatabase,
  InMemoryIdempotencyStore,
  InMemorySagaLog,
  OutboxRelay,
  SagaOrchestrator,
  type SagaStep,
} from "../src/index.js";

interface CheckoutContext {
  checkoutId: string;
  sku: string;
  quantity: number;
  amount: number;
  cardToken: string;
}

const db = new InMemoryDatabase();
const stock = new Map([["SKU-1", 3]]);
const log = (msg: string) => console.log(`  ${msg}`);

const steps: SagaStep<CheckoutContext>[] = [
  {
    name: "reserve-stock",
    action: async (c) => {
      const available = stock.get(c.sku) ?? 0;
      if (available < c.quantity) throw new Error("insufficient stock");
      stock.set(c.sku, available - c.quantity);
      log(`reserved ${c.quantity} x ${c.sku} (left: ${stock.get(c.sku)})`);
    },
    compensate: async (c) => {
      stock.set(c.sku, (stock.get(c.sku) ?? 0) + c.quantity);
      log(`released ${c.quantity} x ${c.sku} (left: ${stock.get(c.sku)})`);
    },
  },
  {
    name: "authorize-payment",
    action: async (c) => {
      if (c.cardToken === "tok_declined") throw new Error("card declined");
      log(`authorized ${c.amount} on ${c.cardToken}`);
    },
    compensate: async (c) => log(`voided authorization for ${c.checkoutId}`),
  },
  {
    name: "create-order",
    action: async (c) =>
      db.transaction((tx) => {
        tx.put("orders", c.checkoutId, { orderId: c.checkoutId, sku: c.sku, status: "CONFIRMED" });
        enqueue(tx, { aggregateType: "Order", aggregateId: c.checkoutId, type: "OrderPlaced", payload: c });
        log(`order ${c.checkoutId} written with OrderPlaced in the same transaction`);
      }),
  },
];

const saga = new SagaOrchestrator(steps, new InMemorySagaLog<CheckoutContext>());
const idempotency = new InMemoryIdempotencyStore();

async function postCheckout(idempotencyKey: string, body: Omit<CheckoutContext, "checkoutId">) {
  return handleIdempotently(idempotency, idempotencyKey, fingerprint("POST", "/checkout", body), async () => {
    const result = await saga.run(idempotencyKey, { ...body, checkoutId: idempotencyKey });
    return result.status === "COMPLETED"
      ? { status: 201, body: { orderId: idempotencyKey } }
      : { status: 409, body: { error: result.failure } };
  });
}

const order = { sku: "SKU-1", quantity: 2, amount: 59.98, cardToken: "tok_visa" };
console.log("1) successful checkout");
console.log("  ->", await postCheckout("chk-001", order));
console.log("2) client retries the same request (network timeout on its side)");
console.log("  ->", await postCheckout("chk-001", order));
console.log("3) declined card triggers compensation");
console.log("  ->", await postCheckout("chk-002", { ...order, quantity: 1, cardToken: "tok_declined" }));
console.log("4) outbox relay publishes committed events");
await new OutboxRelay(db, async (m) => log(`published ${m.type} for ${m.aggregateId}`)).pollOnce();
