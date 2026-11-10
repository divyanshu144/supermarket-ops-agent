import { describe, expect, it } from 'vitest';
import { mapGraphEvent, type GraphEvent } from './mapping.js';

const at = new Date('2026-11-10T10:00:00.000Z');

describe('mapGraphEvent', () => {
  it('maps bill and bill item snapshots with stable tenant-scoped ids', () => {
    const bill: GraphEvent = {
      type: 'bill',
      storeId: '42',
      id: 'bill-1',
      status: 'finalized',
      invoiceNumber: 'INV-1',
      totalPaise: 1234,
      createdAt: at.toISOString(),
      finalizedAt: at.toISOString(),
    };
    const item: GraphEvent = {
      type: 'bill_item',
      storeId: '42',
      id: 'item-1',
      billId: 'bill-1',
      productId: 'product-1',
      lineNo: 1,
      qtyBase: 2000,
      unitPricePaise: 125,
      gstRateBps: 500,
      hsnCode: '1006',
    };
    expect(mapGraphEvent(bill)).toEqual({
      kind: 'bill',
      storeId: '42',
      sourceId: 'bill-1',
      properties: {
        status: 'finalized',
        invoiceNumber: 'INV-1',
        totalPaise: 1234,
        createdAt: at.toISOString(),
        finalizedAt: at.toISOString(),
      },
      relationships: [],
    });
    expect(mapGraphEvent(item)).toMatchObject({
      kind: 'bill_item',
      storeId: '42',
      sourceId: 'item-1',
      relationships: [
        {
          type: 'CONTAINS',
          fromKind: 'Bill',
          fromId: 'bill-1',
          toKind: 'Product',
          toId: 'product-1',
        },
      ],
    });
  });

  it('maps stock movements, khata entries, pending actions and audit records from source links', () => {
    const events: GraphEvent[] = [
      {
        type: 'stock_movement',
        storeId: '42',
        id: 'move-1',
        productId: 'product-1',
        kind: 'sale',
        qtyBaseDelta: -2000,
        billId: 'bill-1',
        createdAt: at.toISOString(),
      },
      {
        type: 'khata_entry',
        storeId: '42',
        id: 'entry-1',
        accountId: 'account-1',
        kind: 'charge',
        amountPaise: 1234,
        billId: 'bill-1',
        createdAt: at.toISOString(),
      },
      {
        type: 'pending_action',
        storeId: '42',
        id: 'action-1',
        tool: 'finalize_bill',
        status: 'confirmed',
        outcome: 'finalized',
        createdAt: at.toISOString(),
      },
      {
        type: 'audit_event',
        storeId: '42',
        id: 'audit-1',
        action: 'finalize_bill',
        tool: 'finalize_bill',
        outcome: 'finalized',
        updateId: '100',
        createdAt: at.toISOString(),
        pendingActionId: 'action-1',
      },
    ];
    const [movement, entry, pending, audit] = events.map(mapGraphEvent) as [
      ReturnType<typeof mapGraphEvent>,
      ReturnType<typeof mapGraphEvent>,
      ReturnType<typeof mapGraphEvent>,
      ReturnType<typeof mapGraphEvent>,
    ];
    expect(movement.relationships).toEqual([
      {
        type: 'OF',
        fromKind: 'StockMovement',
        fromId: 'move-1',
        toKind: 'Product',
        toId: 'product-1',
      },
      {
        type: 'CAUSED_BY',
        fromKind: 'StockMovement',
        fromId: 'move-1',
        toKind: 'Bill',
        toId: 'bill-1',
      },
    ]);
    expect(entry.relationships).toContainEqual({
      type: 'HAS_ENTRY',
      fromKind: 'KhataAccount',
      fromId: 'account-1',
      toKind: 'KhataEntry',
      toId: 'entry-1',
    });
    expect(pending.kind).toBe('pending_action');
    expect(audit.relationships).toContainEqual({
      type: 'RECORDED_IN',
      fromKind: 'PendingAction',
      fromId: 'action-1',
      toKind: 'AuditEvent',
      toId: 'audit-1',
    });
  });

  it('never invents a stock cause or carries customer PII/freeform notes', () => {
    const movement: GraphEvent = {
      type: 'stock_movement',
      storeId: '42',
      id: 'move-2',
      productId: 'product-1',
      kind: 'receive',
      qtyBaseDelta: 500,
      billId: null,
      createdAt: at.toISOString(),
    };
    const mapped = mapGraphEvent(movement);
    expect(mapped.relationships).toEqual([
      {
        type: 'OF',
        fromKind: 'StockMovement',
        fromId: 'move-2',
        toKind: 'Product',
        toId: 'product-1',
      },
    ]);
    expect(JSON.stringify(mapped)).not.toMatch(/phone|customerName|note|paymentRef/i);
  });
});
