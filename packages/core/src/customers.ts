import type { Db } from "./db.js";
import { CoreError, type MockCustomer } from "./types.js";

type CustomerRow = {
  id: string;
  display_name: string;
  phone_masked: string;
  account_type: string;
  kyc_status: string;
  support_flags: Record<string, unknown>;
};

function mapCustomer(row: CustomerRow): MockCustomer {
  return {
    id: row.id,
    displayName: row.display_name,
    phoneMasked: row.phone_masked,
    accountType: row.account_type,
    kycStatus: row.kyc_status,
    supportFlags: row.support_flags ?? {},
  };
}

export async function getMockCustomer(
  db: Db,
  customerId: string,
): Promise<MockCustomer> {
  const result = await db.query<CustomerRow>(
    `SELECT id, display_name, phone_masked, account_type, kyc_status, support_flags
     FROM mock_customers
     WHERE id = $1`,
    [customerId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CoreError(`Unknown customer: ${customerId}`, "NOT_FOUND");
  }
  return mapCustomer(row);
}
