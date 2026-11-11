import type { Session } from 'neo4j-driver';

const CONSTRAINTS = [
  'CREATE CONSTRAINT store_identity IF NOT EXISTS FOR (n:Store) REQUIRE (n.storeId, n.sourceId) IS NODE UNIQUE',
  'CREATE CONSTRAINT product_identity IF NOT EXISTS FOR (n:Product) REQUIRE (n.storeId, n.sourceId) IS NODE UNIQUE',
  'CREATE CONSTRAINT bill_identity IF NOT EXISTS FOR (n:Bill) REQUIRE (n.storeId, n.sourceId) IS NODE UNIQUE',
  'CREATE CONSTRAINT bill_item_identity IF NOT EXISTS FOR (n:BillItem) REQUIRE (n.storeId, n.sourceId) IS NODE UNIQUE',
  'CREATE CONSTRAINT stock_movement_identity IF NOT EXISTS FOR (n:StockMovement) REQUIRE (n.storeId, n.sourceId) IS NODE UNIQUE',
  'CREATE CONSTRAINT khata_account_identity IF NOT EXISTS FOR (n:KhataAccount) REQUIRE (n.storeId, n.sourceId) IS NODE UNIQUE',
  'CREATE CONSTRAINT khata_entry_identity IF NOT EXISTS FOR (n:KhataEntry) REQUIRE (n.storeId, n.sourceId) IS NODE UNIQUE',
  'CREATE CONSTRAINT pending_action_identity IF NOT EXISTS FOR (n:PendingAction) REQUIRE (n.storeId, n.sourceId) IS NODE UNIQUE',
  'CREATE CONSTRAINT audit_event_identity IF NOT EXISTS FOR (n:AuditEvent) REQUIRE (n.storeId, n.sourceId) IS NODE UNIQUE',
] as const;

export async function ensureGraphSchema(session: Session): Promise<void> {
  for (const statement of CONSTRAINTS) await session.run(statement);
}
