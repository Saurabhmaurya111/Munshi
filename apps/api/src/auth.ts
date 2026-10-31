import { createMiddleware } from "hono/factory";
import {
  CoreError,
  getMockCustomer,
  type Db,
  type MockCustomer,
} from "@repo/core";

export type AppVariables = {
  db: Db;
  customer?: MockCustomer;
};

export const requireCustomer = createMiddleware<{
  Variables: AppVariables;
}>(async (c, next) => {
  const customerId = c.req.header("x-customer-id")?.trim();
  if (!customerId) {
    return c.json(
      { error: "Missing X-Customer-Id header", code: "UNAUTHORIZED" },
      401,
    );
  }

  try {
    const customer = await getMockCustomer(c.get("db"), customerId);
    c.set("customer", customer);
    await next();
  } catch (error) {
    if (error instanceof CoreError && error.code === "NOT_FOUND") {
      return c.json({ error: "Unknown customer", code: "UNAUTHORIZED" }, 401);
    }
    throw error;
  }
});
