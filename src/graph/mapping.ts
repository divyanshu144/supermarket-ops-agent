export type GraphEvent =
  | {
      type: 'store';
      storeId: string;
      id: string;
      name: string;
      gstin: string;
      stateCode: string;
      createdAt: string;
    }
  | {
      type: 'product';
      storeId: string;
      id: string;
      name: string;
      brand: string | null;
      packSize: string | null;
      unit: string;
      isLoose: boolean;
      hsnCode: string;
      gstRateBps: number;
      mrpPaise: number;
    }
  | {
      type: 'bill';
      storeId: string;
      id: string;
      status: string;
      invoiceNumber: string | null;
      totalPaise: number | null;
      createdAt: string;
      finalizedAt: string | null;
    }
  | {
      type: 'bill_item';
      storeId: string;
      id: string;
      billId: string;
      productId: string;
      lineNo: number;
      qtyBase: number;
      unitPricePaise: number;
      gstRateBps: number;
      hsnCode: string;
    }
  | {
      type: 'stock_movement';
      storeId: string;
      id: string;
      productId: string;
      kind: string;
      qtyBaseDelta: number;
      billId: string | null;
      createdAt: string;
    }
  | {
      type: 'khata_account';
      storeId: string;
      id: string;
      createdAt: string;
    }
  | {
      type: 'khata_entry';
      storeId: string;
      id: string;
      accountId: string;
      kind: string;
      amountPaise: number;
      billId: string | null;
      createdAt: string;
    }
  | {
      type: 'pending_action';
      storeId: string;
      id: string;
      tool: string;
      status: string;
      outcome: string | null;
      createdAt: string;
    }
  | {
      type: 'audit_event';
      storeId: string;
      id: string;
      action: string;
      tool: string;
      outcome: string;
      updateId: string;
      createdAt: string;
      pendingActionId: string | null;
    };

export interface GraphRelationship {
  type: 'OWNS' | 'CONTAINS' | 'OF' | 'CAUSED_BY' | 'HAS_ENTRY' | 'RECORDED_IN';
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  properties?: Record<string, string | number>;
}

export interface GraphMutation {
  kind: GraphEvent['type'];
  storeId: string;
  sourceId: string;
  properties: Record<string, string | number | boolean | null>;
  relationships: GraphRelationship[];
}

const mutation = (
  event: GraphEvent,
  properties: GraphMutation['properties'],
  relationships: GraphRelationship[] = [],
): GraphMutation => ({
  kind: event.type,
  storeId: event.storeId,
  sourceId: event.id,
  properties,
  relationships,
});

export function mapGraphEvent(event: GraphEvent): GraphMutation {
  switch (event.type) {
    case 'store':
      return mutation(event, {
        name: event.name,
        gstin: event.gstin,
        stateCode: event.stateCode,
        createdAt: event.createdAt,
      });
    case 'product':
      return mutation(event, {
        name: event.name,
        brand: event.brand,
        packSize: event.packSize,
        unit: event.unit,
        isLoose: event.isLoose,
        hsnCode: event.hsnCode,
        gstRateBps: event.gstRateBps,
        mrpPaise: event.mrpPaise,
      });
    case 'bill':
      return mutation(event, {
        status: event.status,
        invoiceNumber: event.invoiceNumber,
        totalPaise: event.totalPaise,
        createdAt: event.createdAt,
        finalizedAt: event.finalizedAt,
      });
    case 'bill_item':
      return mutation(
        event,
        {
          lineNo: event.lineNo,
          qtyBase: event.qtyBase,
          unitPricePaise: event.unitPricePaise,
          gstRateBps: event.gstRateBps,
          hsnCode: event.hsnCode,
        },
        [
          {
            type: 'CONTAINS',
            fromKind: 'Bill',
            fromId: event.billId,
            toKind: 'Product',
            toId: event.productId,
            properties: {
              qtyBase: event.qtyBase,
              unitPricePaise: event.unitPricePaise,
              gstRateBps: event.gstRateBps,
              lineNo: event.lineNo,
            },
          },
        ],
      );
    case 'stock_movement':
      return mutation(
        event,
        {
          kind: event.kind,
          qtyBaseDelta: event.qtyBaseDelta,
          createdAt: event.createdAt,
        },
        [
          {
            type: 'OF',
            fromKind: 'StockMovement',
            fromId: event.id,
            toKind: 'Product',
            toId: event.productId,
          },
          ...(event.billId
            ? [
                {
                  type: 'CAUSED_BY' as const,
                  fromKind: 'StockMovement',
                  fromId: event.id,
                  toKind: 'Bill',
                  toId: event.billId,
                },
              ]
            : []),
        ],
      );
    case 'khata_account':
      return mutation(event, { createdAt: event.createdAt });
    case 'khata_entry':
      return mutation(
        event,
        {
          kind: event.kind,
          amountPaise: event.amountPaise,
          createdAt: event.createdAt,
        },
        [
          {
            type: 'HAS_ENTRY',
            fromKind: 'KhataAccount',
            fromId: event.accountId,
            toKind: 'KhataEntry',
            toId: event.id,
          },
          ...(event.billId
            ? [
                {
                  type: 'CAUSED_BY' as const,
                  fromKind: 'KhataEntry',
                  fromId: event.id,
                  toKind: 'Bill',
                  toId: event.billId,
                },
              ]
            : []),
        ],
      );
    case 'pending_action':
      return mutation(event, {
        tool: event.tool,
        status: event.status,
        outcome: event.outcome,
        createdAt: event.createdAt,
      });
    case 'audit_event':
      return mutation(
        event,
        {
          action: event.action,
          tool: event.tool,
          outcome: event.outcome,
          updateId: event.updateId,
          createdAt: event.createdAt,
        },
        event.pendingActionId
          ? [
              {
                type: 'RECORDED_IN',
                fromKind: 'PendingAction',
                fromId: event.pendingActionId,
                toKind: 'AuditEvent',
                toId: event.id,
              },
            ]
          : [],
      );
  }
}
