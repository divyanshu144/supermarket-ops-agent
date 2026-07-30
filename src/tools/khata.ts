import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import {
  accountStatement,
  chargeAccount,
  findAccount,
  listAccounts,
  settleAccount,
} from '../repositories/khata.js';
import { requireContext } from './context.js';
import { toolResult } from './present.js';

export const getKhataBalanceTool = tool(
  'get_khata_balance',
  'Look up what a customer owes on the khata (credit book). Pass no name to list every ' +
    'account with an outstanding balance.',
  { customer: z.string().optional().describe('Customer name, full or partial.') },
  async ({ customer }) => {
    const { storeId } = requireContext();

    if (!customer) {
      const accounts = await listAccounts(storeId);
      return toolResult({
        status: 'listed',
        accounts: accounts.map((a) => ({ name: a.customerName, balance: a.balance })),
      });
    }

    const found = await findAccount(storeId, customer);
    if (found.status === 'found') {
      return toolResult({
        status: 'found',
        name: found.account.customerName,
        balance: found.account.balance,
      });
    }
    if (found.status === 'ambiguous') {
      return toolResult({
        status: 'ambiguous',
        message: 'Several customers match. Ask which one.',
        candidates: found.candidates,
      });
    }
    return toolResult({
      status: 'not_found',
      query: found.query,
      message: 'No khata account by that name. Do not invent a balance.',
    });
  },
);

export const chargeKhataTool = tool(
  'charge_khata',
  'Put an amount on a customer\'s credit, e.g. "put ₹500 on Ramesh\'s credit". If the name is ' +
    'new the account is opened automatically — that is how a kirana works. To bill goods to ' +
    'credit, prefer finalize_bill with payment_mode "khata" so stock and credit move together.',
  {
    customer_name: z.string().min(1),
    amount_paise: z.number().int().positive().describe('Amount in PAISE. ₹500 is 50000.'),
    note: z.string().optional(),
  },
  async ({ customer_name, amount_paise, note }) => {
    const { storeId } = requireContext();
    const result = await chargeAccount(storeId, {
      customerName: customer_name,
      amountPaise: amount_paise,
      note,
    });
    return toolResult({
      status: result.status,
      customer: result.customerName,
      amount: result.amount,
      new_balance: result.newBalance,
      account_opened: result.accountOpened,
    });
  },
);

export const settleKhataTool = tool(
  'settle_khata',
  'Record a payment against a customer\'s credit, e.g. "Ramesh paid ₹300". Refuses an unknown ' +
    'customer, and refuses to take more than the outstanding balance unless the owner confirms.',
  {
    customer: z.string().min(1),
    amount_paise: z.number().int().positive().describe('Amount in PAISE.'),
    note: z.string().optional(),
    allow_overpay: z
      .boolean()
      .optional()
      .describe('Only after the owner has confirmed paying more than the balance.'),
  },
  async ({ customer, amount_paise, note, allow_overpay }) => {
    const { storeId } = requireContext();
    const result = await settleAccount(storeId, {
      customerQuery: customer,
      amountPaise: amount_paise,
      note,
      allowOverpay: allow_overpay,
    });

    if (result.status === 'unknown_customer') {
      return toolResult({
        status: 'unknown_customer',
        query: result.query,
        message:
          'No khata account by that name. Do not open one to take a payment — check the name with the owner.',
      });
    }
    if (result.status === 'exceeds_balance') {
      return toolResult({
        status: 'exceeds_balance',
        message: `${result.customerName} owes only ${result.balance}. Confirm with the owner before taking ${result.offered}.`,
        balance: result.balance,
        offered: result.offered,
      });
    }
    return toolResult(result);
  },
);

export const khataStatementTool = tool(
  'khata_statement',
  "Show a customer's recent credit history, newest first.",
  { customer: z.string().min(1), limit: z.number().int().positive().max(50).optional() },
  async ({ customer, limit }) => {
    const { storeId } = requireContext();
    return toolResult(await accountStatement(storeId, { customerQuery: customer, limit }));
  },
);

export const KHATA_TOOLS = [
  getKhataBalanceTool,
  chargeKhataTool,
  settleKhataTool,
  khataStatementTool,
];

export const KHATA_TOOL_NAMES = [
  'get_khata_balance',
  'charge_khata',
  'settle_khata',
  'khata_statement',
] as const;
